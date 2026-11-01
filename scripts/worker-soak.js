/**
 * RR-03: bounded mocked-browser runtime soak with real child-process exits.
 * This is NOT a live ChatGPT/Chrome smoke test.
 *
 * Usage: node scripts/worker-soak.js [--cycles=60] [--report=path]
 * Stages are private to this script; never use them against user workspaces.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { FakeWebModelAdapter } from "../src/browser/fake-web-model-adapter.js";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { TaskSession } from "../src/session/task-session.js";

const SCRIPT = fileURLToPath(import.meta.url);
const PHASE_EXIT = { crash: 73, transport: 74 };
const TOOL_NAME = "fs.write";

function optionsOf(argv) {
  const values = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!match) throw new Error("Invalid soak option.");
    values[match[1]] = match[2];
  }
  const cycles = values.cycles == null ? 60 : Number(values.cycles);
  if (!Number.isSafeInteger(cycles) || cycles < 50 || cycles > 200) {
    throw new Error("Soak cycles must be an integer between 50 and 200.");
  }
  const crashAt = Math.floor(cycles / 3);
  const transportAt = Math.floor(cycles * 2 / 3);
  return { ...values, cycles, crashAt, transportAt };
}

function toolProposal(index) {
  const n = String(index).padStart(3, "0");
  return `<agent_response><done>false</done><tool_call name="${TOOL_NAME}"><args><path>cycle-${n}.txt</path><content>cycle-${n}</content></args></tool_call></agent_response>`;
}
const doneResponse = "<agent_response><done>true</done><message>Soak complete.</message></agent_response>";

function reconciliation(handoff) {
  assert.ok(handoff, "recovery requires a committed handoff");
  return {
    status: handoff.status,
    conversationUrl: handoff.conversationUrl,
    conversationTargetId: handoff.conversationTargetId,
    userMessageId: handoff.userMessageId,
    userTurn: handoff.userTurn,
    preOutboundMarkerIds: handoff.preOutboundMarkerIds ?? [],
    assistantBaseline: handoff.assistantBaseline ?? null,
    assistantCandidateMessageId:
      handoff.assistantCandidateMessageId ?? handoff.assistantMessageId ?? null,
    assistantCandidateTurn:
      handoff.assistantCandidateTurn ?? handoff.assistantTurn ?? null,
    ...(handoff.status === "complete" ? {
      assistantMessageId: handoff.assistantMessageId,
      assistantTurn: handoff.assistantTurn,
      rawResponse: handoff.rawResponse,
      responseHash: handoff.responseHash,
    } : {}),
  };
}

async function stage({ stage, root, cycles, crashAt, transportAt }) {
  if (!["crash", "transport", "finish"].includes(stage)) {
    throw new Error("Unknown soak stage.");
  }
  const sessionsDir = path.join(root, "sessions");
  const projectRoot = path.join(root, "workspace");
  const idFile = path.join(root, "session-id");
  const session = stage === "crash"
    ? await TaskSession.create({
      sessionsDir, projectRoot, task: "RR-03 isolated mocked-browser soak", mode: null,
    })
    : await TaskSession.load({
      sessionsDir, taskId: await fs.readFile(idFile, "utf8"),
    });
  if (stage === "crash") await fs.writeFile(idFile, session.taskId);
  const from = stage === "crash" ? 1
    : stage === "transport" ? crashAt
      : transportAt;
  const responses = Array.from(
    { length: cycles - from + 1 },
    (_, i) => toolProposal(from + i),
  ).concat(doneResponse);
  class FaultAdapter extends FakeWebModelAdapter {
    constructor() {
      super(responses);
      this.waitCount = 0;
      this.toolResultSendCount = 0;
    }
    async waitForTurnComplete(args) {
      this.waitCount++;
      // The crash follows an acknowledged tool result, at the next wait
      // boundary. The handoff is durable before the child actually exits.
      if (stage === "crash" && this.waitCount === crashAt + 1) {
        process.exit(PHASE_EXIT.crash);
      }
      return super.waitForTurnComplete(args);
    }
    async sendMessage(message, options) {
      if (stage === "transport" && message.includes('<tool_result name="fs.write"')) {
        this.toolResultSendCount++;
        // The first tool result after restart is the duplicated last tool.
        // Then crash before transmitting the result for transportAt.
        if (this.toolResultSendCount === transportAt - crashAt + 1) {
          this.lastSendStatus = "not-submitted";
          throw new Error("INJECTED_TRANSPORT_FAILURE");
        }
      }
      return super.sendMessage(message, options);
    }
  }
  const adapter = new FaultAdapter();
  if (stage !== "crash") {
    // The first response after restart deliberately replays the previous
    // assistant proposal. Preserve its original identity, then advance
    // monotonically so later proposals are not mistaken for earlier calls.
    adapter.responseNumber = from - 1;
    adapter.lastAssistantMessageId = `assistant-${from - 1}`;
    adapter.lastAssistantTurn = (from - 1) * 2;
    const handoff = session.state.pendingAssistantTurn;
    assert.ok(handoff, "recovery must find persisted assistant boundary");
    adapter.conversationUrl = handoff.conversationUrl;
    adapter.targetId = handoff.conversationTargetId;
    adapter.reconciliationOutcome = reconciliation(handoff);
  }
  const registry = createDefaultToolRegistry();
  const execute = registry.execute.bind(registry);
  registry.execute = async (...args) => {
    if (args[0]?.name === TOOL_NAME) {
      const target = String(args[0]?.args?.path ?? "");
      if (!/^cycle-[0-9]{3}\.txt$/.test(target)) {
        throw new Error("Unexpected tool execution target.");
      }
      await fs.appendFile(path.join(root, "execution-journal.jsonl"),
        `${JSON.stringify({ target })}\n`);
    }
    return execute(...args);
  };
  const events = [];
  const runtime = new AgentRuntime({
    adapter, registry, policy: new PolicyEngine(), session,
    approval: async () => false,
    onEvent: async event => {
      if (event.type === "tool.reused") {
        events.push({ type: "tool.reused" });
        await fs.appendFile(path.join(root, "reuse-journal.jsonl"),
          `${JSON.stringify({ type: "tool.reused" })}\n`);
      }
    },
  });
  try {
    const result = await runtime.run(stage === "crash" ? {} : { resume: true });
    assert.equal(stage, "finish", "earlier stages should inject failures");
    assert.equal(result.message, "Soak complete.");
    await fs.writeFile(path.join(root, "completed"), "yes");
  } catch (error) {
    if (stage === "transport" && error?.message === "INJECTED_TRANSPORT_FAILURE") {
      assert.ok(session.state.pendingToolResult, "the tool result must be durable");
      assert.equal(session.state.pendingOutbound, null,
        "confirmed not-submitted result must not leave ambiguous outbound");
      process.exit(PHASE_EXIT.transport);
    }
    throw error;
  }
}

async function orchestrate({ cycles, crashAt, transportAt, report: reportPath }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-soak-"));
  const results = [];
  try {
    await fs.mkdir(path.join(root, "workspace"));
    await fs.mkdir(path.join(root, "sessions"));
    for (const name of ["crash", "transport", "finish"]) {
      const run = spawnSync(process.execPath, [
        SCRIPT, `--stage=${name}`, `--root=${root}`, `--cycles=${cycles}`,
      ], { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
      const expectedExit = PHASE_EXIT[name] ?? 0;
      let journalCount = 0;
      let recentTargets = [];
      try {
        const entries = (await fs.readFile(path.join(root, "execution-journal.jsonl"), "utf8"))
          .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        journalCount = entries.length;
        recentTargets = entries.slice(-5).map(item => item.target);
      } catch {}
      results.push({
        stage: name, exitCode: run.status, expectedExit,
        journalCount, recentTargets,
      });
      console.error("RR03_STAGE", JSON.stringify(results.at(-1)));
      if (run.error || run.status !== expectedExit) {
        throw new Error(
          `Soak stage ${name} failed: expected exit ${expectedExit}, actual ${run.status}, `
          + `signal ${run.signal ?? "none"}. ${String(run.stderr ?? "").slice(-1200)}`,
        );
      }
    }
    const lines = (await fs.readFile(path.join(root, "execution-journal.jsonl"), "utf8"))
      .trim().split(/\r?\n/).map(line => JSON.parse(line));
    const counts = new Map();
    for (const entry of lines) counts.set(entry.target, (counts.get(entry.target) ?? 0) + 1);
    const duplicated = [...counts].filter(([, count]) => count !== 1);
    console.error("RR03_JOURNAL", JSON.stringify({
      total: lines.length,
      distinct: counts.size,
      first: lines.slice(0, 4).map(item => item.target),
      last: lines.slice(-8).map(item => item.target),
      repeats: duplicated.slice(0, 5),
    }));
    assert.equal(lines.length, cycles, "exact tool execution count");
    assert.equal(counts.size, cycles, "unique tool execution count");
    assert.deepEqual(duplicated, [], "no repeated side effects");
    for (let i = 1; i <= cycles; i++) {
      const n = String(i).padStart(3, "0");
      assert.equal(
        await fs.readFile(path.join(root, "workspace", `cycle-${n}.txt`), "utf8"),
        `cycle-${n}`,
      );
    }
    assert.equal(await fs.readFile(path.join(root, "completed"), "utf8"), "yes");
    const reused = (await fs.readFile(path.join(root, "reuse-journal.jsonl"), "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).length;
    assert.ok(reused >= 2, "both injected boundaries must reuse the prior tool result");
    const report = {
      schema: 1,
      suite: "RR-03-WINDOWS-WORKER-SOAK",
      evidence: {
        provider: "mocked-browser",
        runtime: "real-AgentRuntime",
        tools: "real-fs.write-in-isolated-workspace",
        processExit: "real-node-child-exit",
        liveBrowserSmoke: "NOT_RUN",
      },
      cyclesRequested: cycles,
      toolExecutions: lines.length,
      distinctSideEffects: counts.size,
      duplicatedSideEffects: duplicated.length,
      reusedToolResults: reused,
      faultInjection: {
        processCrashAfterCycle: crashAt,
        droppedToolResultAtCycle: transportAt,
        stages: results,
      },
      status: "passed",
    };
    if (reportPath) await fs.writeFile(path.resolve(reportPath),
      `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const options = optionsOf(process.argv.slice(2));
if (options.stage) {
  if (!options.root || !path.isAbsolute(options.root)) {
    throw new Error("Child stages require an absolute isolated root.");
  }
  await stage(options);
} else {
  await orchestrate(options);
}
