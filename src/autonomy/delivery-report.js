import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {assertVerificationReceipt} from "./verification-receipt.js";
import {assertGoalReceipt} from "./goal-delivery.js";

const TASK_ID=/^[a-zA-Z0-9_-]{1,64}$/;
const WORKER_ID=/^task_[a-f0-9-]{36}$/;
const SHA256=/^[a-f0-9]{64}$/;
const GIT_SHA=/^[a-f0-9]{40}$/;
const SUPERVISOR_STATES=new Set([
  "queued","running","recovering","waiting_retry","waiting_approval",
  "pausing","paused","blocked_uncertain","completed","failed",
  "cancelled","cancelling","interrupted",
]);
function failure(code){return Object.assign(new Error(code),{code});}
async function regularJson(file,optional=false){
  let stat;
  try{stat=await fs.lstat(file);}
  catch(e){if(optional&&e.code==="ENOENT")return null;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)
    throw failure("DELIVERY_REPORT_UNSAFE");
  try{return JSON.parse(await fs.readFile(file,"utf8"));}
  catch{throw failure("DELIVERY_REPORT_INVALID_JSON");}
}
async function inspectFile(root,check){
  if(typeof check.path!=="string"||!check.path||
    path.isAbsolute(check.path)||check.path.includes("\\")||
    check.path.split("/").some(p=>!p||p==="."||p===".."))
    return {present:false,reason:"ARTIFACT_PATH_UNSAFE"};
  let cursor=root;
  try{
    for(const component of check.path.split("/")){
      cursor=path.join(cursor,component);
      const stat=await fs.lstat(cursor);
      if(stat.isSymbolicLink())return {present:false,reason:"ARTIFACT_SYMLINK"};
    }
    const stat=await fs.lstat(cursor);
    if(!stat.isFile()||stat.size<(check.minBytes??1))
      return {present:false,reason:"ARTIFACT_MISSING_OR_TOO_SMALL"};
    if(check.sha256){
      if(!SHA256.test(check.sha256))return {present:false,reason:"ARTIFACT_HASH_UNSAFE"};
      const hash=createHash("sha256");
      for await(const chunk of createReadStream(cursor))hash.update(chunk);
      if(hash.digest("hex")!==check.sha256)
        return {present:false,reason:"ARTIFACT_HASH_MISMATCH"};
    }
    return {present:true,size:stat.size,
      integrity:check.sha256?"SHA256_MATCH":"PRESENT_SIZE_ONLY"};
  }catch(error){
    if(error.code==="ENOENT"||error.code==="ENOTDIR")
      return {present:false,reason:"ARTIFACT_MISSING"};
    return {present:false,reason:"ARTIFACT_NOT_READABLE"};
  }
}
async function supervisorStatus(stateFile,task){
  if(!WORKER_ID.test(task.supervisorTaskId??""))return "NOT_RECORDED";
  const filename=path.join(stateFile+".supervisor",task.supervisorTaskId+".json");
  try{
    const worker=await regularJson(filename,true);
    if(!worker)return "UNKNOWN";
    if(worker.taskId!==task.supervisorTaskId||!SUPERVISOR_STATES.has(worker.status))
      return "UNKNOWN";
    if(worker.status==="waiting_approval"&&worker.pendingApproval)
      return "APPROVAL_REQUIRED";
    if(worker.status==="waiting_approval")return "UNKNOWN";
    return "NO_PENDING_APPROVAL";
  }catch{return "UNKNOWN";}
}
function receiptValid(state,task){
  if(task.status!=="VERIFIED"||!task.verificationReceipt||!Array.isArray(task.evidence))
    return false;
  try{assertVerificationReceipt(state,task);return true;}
  catch{return false;}
}
function goalReceiptValid(state){
  try{assertGoalReceipt(state);return true;}
  catch{return false;}
}
function commitFromReceipt(receipt){
  const value=receipt?.commitSha??receipt?.commit;
  return typeof value==="string"&&GIT_SHA.test(value)?value:null;
}
function checkDescription(check,index){
  const kind=["file","command","test","integration"].includes(check?.kind)
    ?check.kind:"unknown";
  return {index,kind,...(kind==="file"&&typeof check.path==="string"
    ?{path:check.path}: {})};
}
function unmet(target,kind,index,reason){
  return {target,kind,index,reason};
}
/**
 * Report historical receipt validity and read-only current file observations.
 * Does not execute tools, rerun tests, modify the workspace, or treat model
 * prose/Worker completion messages as evidence of acceptance.
 */
export async function readEvidenceDeliveryReport({stateFile,workspaceRoot}={}){
  if(typeof stateFile!=="string"||!stateFile.trim()||
    typeof workspaceRoot!=="string"||!workspaceRoot.trim())
    throw failure("DELIVERY_REPORT_OPTIONS_INVALID");
  const root=await fs.realpath(path.resolve(workspaceRoot));
  const checkpoint=path.resolve(stateFile);
  if(checkpoint===root||checkpoint.startsWith(root+path.sep))
    throw failure("DELIVERY_REPORT_UNSAFE");
  const state=await regularJson(checkpoint);
  if(!state||![1,2].includes(state.schema)||state.workspaceRoot!==root
    ||typeof state.goal!=="string"||!Array.isArray(state.tasks)
    ||state.tasks.length<1||state.tasks.length>256
    ||typeof state.planId!=="string"||!/^[a-f0-9-]{36}$/.test(state.planId))
    throw failure("DELIVERY_REPORT_STATE_UNSAFE");
  if(state.tasks.some(task=>!TASK_ID.test(task?.id??"")||
    !Array.isArray(task.acceptance)||task.acceptance.length>16))
    throw failure("DELIVERY_REPORT_STATE_UNSAFE");
  const unmetRequirements=[];
  const approvals=[];
  const commits=new Set();
  const limitations=[
    "Historical test and integration evidence was not rerun.",
    "Verification receipts are consistency digests, not digital signatures.",
  ];
  const tasks=[];
  for(const task of state.tasks){
    const verified=receiptValid(state,task);
    const approval=await supervisorStatus(checkpoint,task);
    if(approval==="APPROVAL_REQUIRED"){
      approvals.push({taskId:task.id,status:approval});
      unmetRequirements.push(unmet(task.id,"approval",null,"HUMAN_APPROVAL_REQUIRED"));
    }else if(approval==="UNKNOWN"){
      approvals.push({taskId:task.id,status:approval});
      limitations.push("Supervisor approval state unavailable for task "+task.id+".");
    }
    const commit=verified?commitFromReceipt(task.verificationReceipt):null;
    if(commit)commits.add(commit);
    const checks=[];
    for(const [index,check] of task.acceptance.entries()){
      const evidence=verified&&task.evidence?.[index]!=null;
      const current=check?.kind==="file"?await inspectFile(root,check):null;
      const historical=evidence?"EVIDENCED":"NOT_EVIDENCED";
      const fresh=check?.kind==="file"?
        current.present?"OBSERVED":"UNMET":"NOT_RERUN";
      const satisfied=evidence&&(current===null||current.present);
      const reason=!evidence?"MISSING_VERIFIED_RECEIPT":
        current&&!current.present?current.reason:null;
      if(!satisfied)unmetRequirements.push(unmet(task.id,check?.kind??"unknown",index,reason));
      checks.push({...checkDescription(check,index),historical,current:fresh,
        ...(current?{artifact:current}:{}),
        satisfied});
    }
    tasks.push({id:task.id,status:task.status,receiptValid:verified,
      receiptDigest:verified?task.verificationReceipt.digest:null,
      approval,commit,checks});
  }
  const delivery=state.goalDelivery??null;
  const finals=Array.isArray(delivery?.acceptance)?delivery.acceptance:[];
  const goalVerified=state.status==="VERIFIED"&&
    delivery?.status==="DELIVERED"&&goalReceiptValid(state);
  const finalAcceptance=[];
  if(finals.length===0){
    unmetRequirements.push(unmet("goal","finalAcceptance",null,
      "FINAL_ACCEPTANCE_NOT_DEFINED"));
  }
  for(const [index,check] of finals.entries()){
    const evidenced=goalVerified&&delivery.evidence?.[index]!=null;
    if(!evidenced)unmetRequirements.push(unmet("goal",check?.kind??"unknown",
      index,"MISSING_GOAL_DELIVERY_RECEIPT"));
    finalAcceptance.push({...checkDescription(check,index),
      historical:evidenced?"EVIDENCED":"NOT_EVIDENCED",
      current:"NOT_RERUN",satisfied:Boolean(evidenced)});
  }
  if(commits.size===0)
    limitations.push("No independently attributable Git commit hash in verified receipts.");
  if(tasks.some(task=>task.checks.some(check=>check.artifact?.integrity==="PRESENT_SIZE_ONLY")))
    limitations.push("File existence and size do not prove content is unchanged.");
  const delivered=goalVerified&&unmetRequirements.length===0&&
    approvals.every(entry=>entry.status!=="APPROVAL_REQUIRED");
  const body={
    schema:1,planId:state.planId,goal:state.goal,
    coordinatorStatus:typeof state.status==="string"?state.status:"UNKNOWN",
    deliveryStatus:delivered?"DELIVERED":"NOT_VERIFIED",
    evidenceFreshness:"CHECKPOINT_RECEIPTS_WITH_READ_ONLY_FILE_OBSERVATIONS",
    tasks,finalAcceptance,commits:[...commits].sort(),
    approvals,unmetRequirements,limitations:[...new Set(limitations)],
  };
  return {...body,reportDigest:createHash("sha256")
    .update(JSON.stringify(body)).digest("hex")};
}
