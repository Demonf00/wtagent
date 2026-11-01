import fs from "node:fs/promises";
import path from "node:path";
import { buildDurableProgress } from "../supervisor/durable-progress.js";

const TASK=/^task_[a-f0-9-]{36}$/;
const ID=/^[a-zA-Z0-9_-]{1,64}$/;
const STATUS=new Set([
  "TODO","RUNNING","VERIFYING","VERIFIED","BLOCKED","PAUSED",
  "FAILED","PLANNING","PLANNED","COMPLETED",
]);
function fail(message,code="DURABLE_PROGRESS_UNSAFE"){
  return Object.assign(new Error(message),{code});
}
async function readRegular(file,limit=8*1024*1024,optional=false){
  let stat;
  try{stat=await fs.lstat(file);}
  catch(error){
    if(optional&&error.code==="ENOENT")return null;
    throw error;
  }
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit){
    throw fail("Progress source is not a bounded regular file");
  }
  return fs.readFile(file,"utf8");
}
async function json(file,limit,optional=false){
  const text=await readRegular(file,limit,optional);
  if(text===null)return null;
  try{return JSON.parse(text);}
  catch{throw fail("Progress source contains invalid JSON");}
}
async function eventsFrom(file){
  const text=await readRegular(file,4*1024*1024,true);
  if(text===null)return [];
  const result=[];
  for(const line of text.split("\n")){
    if(!line.trim())continue;
    let event;
    try{event=JSON.parse(line);}
    catch{throw fail("Progress event history contains invalid JSON");}
    if(!Number.isSafeInteger(event?.seq)||event.seq<=0
      ||typeof event.type!=="string")throw fail("Invalid progress event");
    result.push(event);
  }
  return result;
}
function safeId(value){
  return typeof value==="string"&&ID.test(value)?value:null;
}
function taskStatus(value){
  return STATUS.has(value)?value:"UNKNOWN";
}
/**
 * Reconstructs state on demand. No writes, task submission, or permissions.
 * Raw goal instructions, task instructions, tool arguments and Worker results
 * never reach the returned object.
 */
export async function readAutonomyProgress({stateFile,workspaceRoot}){
  if(typeof stateFile!=="string"||!stateFile.trim()
    ||typeof workspaceRoot!=="string"||!workspaceRoot.trim()){
    throw fail("State file and workspace are required");
  }
  const root=await fs.realpath(path.resolve(workspaceRoot));
  const checkpoint=path.resolve(stateFile);
  if(checkpoint===root||checkpoint.startsWith(root+path.sep)){
    throw fail("Checkpoint must be outside workspace");
  }
  const state=await json(checkpoint,8*1024*1024,true);
  if(!state){
    const planner=await json(checkpoint+".planner.json",1024*1024);
    if(planner.workspaceRoot!==root||
      typeof planner.id!=="string"||!ID.test(planner.status??"")){
      throw fail("Planner checkpoint identity invalid");
    }
    return {
      goalId:typeof planner.id==="string"&&/^[a-f0-9-]{36}$/.test(planner.id)
        ?planner.id:null,
      phase:"PLANNING",status:taskStatus(planner.status),
      currentTask:null,verifiedTasks:0,totalTasks:0,
      lastAction:null,attempts:0,retries:0,
      testStatus:"NOT_STARTED",
      nextStep:planner.status==="BLOCKED"?"REVIEW_PLANNER":"MONITOR_PLANNER",
    };
  }
  if(state.workspaceRoot!==root||!Array.isArray(state.tasks)
    ||state.tasks.length>256||typeof state.planId!=="string"
    ||!/^[a-f0-9-]{36}$/.test(state.planId)){
    throw fail("Coordinator checkpoint identity invalid");
  }
  const verified=state.tasks.filter(t=>t.status==="VERIFIED").length;
  const current=state.tasks.find(t=>!["VERIFIED"].includes(t.status))
    ??state.tasks.at(-1)??null;
  if(current&&!safeId(current.id)){
    throw fail("Task ID unsafe");
  }
  const taskId=current?.supervisorTaskId;
  if(taskId!==null&&taskId!==undefined&&!TASK.test(taskId)){
    throw fail("Worker ID unsafe");
  }
  const supervisorDir=checkpoint+".supervisor";
  const worker=taskId?
    await json(path.join(supervisorDir,taskId+".json"),1024*1024,true):null;
  if(worker&&worker.taskId!==taskId)throw fail("Worker checkpoint identity invalid");
  const history=taskId?
    await eventsFrom(path.join(supervisorDir,taskId+".events.jsonl")):[];
  const progress=buildDurableProgress(
    {taskId:taskId??null,status:worker?.status??"unknown",
      attempts:worker?.attempts,retries:worker?.retries},history);
  const status=taskStatus(state.status);
  const currentStatus=taskStatus(current?.status);
  const nextStep=status==="VERIFIED"?"GOAL_VERIFIED":
    currentStatus==="BLOCKED"?"REVIEW_TASK_FAILURE":
    currentStatus==="VERIFIED"
      ?state.goalDelivery?.status==="VERIFIED"?"DELIVERY_VERIFIED":"VERIFY_DELIVERY"
      :currentStatus==="VERIFYING"?"VERIFY_ARTIFACT"
      :currentStatus==="TODO"?"START_READY_TASK"
      :progress.nextStep==="INSPECT_STATE"?"INSPECT_COORDINATOR":progress.nextStep;
  return {
    goalId:state.planId,
    phase:"EXECUTION",status,
    currentTask:current?{id:current.id,status:currentStatus,
      workerId:taskId??null}:null,
    verifiedTasks:verified,totalTasks:state.tasks.length,
    lastAction:progress.lastAction,
    attempts:progress.attempts,retries:progress.retries,
    testStatus:currentStatus==="VERIFIED"?"VERIFIED":
      currentStatus==="VERIFYING"?"IN_PROGRESS":
        current?.verificationReceipt?"EVIDENCED":"NOT_VERIFIED",
    nextStep,
    lastEventSeq:progress.lastEventSeq,
  };
}
