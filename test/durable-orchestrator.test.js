import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runAutonomyCommand } from "../src/cli/autonomy-command.js";
import { TaskSupervisor } from "../src/supervisor/task-supervisor.js";
import {
  runDurableOrchestrator, readDurableOrchestratorState,
} from "../src/autonomy/durable-orchestrator.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"wtagent-as01-"));
  const workspaceRoot = path.join(root,"workspace");
  await fs.mkdir(workspaceRoot);
  t.after(async()=>fs.rm(root,{recursive:true,force:true}));
  return {
    root,workspaceRoot,stateFile:path.join(root,"checkpoint.json"),
    planFile:path.join(root,"plan.json"),
  };
}

test("AS-01 exits after a bounded slice and resumes from durable checkpoint",async t=>{
  const f=await fixture(t);
  const calls=[];
  const runSlice=async ({action,stateFile})=>{
    calls.push(action);
    if(action==="start") {
      await fs.writeFile(stateFile,JSON.stringify({schema:2}));
      return {status:"RUNNING"};
    }
    return {status:"VERIFIED"};
  };
  const first=await runDurableOrchestrator({
    ...f,maxCycles:1,cooldownMs:100,planFile:f.planFile,runSlice,
  });
  assert.equal(first.status,"WAITING");
  assert.equal(first.cycles,1);
  assert.deepEqual(calls,["start"]);
  const snapshot=await readDurableOrchestratorState(f);
  assert.equal(snapshot.nextRunAt,first.nextRunAt);
  const second=await runDurableOrchestrator({
    ...f,maxCycles:2,cooldownMs:100,runSlice,
  });
  assert.equal(second.status,"COMPLETE");
  assert.equal(second.cycles,2);
  assert.deepEqual(calls,["start","resume"]);
  const third=await runDurableOrchestrator({
    ...f,runSlice,
  });
  assert.equal(third.status,"COMPLETE");
  assert.deepEqual(calls,["start","resume"]);
});

test("AS-01 pauses and blocks without polling or resubmitting work",async t=>{
  const f=await fixture(t);
  let called=0;
  const runSlice=async()=>{called++;return {status:"BLOCKED"};};
  const first=await runDurableOrchestrator({
    ...f,planFile:null,goal:"test blocked work",maxCycles:25,runSlice,
  });
  assert.equal(first.status,"BLOCKED");
  assert.equal(first.cycles,1);
  const again=await runDurableOrchestrator({...f,planFile:null,maxCycles:25,runSlice});
  assert.equal(again.status,"BLOCKED");
  assert.equal(called,1);
  const g=await fixture(t);
  const paused=await runDurableOrchestrator({
    ...g,planFile:null,goal:"test paused work",maxCycles:25,
    runSlice:async()=>({status:"PAUSED"}),
  });
  assert.equal(paused.status,"PAUSED");
  assert.equal(paused.cycles,1);
});

test("AS-01 only one owner may run in a workspace, even across goals",async t=>{
  const f=await fixture(t);
  const secondCheckpoint=path.join(f.root,"other-checkpoint.json");
  let release;
  const running=new Promise(resolve=>{release=resolve;});
  let entered;
  const enteredPromise=new Promise(resolve=>{entered=resolve;});
  const first=runDurableOrchestrator({
    ...f,planFile:null,goal:"first goal",maxCycles:1,
    runSlice:async()=>{entered();await running;return {status:"VERIFIED"};},
  });
  try {
    await enteredPromise;
    await assert.rejects(runDurableOrchestrator({
      stateFile:secondCheckpoint,workspaceRoot:f.workspaceRoot,
      goal:"second goal",runSlice:async()=>({status:"VERIFIED"}),
    }),{code:"ORCHESTRATOR_ALREADY_OWNED"});
  } finally {release();}
  assert.equal((await first).status,"COMPLETE");
  const second=await runDurableOrchestrator({
    stateFile:secondCheckpoint,workspaceRoot:f.workspaceRoot,
    goal:"second goal",runSlice:async()=>({status:"VERIFIED"}),
  });
  assert.equal(second.status,"COMPLETE");
});

test("AS-01 failed slice is uncertain and never automatically replayed",async t=>{
  const f=await fixture(t);
  let called=0;
  const first=await runDurableOrchestrator({
    ...f,planFile:null,goal:"uncertain side effect",maxCycles:10,
    runSlice:async()=>{called++;throw Object.assign(new Error("connection lost"),{code:"TRANSPORT_UNKNOWN"});},
  });
  assert.equal(first.status,"UNCERTAIN");
  assert.equal(first.lastError,"TRANSPORT_UNKNOWN");
  const second=await runDurableOrchestrator({
    ...f,planFile:null,runSlice:async()=>{called++;return {status:"VERIFIED"};},
  });
  assert.equal(second.status,"UNCERTAIN");
  assert.equal(called,1);
});

test("AS-01 fails closed on in-flight checkpoint without proof",async t=>{
  const f=await fixture(t);
  await runDurableOrchestrator({
    ...f,planFile:null,goal:"crash case",maxCycles:1,
    runSlice:async()=>({status:"RUNNING"}),
  });
  const file=f.stateFile+".orchestrator.json";
  const state=JSON.parse(await fs.readFile(file,"utf8"));
  state.inFlight=true;
  state.status="RUNNING";
  await fs.writeFile(file,JSON.stringify(state));
  let called=0;
  const next=await runDurableOrchestrator({
    ...f,planFile:null,runSlice:async()=>{called++;return {status:"VERIFIED"};},
  });
  assert.equal(next.status,"UNCERTAIN");
  assert.equal(next.lastError,"MISSING_RECOVERY_CHECKPOINT");
  assert.equal(called,0);
});

test("AS-01 CLI exposes schedule and checkpoint inspection commands",()=>{
  const entry=fileURLToPath(new URL("../src/cli/main.js",import.meta.url));
  for(const sub of ["orchestrate","orchestrator-status"]){
    const r=spawnSync(process.execPath,[entry,"autonomy",sub,"--help"],{
      encoding:"utf8",timeout:15000,
    });
    assert.equal(r.status,0,r.stderr);
    assert.match(r.stdout,/--state/);
  }
});


test("AS-01 paused Worker state does not trigger automatic retries",async fixtureTest=>{
  const f=await fixture(fixtureTest);
  let calls=0;
  const result=await runDurableOrchestrator({
    ...f,planFile:null,goal:"paused worker",
    maxCycles:12,cooldownMs:100,
    runSlice:async()=>{
      calls++;
      return {status:"RUNNING",tasks:[{id:"one",status:"PAUSED"}]};
    },
  });
  assert.equal(result.status,"PAUSED");
  assert.equal(result.nextRunAt,null);
  assert.equal(result.cycles,1);
  assert.equal(calls,1);
});


test("AS-01 real Coordinator and Supervisor recover without duplicate Worker submissions",async t=>{
  const f=await fixture(t);
  await fs.writeFile(f.planFile,JSON.stringify({
    goal:"Produce a checked artifact",
    tasks:[{
      id:"deliver",instruction:"make deliverable",
      dependsOn:[],acceptance:[{kind:"file",path:"deliver.txt"}],
    }],
  }));
  const options={project:f.workspaceRoot,home:path.join(f.root,"home")};
  const executions=[];
  const runSlice=async slice=>runAutonomyCommand({
    ...slice,options,pollMs:5,output:()=>{},
    createSupervisor:config=>new TaskSupervisor({
      ...config,
      execute:async({session})=>{
        executions.push(session.state.task);
        assert.equal(session.state.task,"make deliverable");
        await fs.writeFile(path.join(f.workspaceRoot,"deliver.txt"),"done");
        return {message:"finished"};
      },
    }),
  });
  const first=await runDurableOrchestrator({
    ...f,maxCycles:1,planFile:f.planFile,sliceMs:5000,
    cooldownMs:100,runSlice,
  });
  assert.ok(["COMPLETE","WAITING"].includes(first.status),
    JSON.stringify(first));
  const second=await runDurableOrchestrator({
    ...f,maxCycles:6,sliceMs:5000,cooldownMs:100,runSlice,
  });
  assert.equal(second.status,"COMPLETE",JSON.stringify(second));
  assert.deepEqual(executions,["make deliverable"]);
  assert.equal(await fs.readFile(path.join(f.workspaceRoot,"deliver.txt"),"utf8"),"done");
  const third=await runDurableOrchestrator({
    ...f,maxCycles:4,sliceMs:5000,runSlice,
  });
  assert.equal(third.status,"COMPLETE");
  assert.deepEqual(executions,["make deliverable"]);
});


test("AS-01 rejects checkpoints inside workspace before any write",async t=>{
  const f=await fixture(t);
  const inside=path.join(f.workspaceRoot,"internal.json");
  let called=0;
  await assert.rejects(runDurableOrchestrator({
    workspaceRoot:f.workspaceRoot,stateFile:inside,
    goal:"Must not run",maxCycles:2,
    runSlice:async()=>{called++;return {status:"VERIFIED"};},
  }),{code:"ORCHESTRATOR_OPTIONS_INVALID"});
  assert.equal(called,0);
  await assert.rejects(fs.stat(inside+".orchestrator.json"),{code:"ENOENT"});
  await assert.rejects(fs.stat(inside+".orchestrator.lock"),{code:"ENOENT"});
});
