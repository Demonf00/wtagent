import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA=1;
const STATES=new Set([
  "queued","running","recovering","waiting_retry","waiting_approval",
  "pausing","paused","blocked_uncertain","completed","failed",
  "cancelled","cancelling",
]);
const MAX_BYTES=32768;
const MAX_HISTORY=32;

function error(code,message){return Object.assign(new Error(message),{code});}
function safeStatus(value) {
  return typeof value==="string"&&STATES.has(value)?value:"unknown";
}
async function read(file){
  let stat;
  try{stat=await fs.lstat(file);}
  catch(e){if(e.code==="ENOENT")return null;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES){
    throw error("HEARTBEAT_STATE_UNSAFE","Unsafe heartbeat checkpoint");
  }
  let value;
  try{value=JSON.parse(await fs.readFile(file,"utf8"));}
  catch{throw error("HEARTBEAT_STATE_UNSAFE","Invalid heartbeat checkpoint");}
  if(value?.schema!==SCHEMA||!Array.isArray(value.recent)
    ||value.recent.length>MAX_HISTORY
    ||!(value.lastHeartbeatAt===null||Number.isSafeInteger(value.lastHeartbeatAt))
    ||!(value.lastFingerprint===null||typeof value.lastFingerprint==="string"
      &&value.lastFingerprint.length<=160)
    ||value.recent.some(x=>typeof x?.fingerprint!=="string"
      ||x.fingerprint.length>160||!Number.isSafeInteger(x.at))){
    throw error("HEARTBEAT_STATE_UNSAFE","Invalid heartbeat history");
  }
  return value;
}
async function persist(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+"."+randomUUID()+".tmp";
  try{
    const h=await fs.open(tmp,"wx",0o600);
    try{await h.writeFile(JSON.stringify(value)+"\n");await h.sync();}
    finally{await h.close();}
    await fs.rename(tmp,file);
  }finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
}
function pick(observation,now,stallMs){
  const workers=Array.isArray(observation?.supervisorTasks)
    ?observation.supervisorTasks:[];
  const statuses=workers.map(x=>safeStatus(x?.status));
  if(statuses.includes("waiting_approval")||
      workers.some(x=>x?.pendingApproval!=null)){
    return {
      type:"APPROVAL_REQUIRED",severity:"ACTION_REQUIRED",
      reason:"EXPLICIT_HUMAN_APPROVAL",
      message:"A Worker requires a human decision. Inspect it using the existing approval controls; no approval has been granted.",
    };
  }
  if(statuses.includes("blocked_uncertain")){
    return {
      type:"UNCERTAIN",severity:"ACTION_REQUIRED",
      reason:"WORKER_OUTCOME_UNKNOWN",
      message:"Worker outcome cannot be established. Inspect the persisted task before manually resuming.",
    };
  }
  if(statuses.includes("paused")){
    return {
      type:"PAUSED",severity:"ACTION_REQUIRED",
      reason:"WORKER_PAUSED",
      message:"A Worker has paused. Inspect its checkpoint and explicitly decide whether it may resume.",
    };
  }
  if(statuses.includes("failed")){
    return {
      type:"WORKER_FAILED",severity:"WARNING",
      reason:"WORKER_EXECUTION_FAILED",
      message:"A Worker reported failure. Inspect the Supervisor and verification record before retrying.",
    };
  }
  const status=typeof observation?.coordinatorState?.status==="string"
    ?observation.coordinatorState.status:"UNKNOWN";
  if(status==="BLOCKED"||status==="PAUSED"){
    return {
      type:status,severity:"ACTION_REQUIRED",
      reason:status==="BLOCKED"?"PLAN_BLOCKED":"PLAN_PAUSED",
      message:status==="BLOCKED"
        ?"The plan is blocked. Inspect its checkpoint and resolve the blocker manually."
        :"The plan is paused. Manual inspection is required before continuation.",
    };
  }
  const running=workers.filter(x=>["running","recovering","waiting_retry"].includes(
    safeStatus(x?.status)));
  if(running.some(x=>{
    const value=Date.parse(x.updatedAt);
    return Number.isFinite(value)&&now-value>=stallMs&&now>=value;
  })){
    return {
      type:"STALLED",severity:"WARNING",
      reason:"WORKER_ACTIVITY_STALE",
      message:"A Worker has not changed its recorded state recently. Inspect the Supervisor before retrying.",
    };
  }
  if(status==="VERIFIED"){
    return {
      type:"COMPLETE",severity:"INFO",reason:"VERIFIED",
      message:"The Coordinator reports verified completion.",
    };
  }
  return {
    type:"HEARTBEAT",severity:"INFO",reason:"ACTIVE",
    message:"Orchestration is active; no new intervention is reported.",
  };
}

/**
 * Observes only structured status. Never reads or emits tool payloads,
 * prompts, credentials, paths, raw errors, approval parameters or logs.
 * This is an output-only notification sink: it cannot change permissions.
 */
export function createHeartbeatNotifier({
  stateFile, notify=()=>{}, now=Date.now,
  heartbeatMs=60000, repeatMs=900000, stallMs=120000,
}={}){
  if(typeof stateFile!=="string"||!stateFile.trim()
    ||typeof notify!=="function"||typeof now!=="function"
    ||![heartbeatMs,repeatMs,stallMs].every(x=>
      Number.isSafeInteger(x)&&x>=1000&&x<=86400000)){
    throw error("HEARTBEAT_OPTIONS_INVALID","Invalid heartbeat notifier configuration");
  }
  const file=path.resolve(stateFile)+".notifications.json";
  let pending=Promise.resolve();
  async function process(observation){
    const instant=now();
    if(!Number.isSafeInteger(instant)||instant<0){
      throw error("HEARTBEAT_CLOCK_INVALID","Invalid heartbeat clock");
    }
    const event=pick(observation,instant,stallMs);
    const history=(await read(file))??{
      schema:SCHEMA,recent:[],lastFingerprint:null,lastHeartbeatAt:null,
    };
    const fingerprint=event.type+":"+event.reason;
    const previous=history.recent.find(x=>x.fingerprint===fingerprint);
    const lastHeartbeat=Number.isSafeInteger(history.lastHeartbeatAt)
      ?history.lastHeartbeatAt:null;
    const due=event.type==="HEARTBEAT"
      ?lastHeartbeat===null||instant-lastHeartbeat>=heartbeatMs
      :!previous||instant-previous.at>=repeatMs;
    if(!due)return null;
    const safe={
      type:event.type,severity:event.severity,reason:event.reason,
      message:event.message,at:new Date(instant).toISOString(),
    };
    // Persist before delivery. Lost delivery is safer than flood/replay after
    // a crash; the callback is deliberately only a notification sink.
    history.recent=[
      {fingerprint,at:instant},
      ...history.recent.filter(x=>x.fingerprint!==fingerprint),
    ].slice(0,MAX_HISTORY);
    history.lastFingerprint=fingerprint;
    if(event.type==="HEARTBEAT")history.lastHeartbeatAt=instant;
    await persist(file,history);
    await notify(safe);
    return safe;
  }
  return {
    file,
    observe(observation){
      const next=pending.catch(()=>{}).then(()=>process(observation));
      pending=next;
      return next;
    },
  };
}
