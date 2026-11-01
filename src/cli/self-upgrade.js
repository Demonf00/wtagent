// Trusted-source, approval-gated candidate registry. This only changes a
// recorded version pointer; it never installs, merges, publishes or restarts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {verifyCandidate} from "../../scripts/verify-candidate.js";

const SHA=/^[0-9a-f]{40}$/;
const REQUIRED=["install","syntax","supervisor-regression","all-tests","package-dry-run"];
const digest=data=>createHash("sha256").update(data).digest("hex");
const error=code=>Object.assign(new Error(code),{code});
const defaultRoot=()=>path.join(process.env.LOCALAPPDATA||process.env.APPDATA||
  os.homedir(),"WTAgent","upgrade-registry");
const blank=()=>({schema:1,active:null,previous:null,candidates:[],events:[]});
function git(root,args,binary=false){
 const r=spawnSync("git",args,{cwd:root,encoding:binary?null:"utf8",
   timeout:30000,maxBuffer:64*1024*1024});
 if(r.status!==0||r.error)throw error("GIT_OPERATION_FAILED");
 return binary?r.stdout:r.stdout.trim();
}
function safeSha(sha){
 if(typeof sha!=="string"||!SHA.test(sha))throw error("SHA_REQUIRED");
 return sha;
}
function contained(child,parent){
 const relative=path.relative(parent,child);
 return relative===""||(!relative.startsWith(".."+path.sep)&&
   relative!==".."&&!path.isAbsolute(relative));
}
async function context(sourceRoot,stateRoot){
 const source=await fs.realpath(path.resolve(sourceRoot));
 const actual=git(source,["rev-parse","--show-toplevel"]);
 if(path.resolve(actual).toLowerCase()!==source.toLowerCase())
   throw error("TRUSTED_REPO_REQUIRED");
 const dir=path.resolve(stateRoot??defaultRoot());
 if(contained(dir,source)||contained(source,dir))throw error("REGISTRY_PATH_UNSAFE");
 await fs.mkdir(dir,{recursive:true});
 const registry=await fs.realpath(dir);
 if(contained(registry,source)||contained(source,registry))throw error("REGISTRY_PATH_UNSAFE");
 return {source,registry};
}
async function load(dir){
 let data;
 try{data=JSON.parse(await fs.readFile(path.join(dir,"registry.json"),"utf8"));}
 catch(e){if(e.code==="ENOENT")return blank();throw error("REGISTRY_INVALID");}
 if(data?.schema!==1||!Array.isArray(data.candidates)||
   !Array.isArray(data.events)||data.events.length>10000)
   throw error("REGISTRY_INVALID");
 return data;
}
async function save(dir,data){
 const tmp=path.join(dir,".registry-"+randomUUID()+".json");
 await fs.writeFile(tmp,JSON.stringify(data,null,2)+"\n",{flag:"wx",mode:0o600});
 try{await fs.rename(tmp,path.join(dir,"registry.json"));}
 finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
}
async function archive(source,dir,sha){
 safeSha(sha);
 if(git(source,["cat-file","-t",sha])!=="commit")throw error("NOT_A_COMMIT");
 const bytes=git(source,["archive","--format=tar",sha],true);
 if(!Buffer.isBuffer(bytes)||bytes.length===0)throw error("ARCHIVE_INVALID");
 const hash=digest(bytes);
 const rel="artifacts/"+sha+".tar";
 const filename=path.join(dir,rel);
 await fs.mkdir(path.dirname(filename),{recursive:true});
 try{await fs.writeFile(filename,bytes,{flag:"wx",mode:0o600});}
 catch(e){if(e.code!=="EEXIST")throw e;}
 if(digest(await fs.readFile(filename))!==hash)
   throw error("ARCHIVE_HASH_MISMATCH");
 return {sha,sha256:hash,relativePath:rel};
}
async function verifyArchive(dir,record){
 if(!record||!SHA.test(record.sha)||!/^[a-f0-9]{64}$/.test(record.sha256)||
   record.relativePath!=="artifacts/"+record.sha+".tar")
   throw error("ARTIFACT_RECORD_INVALID");
 const file=path.join(dir,record.relativePath);
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||
   digest(await fs.readFile(file))!==record.sha256)
   throw error("ARTIFACT_HASH_MISMATCH");
}
function event(state,action,sha,details={}){
 state.events.push({action,sha,...details,at:new Date().toISOString()});
}
function validReport(report){
 return report?.schema===1&&report.ok===true&&
  report.status==="PASSED_WITH_LIVE_CHECKS_SKIPPED"&&
  report.source==="local-commit"&&
  SHA.test(report.candidateSha??"")&&SHA.test(report.trustedSha??"")&&
  !report.error&&!report.cleanupError&&
  report.trustedRuntimeModified===false&&
  report.candidatePromoted===false&&
  Array.isArray(report.skippedLiveChecks)&&
  report.skippedLiveChecks.length>0&&
  Array.isArray(report.steps)&&report.steps.length===REQUIRED.length&&
  REQUIRED.every((name,i)=>report.steps[i]?.name===name&&
    report.steps[i].ok===true&&report.steps[i].exitCode===0&&
    (report.steps[i].fail??0)===0)&&
  ["supervisor-regression","all-tests"].every(name=>{
    const step=report.steps.find(x=>x.name===name);
    return Number.isSafeInteger(step?.tests)&&step.tests>0&&
      Number.isSafeInteger(step?.pass)&&step.pass>0;
  });
}
async function approved(approve,sha,operation){
 if(typeof approve!=="function"||
   await approve({sha,operation})!==sha)
   throw error("EXPLICIT_HUMAN_APPROVAL_REQUIRED");
}
export async function stageCandidate({
 sourceRoot=process.cwd(),stateRoot=null,reportPath,
 reverify=verifyCandidate,
}={}){
 const {source,registry}=await context(sourceRoot,stateRoot);
 if(typeof reportPath!=="string"||!reportPath)throw error("REPORT_REQUIRED");
 const file=path.resolve(reportPath);
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)
   throw error("REPORT_INVALID");
 const bytes=await fs.readFile(file);
 let report;
 try{report=JSON.parse(bytes.toString("utf8"));}
 catch{throw error("REPORT_INVALID");}
 const sha=safeSha(report.candidateSha);
 const trustedSha=safeSha(report.trustedSha);
 if(!validReport(report))throw error("VERIFICATION_INCOMPLETE");
 if(git(source,["rev-parse","HEAD"])!==trustedSha)
   throw error("TRUSTED_BASELINE_CHANGED");
 const state=await load(registry);
 // The supplied JSON is not an authority. Re-run the actual candidate with
 // trusted verifier code; only newly observed evidence authorizes staging.
 const fresh=await reverify({
   sha,root:source,reportRoot:path.join(registry,"verification-runs"),
 });
 if(!validReport(fresh)||fresh.candidateSha!==sha||
   fresh.trustedSha!==trustedSha)
   throw error("CANDIDATE_REVERIFICATION_FAILED");
 if(git(source,["rev-parse","HEAD"])!==trustedSha)
   throw error("TRUSTED_BASELINE_CHANGED");
 if(state.candidates.some(item=>item.candidateSha===sha))
   throw error("CANDIDATE_ALREADY_STAGED");
 const candidate=await archive(source,registry,sha);
 const baseline=await archive(source,registry,trustedSha);
 const entry={candidateSha:sha,trustedSha,
   verificationReportSha256:digest(bytes),freshVerificationReportSha256:digest(Buffer.from(JSON.stringify(fresh))),candidate,baseline,
   stagedAt:new Date().toISOString()};
 state.candidates.push(entry);
 event(state,"STAGE",sha,{artifactSha256:candidate.sha256,
   verificationReportSha256:entry.verificationReportSha256});
 await save(registry,state);
 return entry;
}
export async function readUpgradeState({
 sourceRoot=process.cwd(),stateRoot=null,
}={}){
 const {registry}=await context(sourceRoot,stateRoot);
 return load(registry);
}
export async function promoteCandidate({
 sourceRoot=process.cwd(),stateRoot=null,sha,approve,
}={}){
 safeSha(sha);
 const {registry}=await context(sourceRoot,stateRoot);
 const state=await load(registry);
 const item=state.candidates.find(c=>c.candidateSha===sha);
 if(!item)throw error("CANDIDATE_NOT_STAGED");
 const from=state.active??item.baseline;
 if(from.sha!==item.trustedSha)throw error("PROMOTION_LINEAGE_MISMATCH");
 await verifyArchive(registry,from);
 await verifyArchive(registry,item.candidate);
 await approved(approve,sha,"promote");
 // Revalidate after the human approval, before committing the pointer.
 await verifyArchive(registry,item.candidate);
 state.previous=from;
 state.active=item.candidate;
 event(state,"PROMOTE",sha,{priorSha:from.sha,
   priorArtifactSha256:from.sha256,artifactSha256:item.candidate.sha256});
 await save(registry,state);
 return {active:state.active,previous:state.previous,
   recordedOnly:true,runtimeRestarted:false,globallyInstalled:false};
}
export async function rollbackCandidate({
 sourceRoot=process.cwd(),stateRoot=null,approve,
}={}){
 const {registry}=await context(sourceRoot,stateRoot);
 const state=await load(registry);
 if(!state.active||!state.previous)throw error("ROLLBACK_UNAVAILABLE");
 await verifyArchive(registry,state.previous);
 await verifyArchive(registry,state.active);
 await approved(approve,state.previous.sha,"rollback");
 await verifyArchive(registry,state.previous);
 const previous=state.active;
 state.active=state.previous;
 state.previous=previous;
 event(state,"ROLLBACK",state.active.sha,{fromSha:previous.sha,
   artifactSha256:state.active.sha256});
 await save(registry,state);
 return {active:state.active,previous:state.previous,
   recordedOnly:true,runtimeRestarted:false,globallyInstalled:false};
}
