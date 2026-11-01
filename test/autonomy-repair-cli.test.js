
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskSupervisor } from "../src/supervisor/task-supervisor.js";
import { runAutonomyCommand } from "../src/cli/autonomy-command.js";

async function fixture(t, repairProducesArtifact = true) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-repair-cli-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  await fs.mkdir(workspaceRoot);
  const stateFile = path.join(base, "state.json");
  const planFile = path.join(base, "plan.json");
  await fs.writeFile(planFile, JSON.stringify({
    goal: "Repair the expected file without claiming unverified success",
    tasks: [{
      id: "target",
      instruction: "initial output deliberately missing",
      dependsOn: [],
      acceptance: [{ kind: "file", path: "result.txt", minBytes: 4 }],
    }],
  }));
  const executed = [];
  const output = [];
  const createSupervisor = config => new TaskSupervisor({
    ...config,
    execute: async ({ session }) => {
      const task = session.state.task;
      executed.push(task);
      if (task.startsWith("Repair the output of existing task") && repairProducesArtifact) {
        await fs.writeFile(path.join(workspaceRoot, "result.txt"), "repaired-by-cli");
      }
      return { message: "worker response is not verification evidence" };
    },
  });
  const common = {
    stateFile, planFile,
    options: { project: workspaceRoot, home: path.join(base, "appdata") },
    createSupervisor, output: value => output.push(String(value)),
    timeoutMs: 8000, pollMs: 5,
  };
  return { common, stateFile, workspaceRoot, executed, output };
}

test("FR-04 CLI repair must be explicit; resume never creates a new repair attempt", async t => {
  const f = await fixture(t);
  const blocked = await runAutonomyCommand({ ...f.common, action: "start" });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.lastError, "ARTIFACT_MISSING");
  assert.equal(f.executed.length, 1);

  const resumed = await runAutonomyCommand({ ...f.common, action: "resume" });
  assert.equal(resumed.status, "BLOCKED");
  assert.equal(resumed.repairBudget.attempts.length, 0);
  assert.equal(f.executed.length, 1);

  const done = await runAutonomyCommand({ ...f.common, action: "repair" });
  assert.equal(done.status, "VERIFIED");
  assert.equal(done.tasks[0].status, "VERIFIED");
  assert.equal(done.repairBudget.attempts.length, 1);
  assert.equal(done.repairBudget.attempts[0].status, "SUCCEEDED");
  assert.equal(done.repairExecution, null);
  assert.equal(done.repairSubtask, null);
  assert.ok(done.tasks[0].verificationReceipt?.digest);
  assert.equal(f.executed.length, 2);
  assert.equal(await fs.readFile(path.join(f.workspaceRoot, "result.txt"), "utf8"),
    "repaired-by-cli");

  const again = await runAutonomyCommand({ ...f.common, action: "resume" });
  assert.equal(again.status, "VERIFIED");
  assert.equal(f.executed.length, 2);
  assert.equal(again.repairBudget.attempts.length, 1);
  await assert.rejects(fs.access(f.stateFile + ".lock"), { code: "ENOENT" });
});

test("FR-04 CLI never marks Supervisor response as successful artifact repair", async t => {
  const f = await fixture(t, false);
  const blocked = await runAutonomyCommand({ ...f.common, action: "start" });
  assert.equal(blocked.status, "BLOCKED");
  const repair = await runAutonomyCommand({ ...f.common, action: "repair" });
  assert.equal(repair.status, "BLOCKED");
  assert.equal(repair.lastError, "ARTIFACT_MISSING");
  assert.equal(repair.tasks[0].status, "BLOCKED");
  assert.equal(repair.tasks[0].verificationReceipt, null);
  assert.equal(repair.repairBudget.attempts.at(-1).status, "FAILED");
  assert.equal(f.executed.length, 2);
  const ordinaryResume = await runAutonomyCommand({ ...f.common, action: "resume" });
  assert.equal(ordinaryResume.status, "BLOCKED");
  assert.equal(f.executed.length, 2);
});

test("FR-04 CLI rejects repair without an existing execution checkpoint", async t => {
  const f = await fixture(t);
  await assert.rejects(runAutonomyCommand({ ...f.common, action: "repair" }),
    { code: "AUTONOMY_STATE_NOT_FOUND" });
  assert.equal(f.executed.length, 0);
  await assert.rejects(fs.access(f.stateFile + ".lock"), { code: "ENOENT" });
});
