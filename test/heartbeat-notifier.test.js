import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHeartbeatNotifier } from "../src/supervisor/heartbeat-notifier.js";
import { TaskSupervisor } from "../src/supervisor/task-supervisor.js";
import { runAutonomyCommand } from "../src/cli/autonomy-command.js";

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"wtagent-as03-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return path.join(root,"state.json");
}
test("AS-03 approval escalation is redacted and never authorizes anything",async t=>{
  const file=await fixture(t);
  const messages=[];let now=2000000;
  const notifier=createHeartbeatNotifier({
    stateFile:file,now:()=>now,notify:e=>messages.push(e),
    heartbeatMs:1000,repeatMs:2000,stallMs:1000,
  });
  const rawSecret="Bearer secret-token user@example.com /private/credentials";
  const observation={
    coordinatorState:{status:"RUNNING",goal:rawSecret},
    supervisorTasks:[{
      status:"waiting_approval",task:"secret instruction",
      pendingApproval:{arguments:rawSecret,tool:"terminal.exec"},
      incident:{message:rawSecret},
    }],
  };
  const event=await notifier.observe(observation);
  assert.equal(event.type,"APPROVAL_REQUIRED");
  assert.equal(event.reason,"EXPLICIT_HUMAN_APPROVAL");
  assert.equal(messages.length,1);
  assert.ok(!JSON.stringify(event).includes(rawSecret));
  assert.ok(!JSON.stringify(event).includes("terminal.exec"));
  assert.ok(!JSON.stringify(event).includes("user@example.com"));
  const saved=await fs.readFile(notifier.file,"utf8");
  assert.ok(!saved.includes(rawSecret));
  assert.ok(!saved.includes("terminal.exec"));
  assert.equal(observation.supervisorTasks[0].pendingApproval.arguments,rawSecret);
  now+=1500;
  assert.equal(await notifier.observe(observation),null);
  now+=501;
  assert.equal((await notifier.observe(observation)).type,"APPROVAL_REQUIRED");
  assert.equal(messages.length,2);
});
test("AS-03 heartbeat frequency survives restart without floods",async t=>{
  const file=await fixture(t);
  let now=1000000;const seen=[];
  const config={stateFile:file,now:()=>now,notify:e=>seen.push(e),
    heartbeatMs:5000,repeatMs:15000,stallMs:1000};
  const n=createHeartbeatNotifier(config);
  const state={coordinatorState:{status:"RUNNING"},supervisorTasks:[]};
  assert.equal((await n.observe(state)).type,"HEARTBEAT");
  for(let i=0;i<35;i++)await n.observe(state);
  const restarted=createHeartbeatNotifier(config);
  now+=4999;
  assert.equal(await restarted.observe(state),null);
  now+=1;
  assert.equal((await restarted.observe(state)).type,"HEARTBEAT");
  assert.equal(seen.length,2);
});
test("AS-03 stalled workers escalate without copying unsafe incident text",async t=>{
  const file=await fixture(t);
  const now=1000000;const seen=[];
  const n=createHeartbeatNotifier({
    stateFile:file,now:()=>now,notify:e=>seen.push(e),
    heartbeatMs:1000,repeatMs:2000,stallMs:1000,
  });
  const result=await n.observe({
    coordinatorState:{status:"RUNNING"},
    supervisorTasks:[{
      status:"running",updatedAt:new Date(now-5000).toISOString(),
      incident:{code:"token=not-safe",message:"never display me"},
    }],
  });
  assert.equal(result.type,"STALLED");
  assert.ok(!JSON.stringify(result).includes("never display me"));
  assert.equal(await n.observe({
    coordinatorState:{status:"RUNNING"},
    supervisorTasks:[{status:"running",updatedAt:new Date(now-5000).toISOString()}],
  }),null);
});
test("AS-03 invalid notification checkpoint fails closed",async t=>{
  const file=await fixture(t);
  await fs.writeFile(file+".notifications.json",JSON.stringify({
    schema:1,recent:[{fingerprint:"a",at:"bad"}],
  }));
  const n=createHeartbeatNotifier({stateFile:file});
  await assert.rejects(n.observe({}),{code:"HEARTBEAT_STATE_UNSAFE"});
});


test("AS-03 Worker pause is actionable rather than a misleading heartbeat",async t=>{
  const file=await fixture(t);
  const events=[];
  const n=createHeartbeatNotifier({
    stateFile:file,notify:event=>events.push(event),
    now:()=>1000000,heartbeatMs:1000,repeatMs:2000,stallMs:1000,
  });
  const event=await n.observe({
    coordinatorState:{status:"RUNNING"},
    supervisorTasks:[{
      status:"paused",
      incident:{message:"token=extremely-secret",
        reason:"hidden-workspace-path"},
    }],
  });
  assert.equal(event.type,"PAUSED");
  assert.equal(event.reason,"WORKER_PAUSED");
  assert.equal(event.severity,"ACTION_REQUIRED");
  assert.ok(!JSON.stringify(events).includes("extremely-secret"));
  assert.equal(await n.observe({
    coordinatorState:{status:"RUNNING"},
    supervisorTasks:[{status:"paused"}],
  }),null);
});

test("AS-03 actual autonomy CLI reports sanitized heartbeat and verified completion",async t=>{
  const file=await fixture(t);
  const root=path.dirname(file);
  const workspaceRoot=path.join(root,"workspace");
  const home=path.join(root,"appdata");
  await fs.mkdir(workspaceRoot);
  const planFile=path.join(root,"plan.json");
  await fs.writeFile(planFile,JSON.stringify({
    goal:"Make a verified artifact",
    tasks:[{
      id:"output",instruction:"write result file",
      dependsOn:[],acceptance:[{kind:"file",path:"result.txt"}],
    }],
  }));
  const notifications=[];
  const n=createHeartbeatNotifier({
    stateFile:file,notify:e=>notifications.push(e),
    heartbeatMs:1000,repeatMs:1000,stallMs:1000,
  });
  let executions=0;
  const result=await runAutonomyCommand({
    action:"start",planFile,stateFile:file,
    options:{project:workspaceRoot,home},
    timeoutMs:15000,pollMs:5,output:()=>{},
    onObservation:observation=>n.observe(observation),
    createSupervisor:config=>new TaskSupervisor({
      ...config,
      execute:async({session})=>{
        executions++;
        assert.equal(session.state.task,"write result file");
        await fs.writeFile(path.join(workspaceRoot,"result.txt"),"verified");
        return {message:"finished"};
      },
    }),
  });
  assert.equal(result.status,"VERIFIED");
  assert.equal(executions,1);
  assert.ok(notifications.length>=1,"CLI must emit at least one observation");
  assert.ok(notifications.some(e=>["HEARTBEAT","COMPLETE"].includes(e.type)),
    JSON.stringify(notifications));
  assert.ok(notifications.every(e=>
    Object.keys(e).every(key=>[
      "type","severity","reason","message","at",
    ].includes(key))));
  const record=await fs.readFile(file+".notifications.json","utf8");
  assert.ok(!record.includes("write result file"));
  assert.ok(!record.includes(workspaceRoot));
});
