import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {TaskSupervisor} from "../src/supervisor/task-supervisor.js";
import {TaskCoordinator} from "../src/autonomy/task-coordinator.js";
import {readEvidenceDeliveryReport} from "../src/autonomy/delivery-report.js";

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test("SU-03 real supervised DAG: replan, injected failure, repair, restart and evidence-backed delivery",async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"wtagent-su03-e2e-"));
  const workspaceRoot=path.join(home,"workspace");
  const stateFile=path.join(home,"checkpoint","plan.json");
  await fs.mkdir(path.join(workspaceRoot,"test"),{recursive:true});
  await fs.writeFile(path.join(workspaceRoot,"package.json"),
    '{"name":"su03-e2e","private":true,"type":"module"}');
  await fs.writeFile(path.join(workspaceRoot,"test","accept.test.js"),[
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import {readFileSync} from "node:fs";',
    'test("all pipeline artifacts are behaviorally correct",()=>{',
    ' for(const name of ["one","preflight","two","three"])',
    '  assert.equal(readFileSync(name+".txt","utf8"),"artifact-"+name);',
    '});',
    '',
  ].join("\n"));
  const executions=[];
  let supervisor;
  const execute=async({session})=>{
    const instruction=session.state.task;
    const match=/^produce (one|preflight|two|three)$/.exec(instruction);
    if(match){
      const name=match[1];
      executions.push("produce:"+name);
      if(name==="two")return {message:"injected missing artifact"};
      await fs.writeFile(path.join(workspaceRoot,name+".txt"),"artifact-"+name);
      return {message:"produced "+name};
    }
    assert.match(instruction,/two|repair|artifact/i);
    executions.push("repair:two");
    await fs.writeFile(path.join(workspaceRoot,"two.txt"),"artifact-two");
    return {message:"repaired missing two.txt"};
  };
  const init=async()=>{
    const instance=new TaskSupervisor({
      dataDir:path.join(home,"supervisor"),
      sessionsDir:path.join(home,"sessions"),
      workspaces:[{id:"main",root:workspaceRoot}],
      execute,
      options:{recovery:{retryBaseMs:5,retryMaxMs:10,maxRetries:1}},
    });
    await instance.init();
    supervisor=instance;
  };
  await init();
  t.after(async()=>{
    try{await supervisor?.close();}
    finally{await fs.rm(home,{recursive:true,force:true});}
  });
  const task=(id,dependsOn=[])=>({
    id,instruction:"produce "+id,dependsOn,
    acceptance:[{kind:"file",path:id+".txt",minBytes:1}],
  });
  const plan={
    goal:"Build a functioning four-stage pipeline with verified behavior",
    tasks:[task("one"),task("two",["one"]),task("three",["two"])],
    finalAcceptance:[{
      kind:"test",program:"node",argv:["--test","test/accept.test.js"],
      cwd:".",timeoutMs:15000,minTests:1,maxSkipped:0,
    }],
  };
  const params=()=>({stateFile,workspaceRoot,workspaceId:"main",supervisor});
  let coordinator=await TaskCoordinator.create({...params(),plan});
  let first;
  for(let i=0;i<250;i++){
    first=await coordinator.tick();
    if(first.tasks[0].status==="VERIFIED")break;
    if(first.status==="BLOCKED")assert.fail(first.lastError);
    await pause(5);
  }
  assert.equal(first.tasks[0].status,"VERIFIED");
  const originalProof=structuredClone(first.tasks[0].verificationReceipt);
  assert.ok(originalProof);
  const revised=await coordinator.revisePlan({
    expectedRevision:0,
    tasks:[task("one"),task("preflight",["one"]),
      task("two",["preflight"]),task("three",["two"])],
  });
  assert.equal(revised.planRevision,1);
  assert.deepEqual(revised.tasks[0].verificationReceipt,originalProof);
  // Simulate a real Supervisor process restart after revision.
  await supervisor.close();
  await init();
  coordinator=await TaskCoordinator.load(params());
  const blocked=await coordinator.run({timeoutMs:20000,pollMs:5});
  assert.equal(blocked.status,"BLOCKED");
  assert.equal(blocked.tasks[0].status,"VERIFIED");
  assert.equal(blocked.tasks[1].status,"VERIFIED");
  assert.equal(blocked.tasks[2].status,"BLOCKED");
  assert.equal(blocked.tasks[3].status,"TODO");
  assert.deepEqual(executions,["produce:one","produce:preflight","produce:two"]);
  const incomplete=await readEvidenceDeliveryReport({stateFile,workspaceRoot});
  assert.notEqual(incomplete.deliveryStatus,"DELIVERED");
  assert.ok(incomplete.unmetRequirements.length>0);
  const proposal=await coordinator.prepareRepairSubtask();
  assert.ok(proposal);
  // Explicit repair work is submitted once; a restart must not replay it.
  let repairState=await coordinator.repairTick();
  for(let i=0;i<250&&repairState.status==="BLOCKED";i++){
    await pause(5);
    repairState=await coordinator.repairTick();
  }
  assert.equal(repairState.status,"RUNNING",repairState.lastError);
  assert.equal(repairState.tasks[2].status,"VERIFIED");
  assert.equal(executions.filter(x=>x==="repair:two").length,1);
  await supervisor.close();
  await init();
  coordinator=await TaskCoordinator.load(params());
  const delivered=await coordinator.run({timeoutMs:20000,pollMs:5});
  assert.equal(delivered.status,"VERIFIED",delivered.lastError);
  assert.equal(delivered.goalDelivery.status,"DELIVERED");
  assert.equal(delivered.planRevision,1);
  assert.deepEqual(delivered.tasks[0].verificationReceipt,originalProof);
  assert.deepEqual(delivered.tasks.map(x=>x.status),
    ["VERIFIED","VERIFIED","VERIFIED","VERIFIED"]);
  assert.deepEqual(executions,[
    "produce:one","produce:preflight","produce:two","repair:two","produce:three",
  ]);
  const report=await readEvidenceDeliveryReport({stateFile,workspaceRoot});
  assert.equal(report.deliveryStatus,"DELIVERED",JSON.stringify(report.unmetRequirements));
  assert.deepEqual(report.unmetRequirements,[]);
  assert.ok(report.tasks.every(item=>item.receiptValid));
  assert.ok(report.finalAcceptance.every(item=>item.satisfied));
  assert.match(report.reportDigest,/^[0-9a-f]{64}$/);
  const before=[...executions];
  const again=await TaskCoordinator.load(params());
  const reread=await again.run({timeoutMs:1000,pollMs:5});
  assert.equal(reread.status,"VERIFIED");
  assert.deepEqual(executions,before);
  assert.deepEqual(await readEvidenceDeliveryReport({stateFile,workspaceRoot}),report);
});
