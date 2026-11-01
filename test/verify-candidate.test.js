import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {verifyCandidate,SKIPPED_LIVE_CHECKS} from "../scripts/verify-candidate.js";

function git(root,...args){
  return execFileSync("git",args,{cwd:root,encoding:"utf8",timeout:15000}).trim();
}
async function fixture(t){
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),"wtagent-su01-"));
  t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  const root=path.join(outside,"trusted");
  const reports=path.join(outside,"reports");
  await fs.mkdir(root);
  git(root,"init");
  git(root,"config","user.name","WTAgent Tests");
  git(root,"config","user.email","wtagent@example.invalid");
  await fs.writeFile(path.join(root,"AGENTS.md"),
    "<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->\n");
  await fs.writeFile(path.join(root,"safe.js"),"export const value = 42;\n");
  await fs.writeFile(path.join(root,"package.json"),
    '{"name":"wtagent-candidate-fixture","private":true,"type":"module"}');
  git(root,"add",".");
  git(root,"commit","-m","trusted baseline");
  git(root,"checkout","-b","known-good");
  const trustedSha=git(root,"rev-parse","HEAD");
  git(root,"checkout","-b","broken-candidate");
  await fs.writeFile(path.join(root,"safe.js"),"export const value = ;\n");
  git(root,"add","safe.js");
  git(root,"commit","-m","broken syntax candidate");
  const brokenSha=git(root,"rev-parse","HEAD");
  git(root,"checkout","known-good");
  return {root,reports,trustedSha,brokenSha};
}
const check=[{name:"syntax",program:"node",args:["--check","safe.js"]}];

test("SU-01 deliberately broken candidate fails without touching known-good runtime",async t=>{
  const f=await fixture(t);
  const before=await fs.readFile(path.join(f.root,"safe.js"),"utf8");
  const result=await verifyCandidate({
    root:f.root,reportRoot:f.reports,sha:f.brokenSha,checks:check,
  });
  assert.equal(result.ok,false);
  assert.equal(result.error,"CHECK_FAILED:syntax");
  assert.equal(result.candidateSha,f.brokenSha);
  assert.equal(result.trustedSha,f.trustedSha);
  assert.equal(result.steps[0].ok,false);
  assert.equal(result.candidatePromoted,false);
  assert.equal(result.trustedRuntimeModified,false);
  assert.deepEqual(result.skippedLiveChecks,SKIPPED_LIVE_CHECKS);
  assert.equal(git(f.root,"rev-parse","HEAD"),f.trustedSha);
  assert.equal(await fs.readFile(path.join(f.root,"safe.js"),"utf8"),before);
  assert.equal(git(f.root,"status","--porcelain"),"");
  assert.equal(git(f.root,"worktree","list","--porcelain").match(/^worktree /gm).length,1);
  assert.deepEqual(JSON.parse(await fs.readFile(result.reportPath,"utf8")),
    result);
});
test("SU-01 successful candidate is not promoted and skipped live checks are explicit",async t=>{
  const f=await fixture(t);
  const result=await verifyCandidate({
    root:f.root,reportRoot:f.reports,sha:f.trustedSha,checks:check,
  });
  assert.equal(result.ok,true);
  assert.equal(result.status,"PASSED_WITH_LIVE_CHECKS_SKIPPED");
  assert.equal(result.candidateSha,f.trustedSha);
  assert.deepEqual(result.skippedLiveChecks,SKIPPED_LIVE_CHECKS);
  assert.equal(git(f.root,"rev-parse","HEAD"),f.trustedSha);
  assert.equal(git(f.root,"worktree","list","--porcelain").match(/^worktree /gm).length,1);
});
test("SU-01 rejects non-commit and partial candidate identifiers",async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>verifyCandidate({
    root:f.root,reportRoot:f.reports,sha:f.brokenSha.slice(0,12),checks:check,
  }),{code:"CANDIDATE_SHA_INVALID"});
  await assert.rejects(()=>verifyCandidate({
    root:f.root,reportRoot:f.reports,sha:"0".repeat(40),checks:check,
  }),{code:"CANDIDATE_OBJECT_FAILED"});
  assert.equal(git(f.root,"worktree","list","--porcelain").match(/^worktree /gm).length,1);
});
