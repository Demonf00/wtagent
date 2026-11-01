
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskSupervisor } from "../src/supervisor/task-supervisor.js";
import { runAutonomyCommand } from "../src/cli/autonomy-command.js";
import { resolveRuntimePaths } from "../src/runtime/conversation-runner.js";
import { AgentSession } from "../src/session/agent-session.js";
import { TaskCoordinator } from "../src/autonomy/task-coordinator.js";

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


test("CM-03 actual autonomy resume continues dependent tasks only after valid conversation handoff",async t=>{
  const f=await fixture(t);
  function git(...args){
    const result=spawnSync("git",args,{
      cwd:f.workspaceRoot,encoding:"utf8",timeout:15000,
    });
    assert.equal(result.status,0,result.stderr);
    return result.stdout.trim();
  }
  git("init","-q");
  git("config","user.name","CM-03 Integration");
  git("config","user.email","cm03@example.invalid");
  git("commit","-q","--allow-empty","-m","Initial checkpoint");
  const records=new Map(),firstExecutions=[];
  const initialSupervisor={
    async create({workspaceId,instruction,idempotencyKey}){
      const taskId="task_01234567-89ab-cdef-0123-456789abcdef";
      firstExecutions.push(instruction);
      await fs.writeFile(path.join(f.workspaceRoot,"one.txt"),"verified first");
      records.set(taskId,{
        taskId,workspaceId,workspaceRoot:f.workspaceRoot,
        instruction,idempotencyKey,status:"completed",
      });
      return {taskId};
    },
    get(taskId){return {...records.get(taskId)};},
  };
  const coordinator=await TaskCoordinator.create({
    stateFile:f.stateFile,workspaceRoot:f.workspaceRoot,
    workspaceId:"main",supervisor:initialSupervisor,plan:plan(),
  });
  const first=await coordinator.tick();
  assert.equal(first.tasks[0].status,"VERIFIED");
  assert.deepEqual(first.tasks.slice(1).map(x=>x.status),["TODO","TODO"]);
  assert.deepEqual(firstExecutions,["produce one"]);
  git("add","one.txt");
  git("commit","-q","-m","Verified one");

  const sessionsDir=resolveRuntimePaths(f.options).sessionsDir;
  const parent=await AgentSession.create({
    sessionsDir,projectRoot:f.workspaceRoot,task:"Produce three artifacts",
  });
  const child=await AgentSession.create({
    sessionsDir,projectRoot:f.workspaceRoot,task:"Safe resumed work",
  });
  await parent.update({automaticContextRotation:{
    schema:1,status:"ROTATED",nextSessionId:child.sessionId,
  }});
  await child.update({
    previousContextSessionId:parent.sessionId,
    rootContextGoal:"Produce three artifacts",contextGeneration:1,
  });
  const forged=await AgentSession.create({
    sessionsDir,projectRoot:f.workspaceRoot,task:"Unrelated replacement",
  });
  await forged.update({previousContextSessionId:parent.sessionId});
  const executed=[];
  const createSupervisor=config=>new TaskSupervisor({
    ...config,
    execute:async({session})=>{
      const found=/^produce (two|three)$/.exec(session.state.task);
      assert.ok(found,"Verified task one must never be replayed");
      executed.push(found[1]);
      await fs.writeFile(path.join(f.workspaceRoot,found[1]+".txt"),
        "verified "+found[1]);
      return {message:"finished"};
    },
  });
  const args={
    ...f,action:"resume",createSupervisor,
    output:()=>{},timeoutMs:20000,pollMs:5,
  };
  await assert.rejects(runAutonomyCommand({
    ...args,conversationSessionId:forged.sessionId,
  }),{code:"CONTEXT_PLAN_RESUME_UNSAFE"});
  assert.deepEqual(executed,[]);
  // A freshly verified Worker may leave its artifact uncommitted. A safe
  // cross-conversation resume must stop rather than start the next task in a
  // dirty workspace or silently commit changes on the user's behalf.
  const paused=await runAutonomyCommand({
    ...args,conversationSessionId:child.sessionId,
  });
  assert.equal(paused.status,"BLOCKED");
  assert.equal(paused.lastError,"CONTEXT_PLAN_RESUME_BLOCKED");
  assert.deepEqual(paused.tasks.map(task=>task.status),
    ["VERIFIED","VERIFIED","TODO"]);
  assert.deepEqual(executed,["two"]);
  git("add","two.txt");
  git("commit","-q","-m","Independently verified two");
  const result=await runAutonomyCommand({
    ...args,conversationSessionId:child.sessionId,
  });
  assert.equal(result.status,"BLOCKED");
  assert.equal(result.lastError,"CONTEXT_PLAN_RESUME_BLOCKED");
  assert.deepEqual(result.tasks.map(task=>task.status),
    ["VERIFIED","VERIFIED","VERIFIED"]);
  assert.deepEqual(executed,["two","three"]);
  git("add","three.txt");
  git("commit","-q","-m","Independently verified three");
  const finished=await runAutonomyCommand({
    ...args,conversationSessionId:child.sessionId,
  });
  assert.equal(finished.status,"VERIFIED");
  assert.deepEqual(finished.tasks.map(task=>task.status),
    ["VERIFIED","VERIFIED","VERIFIED"]);
  assert.deepEqual(executed,["two","three"]);
  assert.deepEqual(firstExecutions,["produce one"]);
  const entry=fileURLToPath(new URL("../src/cli/main.js",import.meta.url));
  const help=spawnSync(process.execPath,[entry,"autonomy","resume","--help"],{
    cwd:f.workspaceRoot,encoding:"utf8",timeout:15000,
  });
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/--conversation-session/);
});
