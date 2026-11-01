import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  acquireOrchestratorOwner,
  inspectOrchestratorOwner,
  orchestratorOwnerPaths,
  recoverStaleOrchestratorOwner,
} from "../src/autonomy/orchestrator-ownership.js";
import { runDurableOrchestrator } from "../src/autonomy/durable-orchestrator.js";

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"wtagent-as02-"));
  const workspaceRoot=path.join(root,"workspace");
  await fs.mkdir(workspaceRoot);
  const f={root,workspaceRoot,stateFile:path.join(root,"goal.json")};
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return f;
}

test("AS-02 stale owner is never automatically stolen; explicit recovery is audited",async t=>{
  const f=await fixture(t);
  const paths=orchestratorOwnerPaths(f);
  const deadOwner={schema:1,pid:2147483647,token:randomUUID()};
  await fs.writeFile(paths.workspace,JSON.stringify(deadOwner));
  const observed=await inspectOrchestratorOwner({...f,scope:"workspace"});
  assert.equal(observed.status,"DEAD");
  assert.deepEqual(observed.owner,{pid:deadOwner.pid,token:deadOwner.token});
  await assert.rejects(
    acquireOrchestratorOwner(paths.workspace),
    {code:"ORCHESTRATOR_STALE_OWNER"},
  );
  let ran=0;
  await assert.rejects(runDurableOrchestrator({
    ...f,goal:"never run through stale owner",
    runSlice:async()=>{ran++;return {status:"VERIFIED"};},
  }),{code:"ORCHESTRATOR_STALE_OWNER"});
  assert.equal(ran,0);
  await assert.rejects(recoverStaleOrchestratorOwner({
    ...f,scope:"workspace",expectedToken:randomUUID(),
  }),{code:"ORCHESTRATOR_OWNER_UNCERTAIN"});
  const recovery=await recoverStaleOrchestratorOwner({
    ...f,scope:"workspace",expectedToken:deadOwner.token,
  });
  assert.equal(recovery.pid,deadOwner.pid);
  assert.equal(recovery.token,deadOwner.token);
  assert.deepEqual(JSON.parse(await fs.readFile(recovery.archive,"utf8")),deadOwner);
  const entries=(await fs.readFile(recovery.audit,"utf8")).trim()
    .split(/\r?\n/).map(line=>JSON.parse(line));
  assert.deepEqual(entries.map(x=>x.phase),["INTENT","COMMITTED"]);
  assert.ok(entries.every(x=>x.token===deadOwner.token&&x.archive===recovery.archive));
  assert.equal((await inspectOrchestratorOwner({...f,scope:"workspace"})).status,"UNOWNED");
  const release=await acquireOrchestratorOwner(paths.workspace);
  assert.equal((await inspectOrchestratorOwner({...f,scope:"workspace"})).status,"ALIVE");
  await release();
  assert.equal((await inspectOrchestratorOwner({...f,scope:"workspace"})).status,"UNOWNED");
});

test("AS-02 concurrent recovery admits exactly one stale-owner quarantine",async t=>{
  const f=await fixture(t);
  const lock=orchestratorOwnerPaths(f).checkpoint;
  const token=randomUUID();
  await fs.writeFile(lock,JSON.stringify({schema:1,pid:2147483647,token}));
  const attempts=await Promise.allSettled(Array.from({length:4},()=>
    recoverStaleOrchestratorOwner({
      ...f,scope:"checkpoint",expectedToken:token,
    })
  ));
  const success=attempts.filter(x=>x.status==="fulfilled");
  assert.equal(success.length,1,JSON.stringify(attempts));
  const audit=(await fs.readFile(lock+".audit.jsonl","utf8"))
    .trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.equal(audit.filter(x=>x.phase==="COMMITTED").length,1);
  assert.equal(audit.filter(x=>x.phase==="INTENT").length,1);
  const release=await acquireOrchestratorOwner(lock);
  await release();
});

test("AS-02 live owner cannot be recovered or replaced",async t=>{
  const f=await fixture(t);
  const lock=orchestratorOwnerPaths(f).checkpoint;
  const release=await acquireOrchestratorOwner(lock);
  const observed=await inspectOrchestratorOwner({...f,scope:"checkpoint"});
  assert.equal(observed.status,"ALIVE");
  await assert.rejects(acquireOrchestratorOwner(lock),
    {code:"ORCHESTRATOR_ALREADY_OWNED"});
  await assert.rejects(recoverStaleOrchestratorOwner({
    ...f,scope:"checkpoint",expectedToken:observed.owner.token,
  }),{code:"ORCHESTRATOR_OWNER_UNCERTAIN"});
  await release();
  await assert.rejects(fs.stat(lock),{code:"ENOENT"});
});

test("AS-02 a different Node process excludes this process, then requires audited recovery after forced termination",async t=>{
  const f=await fixture(t);
  const lock=orchestratorOwnerPaths(f).workspace;
  const moduleUrl=pathToFileURL(path.resolve(
    "src/autonomy/orchestrator-ownership.js")).href;
  const child=spawn(process.execPath,[
    "--input-type=module","-e",
    'const {acquireOrchestratorOwner}=await import(process.argv[1]);await acquireOrchestratorOwner(process.argv[2]);console.log("LOCK_HELD");setInterval(()=>{},1000);',
    moduleUrl,lock,
  ],{stdio:["ignore","pipe","pipe"],windowsHide:true});
  let stderr="";
  child.stderr.on("data",b=>{stderr+=b.toString();});
  let exited=false;
  child.once("exit",()=>{exited=true;});
  const ready=new Promise((resolve,reject)=>{
    let stdout="";
    const timeout=setTimeout(()=>reject(new Error("Child lock acquisition timeout: "+stderr)),10000);
    child.stdout.on("data",b=>{
      stdout+=b.toString();
      if(stdout.includes("LOCK_HELD")){clearTimeout(timeout);resolve();}
    });
    child.once("exit",code=>{
      if(!stdout.includes("LOCK_HELD")){
        clearTimeout(timeout);reject(new Error("Child exited early "+code+" "+stderr));
      }
    });
  });
  try{
    await ready;
    const observed=await inspectOrchestratorOwner({...f,scope:"workspace"});
    assert.equal(observed.status,"ALIVE");
    assert.equal(observed.owner.pid,child.pid);
    await assert.rejects(acquireOrchestratorOwner(lock),
      {code:"ORCHESTRATOR_ALREADY_OWNED"});
    child.kill();
    if(!exited)await new Promise(resolve=>child.once("exit",resolve));
    const stale=await inspectOrchestratorOwner({...f,scope:"workspace"});
    assert.equal(stale.status,"DEAD");
    await assert.rejects(acquireOrchestratorOwner(lock),
      {code:"ORCHESTRATOR_STALE_OWNER"});
    await recoverStaleOrchestratorOwner({
      ...f,scope:"workspace",expectedToken:stale.owner.token,
    });
    const release=await acquireOrchestratorOwner(lock);
    await release();
  }finally{
    if(!exited)child.kill();
  }
});


test("AS-02 interrupted recovery guard refuses ownership even after lock quarantine",async t=>{
  const f=await fixture(t);
  const lock=orchestratorOwnerPaths(f).workspace;
  const guard=lock+".recovery";
  await fs.writeFile(guard,JSON.stringify({
    schema:1,pid:2147483647,token:randomUUID(),
  }));
  await assert.rejects(acquireOrchestratorOwner(lock),
    {code:"ORCHESTRATOR_RECOVERY_BUSY"});
  await assert.rejects(runDurableOrchestrator({
    ...f,goal:"not after incomplete audit",
    runSlice:async()=>{throw Error("must not run");},
  }),{code:"ORCHESTRATOR_RECOVERY_BUSY"});
  await assert.rejects(fs.stat(lock),{code:"ENOENT"});
});

test("AS-02 audited handoff resumes persisted execution without replaying start",async t=>{
  const f=await fixture(t);
  const calls=[];
  const runSlice=async ({action,stateFile})=>{
    calls.push(action);
    if(action==="goal"){
      await fs.writeFile(stateFile,JSON.stringify({schema:2}));
      return {status:"RUNNING"};
    }
    return {status:"VERIFIED"};
  };
  const first=await runDurableOrchestrator({
    ...f,goal:"one durable goal",maxCycles:1,
    cooldownMs:100,runSlice,
  });
  assert.equal(first.status,"WAITING");
  assert.deepEqual(calls,["goal"]);
  const lock=orchestratorOwnerPaths(f).workspace;
  const stale={schema:1,pid:2147483647,token:randomUUID()};
  await fs.writeFile(lock,JSON.stringify(stale));
  await assert.rejects(runDurableOrchestrator({
    ...f,maxCycles:4,runSlice,
  }),{code:"ORCHESTRATOR_STALE_OWNER"});
  assert.deepEqual(calls,["goal"]);
  const done=await recoverStaleOrchestratorOwner({
    ...f,scope:"workspace",expectedToken:stale.token,
  });
  assert.ok(done.archive);
  const resumed=await runDurableOrchestrator({
    ...f,maxCycles:4,runSlice,
  });
  assert.equal(resumed.status,"COMPLETE");
  assert.deepEqual(calls,["goal","resume"]);
});


test("AS-02 CLI inspect and explicit recovery are exposed",async t=>{
  const f=await fixture(t);
  const entry=path.resolve("src/cli/main.js");
  const {spawnSync}=await import("node:child_process");
  for(const sub of ["orchestrator-owner","orchestrator-recover"]){
    const help=spawnSync(process.execPath,[entry,"autonomy",sub,"--help"],{
      encoding:"utf8",timeout:15000,
    });
    assert.equal(help.status,0,help.stderr);
    assert.match(help.stdout,/--scope/);
    assert.match(help.stdout,/--state/);
    if(sub==="orchestrator-recover")assert.match(help.stdout,/--token/);
  }
  const token=randomUUID();
  const lock=orchestratorOwnerPaths(f).checkpoint;
  await fs.writeFile(lock,JSON.stringify({schema:1,pid:2147483647,token}));
  const base=[entry,"--project",f.workspaceRoot,"autonomy"];
  const inspect=spawnSync(process.execPath,[
    ...base,"orchestrator-owner","--state",f.stateFile,"--scope","checkpoint",
  ],{encoding:"utf8",timeout:15000});
  assert.equal(inspect.status,0,inspect.stderr);
  const state=JSON.parse(inspect.stdout);
  assert.equal(state.status,"DEAD");
  assert.equal(state.owner.token,token);
  const recovered=spawnSync(process.execPath,[
    ...base,"orchestrator-recover","--state",f.stateFile,
    "--scope","checkpoint","--token",token,
  ],{encoding:"utf8",timeout:15000});
  assert.equal(recovered.status,0,recovered.stderr);
  const result=JSON.parse(recovered.stdout);
  assert.equal(result.token,token);
  assert.match(await fs.readFile(result.audit,"utf8"),/"COMMITTED"/);
});
