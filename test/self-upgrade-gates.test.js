import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  stageCandidate,readUpgradeState,promoteCandidate,rollbackCandidate,
} from "../src/cli/self-upgrade.js";
function git(root,...args){
  return execFileSync("git",args,{cwd:root,encoding:"utf8",timeout:15000}).trim();
}
async function fixture(t){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"wtagent-su02-"));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const root=path.join(home,"trusted"),registry=path.join(home,"registry");
  await fs.mkdir(root);
  git(root,"init");
  git(root,"config","user.name","WTAgent Test");
  git(root,"config","user.email","wtagent@example.invalid");
  await fs.writeFile(path.join(root,"AGENTS.md"),
    "<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->\n");
  await fs.writeFile(path.join(root,"sample.js"),"export const value=1;\n");
  git(root,"add",".");
  git(root,"commit","-m","known-good");
  const trustedSha=git(root,"rev-parse","HEAD");
  git(root,"checkout","-b","candidate");
  await fs.writeFile(path.join(root,"sample.js"),"export const value=2;\n");
  git(root,"add",".");
  git(root,"commit","-m","candidate");
  const candidateSha=git(root,"rev-parse","HEAD");
  git(root,"checkout","-b","trusted",trustedSha);
  const checks=["install","syntax","supervisor-regression","all-tests","package-dry-run"];
  const report={
    schema:1,ok:true,status:"PASSED_WITH_LIVE_CHECKS_SKIPPED",
    source:"local-commit",candidateSha,trustedSha,
    error:null,cleanupError:null,
    trustedRuntimeModified:false,candidatePromoted:false,
    skippedLiveChecks:["live-browser-provider"],
    steps:checks.map(name=>({name,exitCode:0,ok:true,
      tests:name==="all-tests"||name==="supervisor-regression"?1:null,
      pass:name==="all-tests"||name==="supervisor-regression"?1:null,
      fail:0,skipped:0})),
  };
  const reportPath=path.join(home,"verification.json");
  await fs.writeFile(reportPath,JSON.stringify(report));
  const options={sourceRoot:root,stateRoot:registry};
  return {home,root,registry,reportPath,report,trustedSha,candidateSha,options};
}
async function staged(t){
  const f=await fixture(t);
  const calls=[];
  const result=await stageCandidate({...f.options,reportPath:f.reportPath,
    reverify:async opts=>{calls.push(opts);return {...f.report};}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].sha,f.candidateSha);
  assert.equal(result.candidateSha,f.candidateSha);
  assert.equal(result.trustedSha,f.trustedSha);
  assert.match(result.candidate.sha256,/^[a-f0-9]{64}$/);
  assert.match(result.baseline.sha256,/^[a-f0-9]{64}$/);
  assert.notEqual(result.candidate.sha256,result.baseline.sha256);
  assert.equal(git(f.root,"rev-parse","HEAD"),f.trustedSha);
  return {...f,stage:result};
}
test("SU-02 staging rechecks committed SHA and preserves exact rollback artifact",async t=>{
  const f=await staged(t);
  const state=await readUpgradeState(f.options);
  assert.equal(state.candidates.length,1);
  assert.equal(state.events[0].action,"STAGE");
  assert.equal(state.active,null);
  assert.equal(state.candidates[0].candidate.sha,f.candidateSha);
  assert.equal(state.candidates[0].baseline.sha,f.trustedSha);
  const promoted=await promoteCandidate({...f.options,sha:f.candidateSha,
    approve:async({sha,operation})=>{
      assert.equal(operation,"promote");return sha;
    }});
  assert.equal(promoted.recordedOnly,true);
  assert.equal(promoted.globallyInstalled,false);
  assert.equal(promoted.runtimeRestarted,false);
  assert.equal(promoted.active.sha,f.candidateSha);
  assert.deepEqual(promoted.previous,f.stage.baseline);
  const rolled=await rollbackCandidate({...f.options,
    approve:async({sha,operation})=>{
      assert.equal(operation,"rollback");return sha;
    }});
  assert.equal(rolled.active.sha,f.trustedSha);
  assert.equal(rolled.active.sha256,f.stage.baseline.sha256);
  assert.equal(rolled.previous.sha,f.candidateSha);
  assert.deepEqual((await readUpgradeState(f.options)).events.map(x=>x.action),
    ["STAGE","PROMOTE","ROLLBACK"]);
  assert.equal(git(f.root,"rev-parse","HEAD"),f.trustedSha);
  assert.equal(git(f.root,"status","--porcelain"),"");
});
test("SU-02 requires explicit exact-SHA confirmation for promote and rollback",async t=>{
  const f=await staged(t);
  await assert.rejects(promoteCandidate({...f.options,sha:f.candidateSha}),
    {code:"EXPLICIT_HUMAN_APPROVAL_REQUIRED"});
  await assert.rejects(promoteCandidate({...f.options,sha:f.candidateSha,
    approve:async()=>f.candidateSha.slice(0,12)}),
    {code:"EXPLICIT_HUMAN_APPROVAL_REQUIRED"});
  assert.equal((await readUpgradeState(f.options)).active,null);
  await promoteCandidate({...f.options,sha:f.candidateSha,approve:async x=>x.sha});
  await assert.rejects(rollbackCandidate(f.options),
    {code:"EXPLICIT_HUMAN_APPROVAL_REQUIRED"});
  assert.equal((await readUpgradeState(f.options)).active.sha,f.candidateSha);
});
test("SU-02 tampered candidate or rollback tar is rejected before activation",async t=>{
  const f=await staged(t);
  const candidateFile=path.join(f.registry,f.stage.candidate.relativePath);
  await fs.appendFile(candidateFile,"tampered");
  await assert.rejects(promoteCandidate({...f.options,sha:f.candidateSha,
    approve:async x=>x.sha}),{code:"ARTIFACT_HASH_MISMATCH"});
  assert.equal((await readUpgradeState(f.options)).active,null);
  // Restore an untampered staged fixture for the rollback path.
  const g=await staged(t);
  await promoteCandidate({...g.options,sha:g.candidateSha,approve:async x=>x.sha});
  await fs.appendFile(path.join(g.registry,g.stage.baseline.relativePath),"tampered");
  await assert.rejects(rollbackCandidate({...g.options,approve:async x=>x.sha}),
    {code:"ARTIFACT_HASH_MISMATCH"});
  assert.equal((await readUpgradeState(g.options)).active.sha,g.candidateSha);
});
test("SU-02 failed independent re-verification cannot stage forged success",async t=>{
  const f=await fixture(t);
  await assert.rejects(stageCandidate({...f.options,reportPath:f.reportPath,
    reverify:async()=>({...f.report,ok:false})}),
    {code:"CANDIDATE_REVERIFICATION_FAILED"});
  await assert.rejects(stageCandidate({...f.options,reportPath:f.reportPath,
    reverify:async()=>({...f.report,candidateSha:f.trustedSha})}),
    {code:"CANDIDATE_REVERIFICATION_FAILED"});
  assert.deepEqual((await readUpgradeState(f.options)).candidates,[]);
});
test("SU-02 CLI exposes upgrade controls but cannot approve in non-TTY mode",async t=>{
  const cli=fileURLToPath(new URL("../src/cli/main.js",import.meta.url));
  const help=spawnSync(process.execPath,[cli,"autonomy","upgrade","--help"],
    {encoding:"utf8",timeout:30000});
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/promote/);
  assert.match(help.stdout,/rollback/);
  const blocked=spawnSync(process.execPath,[cli,"autonomy","upgrade","promote",
    "--sha","a".repeat(40)],{encoding:"utf8",timeout:30000});
  assert.notEqual(blocked.status,0);
  assert.match(blocked.stderr,/interactive terminal/i);
});
