import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {parseTestEvidence,validateRoadmapEvidence} from "../scripts/verify-autonomy-end-to-end.js";

const root=fileURLToPath(new URL("../",import.meta.url));
const idList=["FV-06","FR-04","DP-03","CM-03","OB-03","SU-01","SU-02"];
function simulatedOutput(title,{fail=0,pass=8,skipped=0}={}){
  return [
    "✔ "+title+" (2.3ms)",
    "ℹ tests "+(pass+fail+skipped),
    "ℹ pass "+pass,
    "ℹ fail "+fail,
    "ℹ skipped "+skipped,
  ].join("\n");
}
test("SU-03 parser requires actual passing test title and valid TAP totals",()=>{
  const expected={"real-stage":"A committed integration check"};
  const result=parseTestEvidence(simulatedOutput(expected["real-stage"]),expected);
  assert.equal(result.counts.pass,8);
  assert.equal(result.phases["real-stage"].passed,true);
  assert.throws(()=>parseTestEvidence(simulatedOutput("Unrelated test"),expected),
    /TEST_PHASE_UNVERIFIED/);
  assert.throws(()=>parseTestEvidence(simulatedOutput(expected["real-stage"],{fail:1}),expected),
    /TEST_SUITE_UNVERIFIED/);
  assert.throws(()=>parseTestEvidence(simulatedOutput(expected["real-stage"],{pass:7}),expected),
    /TEST_SUITE_UNVERIFIED/);
  assert.throws(()=>parseTestEvidence("✖ "+expected["real-stage"]+"\n"+
    "ℹ tests 8\nℹ pass 8\nℹ fail 0\nℹ skipped 0",expected),
    /TEST_PHASE_UNVERIFIED/);
});
test("SU-03 verifies all independently committed roadmap phases against Git ancestry",async()=>{
  const plan=JSON.parse(await fs.readFile(root+"docs/autonomy-roadmap.json","utf8"));
  const commits=validateRoadmapEvidence(plan);
  assert.equal(commits.length,plan.tasks.filter(x=>x.status==="VERIFIED").length);
  assert.ok(commits.length>=27);
  assert.equal(new Set(commits.map(x=>x.sha)).size,commits.length);
  for(const id of idList)assert.ok(commits.some(x=>x.id===id));
});
test("SU-03 refuses copied SHA, missing evidence and fabricated Git ancestry",async()=>{
  const path=root+"docs/autonomy-roadmap.json";
  const original=JSON.parse(await fs.readFile(path,"utf8"));
  const modified=structuredClone(original);
  modified.tasks[1].commitSha=modified.tasks[0].commitSha;
  assert.throws(()=>validateRoadmapEvidence(modified),/ROADMAP_PROVENANCE_INVALID/);
  const noEvidence=structuredClone(original);
  noEvidence.tasks[0].testEvidence=null;
  assert.throws(()=>validateRoadmapEvidence(noEvidence),/ROADMAP_PROVENANCE_INVALID/);
  const nonCommit=structuredClone(original);
  nonCommit.tasks[0].commitSha="0".repeat(40);
  assert.throws(()=>validateRoadmapEvidence(nonCommit),/Git evidence unavailable/);
  const absentPhase=structuredClone(original);
  absentPhase.tasks.find(x=>x.id==="CM-03").id="OTHER";
  assert.throws(()=>validateRoadmapEvidence(absentPhase),/REQUIRED_PHASE_NOT_VERIFIED/);
});
