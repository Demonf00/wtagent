
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskSupervisor } from "../src/supervisor/task-supervisor.js";
import { runAutonomyCommand } from "../src/cli/autonomy-command.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-autonomy-cli-"));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot);
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    workspaceRoot,
    planFile: path.join(root, "plan.json"),
    stateFile: path.join(root, "checkpoint.json"),
    options: { project: workspaceRoot, home: path.join(root, "appdata") },
  };
}

function plan() {
  return {
    goal: "Produce and verify three dependent artifacts",
    tasks: ["one", "two", "three"].map((name, index, names) => ({
      id: name, instruction: `produce ${name}`,
      dependsOn: index === 0 ? [] : [names[index - 1]],
      acceptance: [{ kind: "file", path: `${name}.txt` }],
    })),
  };
}

test("P2 autonomy CLI start, resume and status use persistent real Supervisor state", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.planFile, JSON.stringify(plan()));
  const executions = [];
  const output = [];
  const createSupervisor = (config) => new TaskSupervisor({
    ...config,
    execute: async ({ session }) => {
      const match = /^produce (one|two|three)$/.exec(session.state.task);
      assert.ok(match, "unexpected task instruction");
      executions.push(match[1]);
      await fs.writeFile(path.join(f.workspaceRoot, `${match[1]}.txt`), `artifact-${match[1]}`);
      return { message: "completed" };
    },
  });
  const options = {
    ...f, createSupervisor, output: (message) => output.push(message),
    timeoutMs: 10000, pollMs: 5,
  };
  const first = await runAutonomyCommand({ ...options, action: "start" });
  assert.equal(first.status, "VERIFIED");
  assert.deepEqual(executions, ["one", "two", "three"]);
  assert.deepEqual(first.tasks.map((task) => task.status), ["VERIFIED", "VERIFIED", "VERIFIED"]);
  assert.equal(await fs.stat(f.stateFile).then((stat) => stat.isFile()), true);
  await assert.rejects(fs.access(`${f.stateFile}.lock`), { code: "ENOENT" });

  const resumed = await runAutonomyCommand({ ...options, action: "resume" });
  assert.equal(resumed.status, "VERIFIED");
  assert.deepEqual(executions, ["one", "two", "three"]);
  const summary = await runAutonomyCommand({ ...options, action: "status" });
  assert.equal(summary.status, "VERIFIED");
  assert.equal(summary.tasks.length, 3);
  assert.ok(output.some((item) => item.includes("[Autonomy] VERIFIED")));
  assert.ok(output.some((item) => item.includes("Goal Delivery: UNVERIFIED")));
  assert.equal(summary.delivery.status, "UNVERIFIED");
  assert.equal(summary.delivery.requiredFinalChecks, 0);
  assert.equal(summary.delivery.evidencedFinalChecks, 0);
  assert.equal(summary.delivery.evidenceFreshness, "checkpoint_snapshot_not_revalidated");

  const entry = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
  const processResult = spawnSync(process.execPath, [
    entry, "-C", f.workspaceRoot, "autonomy", "status", "--state", f.stateFile,
  ], { encoding: "utf8", timeout: 15000 });
  assert.equal(processResult.status, 0, processResult.stderr);
  const fromCli = JSON.parse(processResult.stdout);
  assert.equal(fromCli.status, "VERIFIED");
  assert.deepEqual(fromCli.tasks.map((item) => item.status), ["VERIFIED", "VERIFIED", "VERIFIED"]);
  assert.equal(fromCli.delivery.status, "UNVERIFIED");
  assert.equal(fromCli.delivery.unverifiedCapabilities.length, 1);
});

test("P2 autonomy CLI blocks missing artifacts without executing dependent tasks", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.planFile, JSON.stringify(plan()));
  const executions = [];
  const state = await runAutonomyCommand({
    ...f, action: "start",
    timeoutMs: 10000, pollMs: 5, output: () => {},
    createSupervisor: (config) => new TaskSupervisor({
      ...config,
      execute: async ({ session }) => {
        executions.push(session.state.task);
        return { message: "claimed completed, but no file" };
      },
    }),
  });
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.tasks[0].status, "BLOCKED");
  assert.deepEqual(executions, ["produce one"]);
});

test("P2 autonomy CLI refuses unsafe plan reuse and validates missing --state", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.planFile, JSON.stringify(plan()));
  const supervisorFactory = (config) => new TaskSupervisor({
    ...config, autoRun: false,
    execute: async () => ({ message: "not executed" }),
  });
  const options = {
    ...f, createSupervisor: supervisorFactory, output: () => {},
    timeoutMs: 40, pollMs: 5,
  };
  const state = await runAutonomyCommand({ ...options, action: "start" });
  assert.equal(state.status, "RUNNING");
  await assert.rejects(
    runAutonomyCommand({ ...options, action: "start" }),
    { code: "STATE_EXISTS" },
  );
  await assert.rejects(fs.access(`${f.stateFile}.lock`), { code: "ENOENT" });
  const entry = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
  const result = spawnSync(process.execPath, [
    entry, "autonomy", "resume",
  ], { encoding: "utf8", timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required option.*--state/i);
});

test("P2 autonomy CLI resumes the same Supervisor task after budget-driven pause", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.planFile, JSON.stringify({
    goal: "Complete a long task after a process restart",
    tasks: [{
      id: "long", instruction: "produce long",
      dependsOn: [],
      acceptance: [{ kind: "file", path: "long.txt" }],
    }],
  }));
  const executions = [];
  const createSupervisor = (config) => new TaskSupervisor({
    ...config,
    execute: async ({ session, control }) => {
      executions.push(session.state.task);
      if (executions.length === 1) {
        // First CLI budget expires while the original Worker is active.
        // close() requests pause; checkpoint must honor that request.
        await new Promise((resolve) => setTimeout(resolve, 150));
        control.checkpoint();
        throw new Error("First execution should have paused");
      }
      await fs.writeFile(path.join(f.workspaceRoot, "long.txt"), "completed-after-resume");
      return { message: "completed after resume" };
    },
  });
  const shared = {
    ...f, createSupervisor, output: () => {}, pollMs: 5,
  };
  const first = await runAutonomyCommand({
    ...shared, action: "start", timeoutMs: 50,
  });
  assert.equal(first.status, "RUNNING");
  assert.equal(first.tasks[0].status, "RUNNING");
  assert.ok(first.tasks[0].supervisorTaskId);
  const originalTaskId = first.tasks[0].supervisorTaskId;

  // The first Supervisor has been closed; its durable record must be paused.
  const recordPath = path.join(
    `${f.stateFile}.supervisor`, `${originalTaskId}.json`,
  );
  const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
  assert.equal(record.status, "paused");
  await assert.rejects(fs.access(`${f.stateFile}.lock`), { code: "ENOENT" });

  const resumed = await runAutonomyCommand({
    ...shared, action: "resume", timeoutMs: 3000,
  });
  assert.equal(resumed.status, "VERIFIED");
  assert.equal(resumed.tasks[0].supervisorTaskId, originalTaskId);
  assert.deepEqual(executions, ["produce long", "produce long"]);
  assert.equal(await fs.readFile(path.join(f.workspaceRoot, "long.txt"), "utf8"),
    "completed-after-resume");
  const taskFiles = (await fs.readdir(`${f.stateFile}.supervisor`))
    .filter((name) => /^task_.*\.json$/.test(name));
  assert.deepEqual(taskFiles, [`${originalTaskId}.json`]);
});
