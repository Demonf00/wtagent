import test from "node:test";
import assert from "node:assert/strict";
import {sanitizeDurableToolEvent,buildDurableProgress,formatDurableProgress}
  from "../src/supervisor/durable-progress.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAutonomyCommand } from "../src/cli/autonomy-command.js";
import { TaskSupervisor } from "../src/supervisor/task-supervisor.js";
import { readAutonomyProgress } from "../src/cli/progress-command.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";


const id="task_01234567-89ab-cdef-0123-456789abcdef";
test("OB-01 allowlists tool progress, drops private model and tool data",()=>{
  const secret="Bearer super-secret /home/private user@example.com";
  assert.equal(sanitizeDurableToolEvent({
    type:"model.progress",payload:{message:secret},
  }),null);
  assert.equal(sanitizeDurableToolEvent({
    type:"tool.started",payload:{name:"terminal.exec;"+secret},
  }),null);
  const safe=sanitizeDurableToolEvent({
    type:"tool.completed",
    payload:{toolClass:"read",result:{name:"terminal.exec",ok:true,
      output:secret,args:{token:secret}},message:secret},
  });
  assert.deepEqual(safe,{type:"tool.completed",payload:{
    name:"read",ok:true,
  }});
  assert.equal(sanitizeDurableToolEvent({
    type:"tool.started",payload:{name:"terminal.exec",args:secret},
  }),null);
  assert.equal(sanitizeDurableToolEvent({
    type:"tool.started",payload:{toolClass:"verify",name:secret},
  }).payload.name,"verify");
  assert.ok(!JSON.stringify(safe).includes(secret));
});
test("OB-01 reconstructs attempts, last action and safe next step",()=>{
  const events=[
    {seq:1,type:"task.created",payload:{secret:"DO_NOT_ECHO"}},
    {seq:2,type:"tool.started",payload:{toolClass:"read",name:"terminal.exec",args:"SECRET"}},
    {seq:3,type:"tool.completed",payload:{toolClass:"read",name:"terminal.exec",result:"SECRET",ok:true}},
  ];
  const state=buildDurableProgress({
    taskId:id,status:"completed",attempts:2,retries:1,
    error:{message:"SECRET"},result:{message:"SECRET"},
  },events);
  assert.equal(state.attempts,2);
  assert.equal(state.retries,1);
  assert.equal(state.status,"completed");
  assert.equal(state.totalToolStarts,1);
  assert.equal(state.nextStep,"VERIFY_RESULT");
  assert.equal(state.lastAction.tool,"read");
  assert.equal(state.lastEventSeq,3);
  assert.ok(!JSON.stringify(state).includes("SECRET"));
  assert.match(formatDurableProgress(state),/action=read/);
});
test("OB-01 reattach gives actionable approval, pause and uncertain outcomes",()=>{
  for(const [status,nextStep] of [
    ["waiting_approval","HUMAN_APPROVAL_REQUIRED"],
    ["paused","EXPLICIT_RESUME_REQUIRED"],
    ["blocked_uncertain","RECONCILE_UNCERTAIN_EXECUTION"],
  ]) {
    assert.equal(buildDurableProgress({taskId:id,status},[]).nextStep,nextStep);
  }
});


test("OB-01 real Supervisor checkpoint reattachment preserves bounded tool progress",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"wtagent-ob01-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const workspaceRoot=path.join(root,"workspace");
  await fs.mkdir(workspaceRoot);
  const stateFile=path.join(root,"plan-state.json");
  const planFile=path.join(root,"plan.json");
  await fs.writeFile(planFile,JSON.stringify({
    goal:"Create verified artifact",
    tasks:[{
      id:"safe_artifact",dependsOn:[],instruction:"write artifact safely",
      acceptance:[{kind:"file",path:"artifact.txt"}],
    }],
  }));
  const output=[];
  const secret="Bearer super-secret user@example.com";
  let calls=0;
  const result=await runAutonomyCommand({
    action:"start",planFile,stateFile,
    options:{project:workspaceRoot,home:path.join(root,"home")},
    timeoutMs:15000,pollMs:5,output:line=>output.push(line),
    createSupervisor:config=>new TaskSupervisor({
      ...config,
      execute:async({session,onEvent,onDisplay})=>{
        calls++;
        await onEvent?.({
          type:"tool.started",
          payload:{name:"fs.read",args:{secret}},
        });
        await fs.writeFile(path.join(workspaceRoot,"artifact.txt"),"verified artifact");
        await onEvent?.({
          type:"tool.result_sent",payload:{name:"fs.read",ok:true,secret},
        });
        await onDisplay?.({
          type:"tool.started",payload:{name:"fs.read",args:{secret}},
        });
        return {message:"finished"};
      },
    }),
  });
  assert.equal(result.status,"VERIFIED");
  assert.equal(calls,1);
  assert.ok(output.some(line=>line.includes("[Agent] Running fs.read")),
    "Live tool echo must remain visible");
  assert.ok(!output.join("\n").includes(secret),
    "Live echo must not contain private tool arguments");
  const snapshot=await readAutonomyProgress({stateFile,workspaceRoot});
  assert.equal(snapshot.phase,"EXECUTION");
  assert.equal(snapshot.status,"VERIFIED");
  assert.equal(snapshot.verifiedTasks,1);
  assert.equal(snapshot.totalTasks,1);
  assert.equal(snapshot.currentTask.id,"safe_artifact");
  assert.equal(snapshot.currentTask.status,"VERIFIED");
  assert.equal(snapshot.testStatus,"VERIFIED");
  assert.equal(snapshot.nextStep,"GOAL_VERIFIED");
  assert.ok(snapshot.lastEventSeq>0);
  assert.ok(snapshot.lastAction);
  const repeated=await readAutonomyProgress({stateFile,workspaceRoot});
  assert.deepEqual(repeated,snapshot);
  const text=JSON.stringify(snapshot);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes("write artifact safely"));
  assert.ok(!text.includes(workspaceRoot));
  const workerId=snapshot.currentTask.workerId;
  const history=await fs.readFile(path.join(stateFile+".supervisor",
    workerId+".events.jsonl"),"utf8");
  assert.ok(!history.includes(secret));
  assert.ok(!history.includes("write artifact safely"));
  assert.ok(!history.includes("args"));
  assert.equal(snapshot.lastAction.tool,"read");
  const entry=fileURLToPath(new URL("../src/cli/main.js",import.meta.url));
  const child=spawnSync(process.execPath,[
    entry,"--project",workspaceRoot,"autonomy","progress",
    "--state",stateFile,
  ],{encoding:"utf8",timeout:15000});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),snapshot);
  assert.equal(calls,1,"Reattaching must not execute any Worker");
});


test("OB-01 uses real Supervisor event categories without persisting raw tool names",async()=>{
  const {safeRuntimeEvent}=await import("../src/supervisor/recovery-controller.js");
  const secret="private-session-token user@example.com";
  const raw={
    type:"tool.started",payload:{name:"terminal.exec",
      args:{token:secret},message:secret},
  };
  const persisted=safeRuntimeEvent(raw);
  assert.equal(persisted.type,"tool.started");
  assert.equal(persisted.payload.toolClass,"other");
  assert.ok(!JSON.stringify(persisted).includes(secret));
  const event={seq:1,...persisted};
  const projection=buildDurableProgress({
    taskId:id,status:"running",attempts:1,retries:0,
  },[event]);
  assert.equal(projection.lastAction.tool,"other");
  assert.equal(projection.lastAction.stage,"tool.started");
  assert.equal(projection.nextStep,"MONITOR_WORKER");
  assert.ok(!JSON.stringify(projection).includes("terminal.exec"));
  assert.ok(!JSON.stringify(projection).includes(secret));
});
