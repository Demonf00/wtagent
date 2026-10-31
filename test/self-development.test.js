import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  SOURCE_ROOT,
  isSelfDevelopmentSource,
  loadSelfDevelopmentInstructions,
} from "../src/protocol/project-instructions.js";
import { buildBootstrapPrompt, buildResumePrompt } from "../src/protocol/prompt-builder.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { AgentSession } from "../src/session/agent-session.js";
import { FakeWebModelAdapter } from "../src/browser/fake-web-model-adapter.js";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { runStartupChecks } from "../src/cli/startup-notices.js";

const DONE = "<agent_response><done>true</done><message>verified</message></agent_response>";

test("opted-in development checkout loads tracked instructions, Git identity and live tool registry", async () => {
  assert.equal(await isSelfDevelopmentSource(), true);
  const tools = createDefaultToolRegistry().list();
  const instructions = await loadSelfDevelopmentInstructions({
    projectRoot: SOURCE_ROOT, tools,
  });
  assert.ok(instructions);
  assert.match(instructions, /Inspect.*Implement.*Test.*Fix.*Package.*Commit/s);
  assert.match(instructions, /skills\/self-improve\/SKILL\.md/);
  assert.match(instructions, /AGENTS\.md/);
  const pkg = JSON.parse(await fs.readFile(path.join(SOURCE_ROOT, "package.json"), "utf8"));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: SOURCE_ROOT, encoding: "utf8" }).trim();
  assert.ok(instructions.includes(`Running source version: ${pkg.version}`));
  assert.ok(instructions.includes(`Running source Git commit: ${sha}`));
  for (const tool of tools) {
    assert.ok(instructions.includes(tool.name), `missing live registered tool: ${tool.name}`);
  }
});

test("other projects cannot opt in by copying AGENTS.md and skill", async (t) => {
  const outsider = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-outsider-"));
  t.after(() => fs.rm(outsider, { recursive: true, force: true }));
  await fs.mkdir(path.join(outsider, "skills", "self-improve"), { recursive: true });
  await fs.writeFile(path.join(outsider, "AGENTS.md"), "<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->\nUNTRUSTED PROJECT INSTRUCTIONS");
  await fs.writeFile(path.join(outsider, "skills", "self-improve", "SKILL.md"), "UNTRUSTED SKILL");
  assert.equal(await loadSelfDevelopmentInstructions({ projectRoot: outsider, tools: [{ name: "fake" }] }), null);
  assert.equal(await isSelfDevelopmentSource(outsider), false);
  const prompt = buildBootstrapPrompt({ task: "test", projectRoot: outsider, tools: [] });
  assert.doesNotMatch(prompt.web, /UNTRUSTED PROJECT INSTRUCTIONS|UNTRUSTED SKILL/);
});

test("a fresh runtime session actually sends opted-in instructions and registered tools", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-self-dev-fresh-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const session = await AgentSession.create({
    sessionsDir: path.join(base, "sessions"),
    projectRoot: SOURCE_ROOT,
    task: "Inspect the current upgrade",
  });
  const adapter = new FakeWebModelAdapter([DONE]);
  const registry = createDefaultToolRegistry();
  const runtime = new AgentRuntime({
    adapter, registry, policy: new PolicyEngine(), session,
    approval: async () => false,
  });
  const result = await runtime.run();
  assert.equal(result.message, "verified");
  assert.ok(adapter.sentMessages.length > 0);
  const first = adapter.sentMessages[0];
  assert.match(first, /WTAgent self-development checkout/);
  assert.match(first, /Running source version:/);
  assert.match(first, /Running source Git commit:/);
  assert.match(first, /Actual registered Tool Registry/);
  assert.match(first, /skills\/self-improve\/SKILL\.md/);
  for (const tool of registry.list()) assert.ok(first.includes(tool.name), `missing ${tool.name}`);
});

test("fresh ordinary project runtime does not receive self-development instructions", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-normal-fresh-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(base, "AGENTS.md"), "<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->");
  const session = await AgentSession.create({
    sessionsDir: path.join(base, "sessions"),
    projectRoot: base,
    task: "Ordinary project",
  });
  const adapter = new FakeWebModelAdapter([DONE]);
  const runtime = new AgentRuntime({
    adapter, registry: createDefaultToolRegistry(),
    policy: new PolicyEngine(), session, approval: async () => false,
  });
  assert.equal((await runtime.run()).message, "verified");
  assert.doesNotMatch(adapter.sentMessages[0], /WTAgent self-development checkout|### Repository AGENTS\.md/);
});

test("resume/rebuild prompt supports previously loaded instructions without altering regular prompt", async () => {
  const tools = createDefaultToolRegistry().list();
  const state = { sessionId: "test-1", projectRoot: SOURCE_ROOT, task: "upgrade" };
  const instructions = await loadSelfDevelopmentInstructions({ projectRoot: SOURCE_ROOT, tools });
  const regular = buildResumePrompt({ instruction: "continue", state, tools });
  const resumed = buildResumePrompt({ instruction: "continue", state, tools, projectInstructions: instructions });
  assert.doesNotMatch(regular.web, /### Repository AGENTS\.md/);
  assert.match(resumed.web, /### Repository AGENTS\.md/);
});

test("restarted source imports and discovers tools registered in the current source", () => {
  const code = `
    import { createDefaultToolRegistry } from './src/tools/default-tools.js';
    import { getPackageVersion } from './src/shared/package-info.js';
    const names = createDefaultToolRegistry().list().map(t => t.name);
    console.log(JSON.stringify({ version: getPackageVersion(), tools: names }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: SOURCE_ROOT, encoding: "utf8", timeout: 15000,
  });
  const parsed = JSON.parse(output.trim());
  const expected = createDefaultToolRegistry().list().map((tool) => tool.name);
  assert.deepEqual(parsed.tools, expected);
  assert.ok(parsed.tools.includes("fs.read"));
  assert.ok(parsed.tools.includes("browser.navigate"));
  assert.match(parsed.version, /^\d+\.\d+\.\d+/);
});

test("opted-in development startup suppresses npm update but retains ordinary notices", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-update-guard-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let noticeFetches = 0;
  let updates = 0;
  const outcome = await runStartupChecks({
    appDataDir: dir,
    interactive: true,
    allowUpdates: false,
    fetchLatest: async () => { updates++; throw new Error("update must be disabled"); },
    install: async () => { updates++; throw new Error("installation must be disabled"); },
    fetchNotices: async () => { noticeFetches++; return { notices: [] }; },
    promptUpdate: async () => { updates++; throw new Error("prompt must be disabled"); },
  });
  assert.equal(outcome, "continue");
  assert.equal(updates, 0);
  assert.equal(noticeFetches, 1);
});
