import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  makeGoalBudget,validateGoalBudget,budgetAllowance,
  reserveGoalBudget,settleGoalBudget,recoverOrphanedBudget,
} from "../src/autonomy/goal-budget.js";
import {
  runDurableOrchestrator,readDurableOrchestratorState,
} from "../src/autonomy/durable-orchestrator.js";

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"wtagent-ob02-"));
  t.after(()=>fs.rm(root,{force:true,recursive:true}));
  const workspaceRoot=path.join(root,"workspace");
  await fs.mkdir(workspaceRoot);
  return {root,workspaceRoot,stateFile:path.join(root,"checkpoint.json")};
}
const limits=(values={})=>({
  maxElapsedMs:20000,maxCalls:2,maxAttempts:2,maxConcurrent:1,...values,
});
const runOptions={cooldownMs:100,sliceMs:50,maxRunMs:2000};

test("OB-02 reservations are conservative and never reused across restart",()=>{
  const b=makeGoalBudget(limits({maxCalls:1,maxAttempts:1,maxElapsedMs:100}));
  const allowance=reserveGoalBudget(b,50);
  assert.equal(allowance,50);
  assert.equal(b.used.calls,1);
  assert.equal(b.used.attempts,1);
  assert.equal(b.used.elapsedMs,50);
  assert.equal(b.active,1);
  const recovered=JSON.parse(JSON.stringify(b));
  recoverOrphanedBudget(recovered);
  assert.equal(recovered.active,0);
  assert.equal(recovered.reservedMs,0);
  assert.equal(budgetAllowance(recovered,50),0);
  assert.equal(recovered.used.elapsedMs,50);
  assert.equal(validateGoalBudget(recovered),recovered);
});
test("OB-02 settlement refunds known unused time but not calls or attempts",()=>{
  const b=makeGoalBudget(limits());
  reserveGoalBudget(b,50);
  settleGoalBudget(b,1);
  assert.equal(b.used.calls,1);
  assert.equal(b.used.attempts,1);
  assert.ok(b.used.elapsedMs>=1&&b.used.elapsedMs<=2);
  assert.equal(b.active,0);
  assert.equal(b.reservedMs,0);
  reserveGoalBudget(b,50);
  settleGoalBudget(b,0,{uncertain:true});
  assert.equal(b.used.calls,2);
  assert.equal(b.used.attempts,2);
  assert.equal(budgetAllowance(b,50),0);
});
test("OB-02 invalid or expanded concurrency budgets fail closed",()=>{
  assert.throws(()=>makeGoalBudget(limits({maxConcurrent:2})),
    {code:"ORCHESTRATOR_BUDGET_UNSAFE"});
  assert.throws(()=>makeGoalBudget({maxCalls:0}),
    {code:"ORCHESTRATOR_BUDGET_UNSAFE"});
  assert.throws(()=>makeGoalBudget({maxCalls:10,secretToken:"private"}),
    {code:"ORCHESTRATOR_BUDGET_UNSAFE"});
  const b=makeGoalBudget();
  b.active=1;
  assert.throws(()=>validateGoalBudget(b),{code:"ORCHESTRATOR_BUDGET_UNSAFE"});
});
test("OB-02 repeated invocations share one durable call and attempt budget",async t=>{
  const f=await fixture(t);
  const seen=[];
  const runSlice=async({action})=>{
    seen.push(action);
    if(action==="goal"){
      await fs.writeFile(f.stateFile+".planner.json",
        JSON.stringify({schema:1}));
    }
    return {status:"RUNNING"};
  };
  const first=await runDurableOrchestrator({
    ...f,...runOptions,goal:"Goal with limited slices",maxCycles:1,
    budgetLimits:limits(),runSlice,
  });
  assert.equal(first.status,"WAITING");
  assert.equal(first.budget.used.calls,1);
  const second=await runDurableOrchestrator({
    ...f,...runOptions,maxCycles:5,runSlice,
  });
  assert.equal(second.status,"PAUSED");
  assert.equal(second.lastError,"GOAL_BUDGET_EXHAUSTED");
  assert.equal(second.budget.used.calls,2);
  assert.equal(second.budget.used.attempts,2);
  assert.equal(second.budget.active,0);
  assert.deepEqual(seen,["goal","resume"]);
  const third=await runDurableOrchestrator({
    ...f,...runOptions,maxCycles:5,runSlice,
  });
  assert.equal(third.status,"PAUSED");
  assert.equal(third.budget.used.calls,2);
  assert.deepEqual(seen,["goal","resume"]);
  assert.deepEqual(await readDurableOrchestratorState(f),third);
});
test("OB-02 changing an existing goal budget after restart is rejected",async t=>{
  const f=await fixture(t);
  await runDurableOrchestrator({...f,...runOptions,goal:"Immutable budget",
    maxCycles:1,budgetLimits:limits(),runSlice:async()=>({status:"RUNNING"})});
  let calls=0;
  await assert.rejects(()=>runDurableOrchestrator({
    ...f,...runOptions,budgetLimits:limits({maxCalls:100}),
    runSlice:async()=>{calls++;return {status:"VERIFIED"};},
  }),{code:"ORCHESTRATOR_BUDGET_IMMUTABLE"});
  assert.equal(calls,0);
});
test("OB-02 exhausted goal cannot claim successful completion",async t=>{
  const f=await fixture(t);
  let calls=0;
  const result=await runDurableOrchestrator({
    ...f,...runOptions,goal:"Budget exhaustion",
    budgetLimits:limits({maxElapsedMs:50,maxCalls:10,maxAttempts:10}),
    maxCycles:5,
    runSlice:async()=>{
      calls++;
      await new Promise(resolve=>setTimeout(resolve,65));
      return {status:"RUNNING"};
    },
  });
  assert.equal(result.status,"PAUSED");
  assert.equal(result.lastError,"GOAL_BUDGET_EXHAUSTED");
  assert.equal(result.budget.used.elapsedMs,50);
  assert.equal(result.budget.active,0);
  assert.equal(calls,1);
});
test("OB-02 cancelled run releases budget slot and workspace ownership",async t=>{
  const f=await fixture(t);
  const controller=new AbortController();
  let firstCalls=0;
  const first=await runDurableOrchestrator({
    ...f,...runOptions,goal:"Cancellation",
    budgetLimits:limits(),maxCycles:3,signal:controller.signal,
    runSlice:async()=>{
      firstCalls++;
      controller.abort();
      return {status:"VERIFIED"};
    },
  });
  assert.equal(first.status,"PAUSED");
  assert.equal(first.lastError,"CANCELLED");
  assert.notEqual(first.status,"COMPLETE");
  assert.equal(first.budget.active,0);
  assert.equal(first.budget.reservedMs,0);
  assert.equal(first.budget.used.calls,1);
  assert.equal(firstCalls,1);
  // Must be able to acquire both owners for a different goal in the same
  // workspace after this invocation has returned.
  const another=await runDurableOrchestrator({
    workspaceRoot:f.workspaceRoot,stateFile:path.join(f.root,"other.json"),
    ...runOptions,maxCycles:1,goal:"Second goal",
    runSlice:async()=>({status:"VERIFIED"}),
  });
  assert.equal(another.status,"COMPLETE");
});
test("OB-02 exceptions retain conservative budget charge and release owners",async t=>{
  const f=await fixture(t);
  const result=await runDurableOrchestrator({
    ...f,...runOptions,goal:"Uncertain execution",
    budgetLimits:limits(),maxCycles:1,
    runSlice:async()=>{throw Object.assign(new Error("lost"),{code:"LOST"});},
  });
  assert.equal(result.status,"UNCERTAIN");
  assert.equal(result.budget.active,0);
  assert.equal(result.budget.used.elapsedMs,50);
  assert.equal(result.budget.used.calls,1);
  assert.equal(result.budget.used.attempts,1);
  const again=await runDurableOrchestrator({
    ...f,...runOptions,runSlice:async()=>({status:"VERIFIED"}),
  });
  assert.equal(again.status,"UNCERTAIN");
  assert.equal(again.budget.used.calls,1);
});


test("OB-02 missing recovery evidence clears reserved concurrency but preserves charges",async t=>{
  const f=await fixture(t);
  const first=await runDurableOrchestrator({
    ...f,...runOptions,goal:"Crash without recovery checkpoint",
    budgetLimits:limits(),maxCycles:1,
    runSlice:async()=>({status:"RUNNING"}),
  });
  assert.equal(first.status,"WAITING");
  const checkpoint=f.stateFile+".orchestrator.json";
  const crash=JSON.parse(await fs.readFile(checkpoint,"utf8"));
  // Simulate a process crash after the next slice was durably reserved.
  crash.status="RUNNING";
  crash.inFlight=true;
  crash.budget.active=1;
  crash.budget.reservedMs=50;
  crash.budget.used.calls++;
  crash.budget.used.attempts++;
  crash.budget.used.elapsedMs+=50;
  await fs.writeFile(checkpoint,JSON.stringify(crash));
  let calls=0;
  const recovered=await runDurableOrchestrator({
    ...f,...runOptions,runSlice:async()=>{calls++;return {status:"VERIFIED"};},
  });
  assert.equal(recovered.status,"UNCERTAIN");
  assert.equal(recovered.lastError,"MISSING_RECOVERY_CHECKPOINT");
  assert.equal(recovered.budget.active,0);
  assert.equal(recovered.budget.reservedMs,0);
  assert.equal(recovered.budget.used.calls,2);
  assert.equal(recovered.budget.used.attempts,2);
  assert.equal(calls,0);
  assert.deepEqual(await readDurableOrchestratorState(f),recovered);
});
