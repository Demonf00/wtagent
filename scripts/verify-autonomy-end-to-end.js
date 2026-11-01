#!/usr/bin/env node
// SU-03 trusted verification driver. Runs genuine Node integration tests;
// independently verifies roadmap Git commit ancestry; emits local evidence.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
const requiredIds=["FV-06","FR-04","DP-03","CM-03","OB-03","SU-01","SU-02"];
const tests=[
  "test/autonomy-end-to-end-delivery.test.js",
  "test/autonomy-cli.test.js",
  "test/autonomy-repair-execution.test.js",
  "test/autonomy-supervisor-integration.test.js",
  "test/autonomy-goal-delivery.test.js",
  "test/delivery-report.test.js",
  "test/verify-candidate.test.js",
  "test/self-upgrade-gates.test.js",
];
const sentinels={
  "unified-real-e2e":"SU-03 real supervised DAG: replan, injected failure, repair, restart and evidence-backed delivery",
  "real-conversation-rotation":"CM-03 actual autonomy resume continues dependent tasks only after valid conversation handoff",
  "crash-idempotent-repair":"FR-04 crash after Supervisor submission reuses durable key and never repeats side effects",
  "real-supervisor-replan":"DP-03 real Supervisor resumes a revised four-stage DAG across restarts",
  "real-final-verifier":"FV-06 real final test produces DELIVERED receipt and resumes read-only",
  "false-success-rejected":"OB-03 cannot infer delivery from model prose, status or fake receipts",
  "broken-candidate-rejected":"SU-01 deliberately broken candidate fails without touching known-good runtime",
  "approval-gated-promotion":"SU-02 requires explicit exact-SHA confirmation for promote and rollback",
};
const shaPattern=/^[0-9a-f]{40}$/;
function git(args){
  const result=spawnSync("git",args,{cwd:root,encoding:"utf8",
    timeout:30000,maxBuffer:1024*1024});
  if(result.status!==0||result.error)
    throw new Error("Git evidence unavailable: "+args[0]);
  return result.stdout.trim();
}
function count(output,name){
  const expression=new RegExp("^\\s*(?:#|ℹ)\\s*"+name+"\\s+(\\d+)\\s*$","m");
  const match=expression.exec(output);
  return match?Number(match[1]):null;
}
export function validateRoadmapEvidence(roadmap,{gitCommand=git}={}){
  if(!roadmap||!Array.isArray(roadmap.tasks))
    throw new Error("ROADMAP_MISSING");
  const entries=roadmap.tasks.filter(t=>t.status==="VERIFIED");
  if(entries.length<27)throw new Error("ROADMAP_NOT_FULLY_VERIFIED");
  const seen=new Set(),proof=[];
  for(const item of entries){
    if(typeof item.id!=="string"||!shaPattern.test(item.commitSha??"")||
      seen.has(item.commitSha)||!item.testEvidence)
      throw new Error("ROADMAP_PROVENANCE_INVALID:"+item.id);
    if(gitCommand(["cat-file","-t",item.commitSha])!=="commit")
      throw new Error("ROADMAP_NOT_A_COMMIT:"+item.id);
    gitCommand(["merge-base","--is-ancestor",item.commitSha,"HEAD"]);
    seen.add(item.commitSha);
    proof.push({id:item.id,sha:item.commitSha,
      evidence:item.testEvidence});
  }
  for(const id of requiredIds)if(!proof.some(x=>x.id===id))
    throw new Error("REQUIRED_PHASE_NOT_VERIFIED:"+id);
  return proof;
}
export function parseTestEvidence(output,expected=sentinels){
  if(typeof output!=="string")throw new Error("TEST_OUTPUT_INVALID");
  const counts={tests:count(output,"tests"),pass:count(output,"pass"),
    fail:count(output,"fail"),skipped:count(output,"skipped")};
  if(!Number.isSafeInteger(counts.tests)||counts.tests<8||
    !Number.isSafeInteger(counts.pass)||counts.pass<8||
    counts.fail!==0||counts.pass+counts.skipped!==counts.tests)
    throw new Error("TEST_SUITE_UNVERIFIED");
  const lines=output.split(/\r?\n/);
  const phases={};
  for(const [phase,title] of Object.entries(expected)){
    const seen=lines.some(line=>{
      const clean=line.trim();
      return (clean.startsWith("✔ ")||/^ok\s+\d+\s+-\s+/.test(clean))&&
        clean.includes(title)&&!clean.includes("# SKIP");
    });
    if(!seen)throw new Error("TEST_PHASE_UNVERIFIED:"+phase);
    phases[phase]={testTitle:title,passed:true};
  }
  return {counts,phases};
}
export async function runFinalRegression({writeReport=true}={}){
  const plan=JSON.parse(await fs.readFile(path.join(root,
    "docs/autonomy-roadmap.json"),"utf8"));
  const commits=validateRoadmapEvidence(plan);
  const startedAt=new Date().toISOString();
  const result=spawnSync(process.execPath,["--test",...tests],{
    cwd:root,encoding:"utf8",timeout:140000,maxBuffer:24*1024*1024,
    env:{...process.env,NO_COLOR:"1"},
  });
  if(result.error||result.status!==0)
    throw new Error("SU03_REGRESSION_PROCESS_FAILED: "+
      (result.error?.message??String(result.status)));
  const details=parseTestEvidence(result.stdout??"");
  const report={
    schema:1,kind:"WTAGENT_AUTONOMY_END_TO_END",
    startedAt,finishedAt:new Date().toISOString(),
    sourceSha:git(["rev-parse","HEAD"]),checks:details,
    commits,verifiedCommitCount:commits.length,
    scenarioScope:{
      unified:"Real Supervisor DAG, replan, injected missing artifact, repair, restart, final behavioral test, verified delivery receipt",
      separateRealIntegration:"Persisted conversation rotation handoff and safe dependent-task resume",
      limitation:"This is a simulated local integration, not a live browser-provider or production deployment test",
    },
    ok:true,
  };
  if(writeReport){
    const location=path.join(os.tmpdir(),
      "wtagent-su03-evidence-"+randomUUID()+".json");
    await fs.writeFile(location,JSON.stringify(report,null,2)+"\n",
      {flag:"wx",mode:0o600});
    report.reportPath=location;
  }
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runFinalRegression().then(report=>{
    console.log(JSON.stringify({
      ok:report.ok,sourceSha:report.sourceSha,
      verifiedCommitCount:report.verifiedCommitCount,
      counts:report.checks.counts,
      phases:Object.keys(report.checks.phases),
      reportPath:report.reportPath,
    },null,2));
  }).catch(error=>{
    console.error("[SU-03] "+error.message);
    process.exitCode=1;
  });
}
