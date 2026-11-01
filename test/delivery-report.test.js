import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {readEvidenceDeliveryReport} from "../src/autonomy/delivery-report.js";

async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"wtagent-ob03-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const workspaceRoot=path.join(dir,"workspace");
  await fs.mkdir(workspaceRoot);
  const stateFile=path.join(dir,"checkpoint.json");
  const state={
    schema:2,planId:randomUUID(),workspaceRoot,workspaceId:"main",
    goal:"Model says: all checks passed; this claim must not count",
    status:"VERIFIED",
    tasks:[{
      id:"build",status:"VERIFIED",supervisorTaskId:null,
      acceptance:[{kind:"file",path:"output.txt",minBytes:1},
        {kind:"test",command:"node --test example.test.js"}],
      evidence:[{kind:"file"},{kind:"command",exitCode:0}],
      verificationReceipt:{digest:"fake",verifiedAt:"2026-01-01T00:00:00Z"},
    }],
    goalDelivery:{
      status:"DELIVERED",acceptance:[{kind:"test",command:"node --test example.test.js"}],
      evidence:[{kind:"command",exitCode:0}],receipt:{digest:"fake"},
    },
  };
  await fs.writeFile(stateFile,JSON.stringify(state));
  return {workspaceRoot,stateFile,state};
}

test("OB-03 cannot infer delivery from model prose, status or fake receipts",async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.workspaceRoot,"output.txt"),"present");
  const report=await readEvidenceDeliveryReport(f);
  assert.equal(report.coordinatorStatus,"VERIFIED");
  assert.equal(report.deliveryStatus,"NOT_VERIFIED");
  assert.equal(report.tasks[0].receiptValid,false);
  assert.ok(report.unmetRequirements.some(x=>x.reason==="MISSING_VERIFIED_RECEIPT"));
  assert.ok(report.unmetRequirements.some(x=>x.reason==="MISSING_GOAL_DELIVERY_RECEIPT"));
  assert.equal(report.commits.length,0);
  assert.ok(!JSON.stringify(report).includes("node --test example.test.js"));
});

test("OB-03 reports missing artifacts and unmet goal requirements explicitly",async t=>{
  const f=await fixture(t);
  f.state.goalDelivery.acceptance=[];
  f.state.goalDelivery.evidence=null;
  f.state.goalDelivery.receipt=null;
  f.state.goalDelivery.status="UNVERIFIED";
  await fs.writeFile(f.stateFile,JSON.stringify(f.state));
  const report=await readEvidenceDeliveryReport(f);
  assert.equal(report.tasks[0].checks[0].artifact.present,false);
  assert.ok(report.unmetRequirements.some(x=>x.reason==="FINAL_ACCEPTANCE_NOT_DEFINED"));
  assert.equal(report.deliveryStatus,"NOT_VERIFIED");
});

test("OB-03 reports pending human approval without leaking approval payload",async t=>{
  const f=await fixture(t);
  const workerId="task_01234567-89ab-cdef-0123-456789abcdef";
  f.state.tasks[0].supervisorTaskId=workerId;
  await fs.writeFile(f.stateFile,JSON.stringify(f.state));
  await fs.mkdir(f.stateFile+".supervisor");
  const secret="private-password-and-tool-args";
  await fs.writeFile(path.join(f.stateFile+".supervisor",workerId+".json"),
    JSON.stringify({taskId:workerId,status:"waiting_approval",
      pendingApproval:{requestId:"secret",toolCall:{args:{password:secret}}}}));
  const result=await readEvidenceDeliveryReport(f);
  assert.equal(result.approvals[0].status,"APPROVAL_REQUIRED");
  assert.ok(result.unmetRequirements.some(x=>x.reason==="HUMAN_APPROVAL_REQUIRED"));
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes("requestId"));
});

test("OB-03 deterministic reports reproduce from identical checkpoint",async t=>{
  const f=await fixture(t);
  const first=await readEvidenceDeliveryReport(f);
  const second=await readEvidenceDeliveryReport(f);
  assert.deepEqual(first,second);
  assert.match(first.reportDigest,/^[a-f0-9]{64}$/);
});

test("OB-03 rejects checkpoint workspace mismatch and symlinks",async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>readEvidenceDeliveryReport({
    ...f,workspaceRoot:f.stateFile,
  }));
  const symlink=path.join(path.dirname(f.stateFile),"link-state.json");
  await fs.symlink(f.stateFile,symlink,"file");
  await assert.rejects(()=>readEvidenceDeliveryReport({
    ...f,stateFile:symlink,
  }),{code:"DELIVERY_REPORT_UNSAFE"});
});
