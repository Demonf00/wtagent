#!/usr/bin/env node
// SU-01: trusted-code entrypoint. Runs committed candidates in disposable
// detached Git worktrees; never installs, switches, promotes, or restarts the
// trusted running Supervisor. A worktree is NOT an OS security sandbox.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {CHECKS,runProgram,SOURCE_ROOT} from "./verify-pr.js";

const SHA=/^[0-9a-f]{40}$/;
const OPT_IN="<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->";
export const SKIPPED_LIVE_CHECKS=Object.freeze([
  "live-browser-provider",
  "interactive-approval",
  "external-service-smoke",
]);
function fail(code){return Object.assign(new Error(code),{code});}
function assertSuccess(result,label){
  if(result?.code!==0)throw fail(label+"_FAILED");
  return result.stdout.trim();
}
function safeChecks(checks){
  if(!Array.isArray(checks)||checks.length<1||checks.length>30)
    throw fail("CHECKS_INVALID");
  const seen=new Set();
  return checks.map(step=>{
    if(!step||typeof step!=="object"||
      typeof step.name!=="string"||
      !/^[a-z][a-z0-9-]{0,63}$/.test(step.name)||
      seen.has(step.name)||
      !["npm","node"].includes(step.program)||
      !Array.isArray(step.args)||step.args.length<1||step.args.length>32||
      step.args.some(arg=>typeof arg!=="string"||arg.length>2048||
        /[\x00-\x1f]/.test(arg)))
      throw fail("CHECKS_INVALID");
    seen.add(step.name);
    return {name:step.name,program:step.program,args:[...step.args]};
  });
}
function countsFor(result){
  const output=(result.stdout??"")+"\n"+(result.stderr??"");
  const counts={tests:null,pass:null,fail:null,skipped:null};
  for(const line of output.split(/\r?\n/)){
    const m=line.match(/^\s*(?:#|ℹ)\s*(tests|pass|fail|skipped)\s+(\d+)\s*$/);
    if(m)counts[m[1]]=Number(m[2]);
  }
  return counts;
}
function within(candidate,root){
  const relative=path.relative(root,candidate);
  return !relative||(!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative));
}
export async function verifyCandidate({
  sha,root=SOURCE_ROOT,reportRoot=null,checks=CHECKS,
  run=runProgram,log=()=>{},
}={}){
  if(typeof sha!=="string"||!SHA.test(sha))throw fail("CANDIDATE_SHA_INVALID");
  if(typeof root!=="string"||!root.trim()||typeof run!=="function")
    throw fail("VERIFIER_OPTIONS_INVALID");
  const steps=safeChecks(checks);
  const trustedRoot=await fs.realpath(path.resolve(root));
  const marker=await fs.readFile(path.join(trustedRoot,"AGENTS.md"),"utf8");
  if(!marker.includes(OPT_IN))throw fail("TRUSTED_SOURCE_NOT_OPTED_IN");
  const gitRoot=assertSuccess(run("git",["rev-parse","--show-toplevel"],trustedRoot),
    "TRUSTED_REPOSITORY");
  if(path.resolve(gitRoot).toLowerCase()!==trustedRoot.toLowerCase())
    throw fail("TRUSTED_REPOSITORY_MISMATCH");
  const trustedSha=assertSuccess(run("git",["rev-parse","HEAD"],trustedRoot),
    "TRUSTED_SHA").toLowerCase();
  if(!SHA.test(trustedSha))throw fail("TRUSTED_SHA_INVALID");
  const objectType=assertSuccess(run("git",["cat-file","-t",sha],trustedRoot),
    "CANDIDATE_OBJECT");
  if(objectType!=="commit")throw fail("CANDIDATE_NOT_COMMIT");
  const target=path.resolve(reportRoot??path.join(
    process.env.APPDATA||os.tmpdir(),"wtagent","candidate-verifications"));
  await fs.mkdir(target,{recursive:true});
  const realReportRoot=await fs.realpath(target);
  if(within(realReportRoot,trustedRoot))throw fail("REPORT_ROOT_WITHIN_TRUSTED_SOURCE");
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"wtagent-candidate-"));
  const worktree=path.join(temp,"candidate");
  const report={
    schema:1,
    trustedSha,candidateSha:sha,
    source:"local-commit",
    startedAt:new Date().toISOString(),
    platform:process.platform,node:process.version,
    status:"FAILED",ok:false,steps:[],
    skippedLiveChecks:[...SKIPPED_LIVE_CHECKS],
    candidatePromoted:false,trustedRuntimeModified:false,
    error:null,cleanupError:null,
  };
  let attached=false;
  try{
    assertSuccess(run("git",["worktree","add","--detach",worktree,sha],
      trustedRoot),"WORKTREE_ADD");
    attached=true;
    const actual=assertSuccess(run("git",["rev-parse","HEAD"],worktree),
      "CANDIDATE_HEAD").toLowerCase();
    if(actual!==sha){
      report.error="CANDIDATE_SHA_MISMATCH";
    }else{
      for(const step of steps){
        log("[candidate] "+step.name+" "+sha.slice(0,12));
        let result;
        try{result=run(step.program,step.args,worktree);}
        catch{result={code:-1,stdout:"",stderr:""};}
        const counts=countsFor(result);
        const ok=result.code===0&&counts.fail!==0;
        report.steps.push({name:step.name,
          exitCode:Number.isSafeInteger(result.code)?result.code:-1,
          ...counts,ok});
        if(!ok){
          report.error="CHECK_FAILED:"+step.name;
          break;
        }
      }
      if(!report.error&&report.steps.length===steps.length){
        report.status="PASSED_WITH_LIVE_CHECKS_SKIPPED";
        report.ok=true;
      }
    }
  }catch(error){
    report.error=error.code??"VERIFICATION_FAILED";
  }finally{
    if(attached){
      const removed=run("git",["worktree","remove","--force",worktree],trustedRoot);
      if(removed.code!==0){
        report.cleanupError="WORKTREE_REMOVE_FAILED";
        report.ok=false;
        report.status="FAILED";
      }
    }
    if(!attached||!report.cleanupError){
      await fs.rm(temp,{recursive:true,force:true}).catch(()=>{
        report.cleanupError="TEMP_CLEANUP_FAILED";
        report.ok=false;
        report.status="FAILED";
      });
    }
    const current=run("git",["rev-parse","HEAD"],trustedRoot);
    if(current.code!==0||current.stdout.trim().toLowerCase()!==trustedSha){
      report.trustedRuntimeModified=true;
      report.ok=false;
      report.status="FAILED";
      report.error??="TRUSTED_HEAD_CHANGED";
    }
    report.finishedAt=new Date().toISOString();
    report.reportPath=path.join(realReportRoot,
      "candidate-"+sha.slice(0,12)+"-"+randomUUID()+".json");
    await fs.writeFile(report.reportPath,
      JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
    log("[candidate] "+(report.ok?"PASS":"FAIL")+
      " trusted="+trustedSha+" candidate="+sha);
    log("[candidate] report="+report.reportPath);
  }
  return report;
}
export function parseCandidateArgs(argv){
  let sha=null;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==="--sha"&&sha===null){
      sha=argv[++i];
    }else throw fail("VERIFIER_ARGS_INVALID");
  }
  if(!SHA.test(sha??""))throw fail("CANDIDATE_SHA_INVALID");
  return {sha};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const options=parseCandidateArgs(process.argv.slice(2));
    const result=await verifyCandidate({...options,log:console.log});
    process.exitCode=result.ok?0:1;
  }catch(error){
    console.error("[candidate] "+(error.code??"VERIFICATION_FAILED"));
    process.exitCode=1;
  }
}
