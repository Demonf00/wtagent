import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateOwner(value) {
  if (!value || value.schema !== 1
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.token !== "string"
    || !/^[a-f0-9-]{36}$/.test(value.token)) {
    throw fail("ORCHESTRATOR_OWNER_UNCERTAIN", "Invalid or incomplete lock owner.");
  }
  return value;
}

function processState(pid) {
  try {
    process.kill(pid, 0);
    return "ALIVE";
  } catch (error) {
    return error.code === "ESRCH" ? "DEAD" : "UNKNOWN";
  }
}

async function readOwner(file, optional = false) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
    throw fail("ORCHESTRATOR_OWNER_UNCERTAIN", "Owner lock is not a bounded regular file.");
  }
  let value;
  try { value = JSON.parse(await fs.readFile(file, "utf8")); }
  catch {
    throw fail("ORCHESTRATOR_OWNER_UNCERTAIN", "Owner lock is corrupt.");
  }
  return validateOwner(value);
}

export function orchestratorOwnerPaths({ workspaceRoot, stateFile }) {
  const root = path.resolve(workspaceRoot);
  const key = createHash("sha256").update(root).digest("hex");
  return {
    workspace: path.join(path.dirname(root),
      ".wtagent-orchestrator-" + key + ".lock"),
    checkpoint: path.resolve(stateFile) + ".orchestrator.lock",
  };
}

export async function inspectOrchestratorOwner({ workspaceRoot, stateFile, scope }) {
  const file = orchestratorOwnerPaths({workspaceRoot, stateFile})[scope];
  if (!file) throw fail("ORCHESTRATOR_OWNER_INVALID", "Invalid lock scope.");
  const owner = await readOwner(file, true);
  return {
    scope, file, status: !owner ? "UNOWNED" : processState(owner.pid),
    owner: owner ? {pid:owner.pid,token:owner.token} : null,
  };
}

async function ensureNoRecoveryGuard(file) {
  // The lock can already have been quarantined before an audit COMMITTED
  // entry is durable. Do not let a normal owner bypass an unfinished recovery.
  try {
    await fs.lstat(file + ".recovery");
    throw fail("ORCHESTRATOR_RECOVERY_BUSY",
      "An explicit recovery is still in progress or requires inspection.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function acquireOrchestratorOwner(file) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  await ensureNoRecoveryGuard(file);
  const token=randomUUID();
  let handle;
  try {
    handle=await fs.open(file,"wx",0o600);
    try {
      await handle.writeFile(JSON.stringify({schema:1,pid:process.pid,token}));
      await handle.sync();
    } finally { await handle.close(); }
    // On a concurrent recovery, fail closed and release only our own lock.
    try {
      await ensureNoRecoveryGuard(file);
    } catch (error) {
      const owner=await readOwner(file,true);
      if(owner?.token===token&&owner.pid===process.pid)await fs.rm(file);
      throw error;
    }
  } catch(error) {
    if(error.code!=="EEXIST")throw error;
    const owner=await readOwner(file,true);
    if(!owner)throw fail("ORCHESTRATOR_OWNER_UNCERTAIN",
      "Lock changed concurrently; retry only after inspection.");
    const status=processState(owner.pid);
    throw fail(status==="DEAD"?"ORCHESTRATOR_STALE_OWNER":
      status==="ALIVE"?"ORCHESTRATOR_ALREADY_OWNED":"ORCHESTRATOR_OWNER_UNCERTAIN",
      status==="DEAD"
        ?"Stale owner requires explicit, audited recovery."
        :"Workspace or checkpoint already has an owner.");
  }
  return async()=>{
    const owner=await readOwner(file,true);
    if(owner?.token===token&&owner.pid===process.pid){
      await fs.rm(file);
    } else if(owner!==null) {
      throw fail("ORCHESTRATOR_OWNER_UNCERTAIN",
        "Owner changed; refusing to delete another process's lock.");
    }
  };
}

/**
 * Explicit maintenance-only operation. Never called from normal acquisition.
 * The recovery guard serializes all maintenance actors. Regular acquisitions
 * never remove an existing lock, so they cannot race a stale-owner reclaimer
 * into deleting an active owner's file.
 */
export async function recoverStaleOrchestratorOwner({
  workspaceRoot,stateFile,scope,expectedToken,
}) {
  const file=orchestratorOwnerPaths({workspaceRoot,stateFile})[scope];
  if(!file||typeof expectedToken!=="string"
    || !/^[a-f0-9-]{36}$/.test(expectedToken)){
    throw fail("ORCHESTRATOR_OWNER_INVALID",
      "Explicit scope and observed owner token are required.");
  }
  const guardFile=file+".recovery";
  const guardToken=randomUUID();
  let guard;
  try {
    guard=await fs.open(guardFile,"wx",0o600);
    try {
      await guard.writeFile(JSON.stringify({
        schema:1,pid:process.pid,token:guardToken,
      }));
      await guard.sync();
    } finally { await guard.close(); }
  } catch(error) {
    if(error.code==="EEXIST"){
      throw fail("ORCHESTRATOR_RECOVERY_BUSY",
        "Recovery is in progress or a recovery guard needs manual inspection.");
    }
    throw error;
  }
  let quarantined=false;
  let committed=false;
  try {
    const owner=await readOwner(file);
    if(owner.token!==expectedToken){
      throw fail("ORCHESTRATOR_OWNER_UNCERTAIN",
        "Lock ownership changed since explicit inspection.");
    }
    if(processState(owner.pid)!=="DEAD"){
      throw fail("ORCHESTRATOR_OWNER_UNCERTAIN",
        "Owner is alive or cannot be proved dead.");
    }
    const archive=file+".stale."+owner.token+"."+randomUUID();
    const audit=file+".audit.jsonl";
    // The audit is security-relevant: never follow a caller-planted symlink.
    // Append with an exclusive first-create and refuse non-regular files.
    async function appendAudit(entry) {
      let stat;
      try { stat=await fs.lstat(audit); }
      catch(error) { if(error.code!=="ENOENT")throw error; }
      if(stat&&(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)){
        throw fail("ORCHESTRATOR_OWNER_UNCERTAIN",
          "Recovery audit path is unsafe.");
      }
      const flags=fsConstants.O_APPEND | fsConstants.O_WRONLY
        | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0);
      const handle=await fs.open(audit,flags,0o600);
      try {
        const current=await handle.stat();
        if(!current.isFile()||current.size>1024*1024){
          throw fail("ORCHESTRATOR_OWNER_UNCERTAIN","Recovery audit is unsafe.");
        }
        await handle.writeFile(JSON.stringify(entry)+"\n");
        await handle.sync();
      } finally {await handle.close();}
    }
    const details={
      schema:1,scope,pid:owner.pid,token:owner.token,
      recoveryPid:process.pid,recoveryToken:guardToken,
      at:new Date().toISOString(),
    };
    // Append INTENT before changing ownership. A crash before COMMITTED
    // leaves an inspectable intent plus either original lock or quarantine.
    await appendAudit({...details,phase:"INTENT",archive});
    const confirmed=await readOwner(file);
    if(confirmed.token!==owner.token
      || confirmed.pid!==owner.pid
      || processState(confirmed.pid)!=="DEAD"){
      throw fail("ORCHESTRATOR_OWNER_UNCERTAIN",
        "Owner became uncertain before quarantine.");
    }
    await fs.rename(file,archive);
    quarantined=true;
    await appendAudit({...details,phase:"COMMITTED",archive});
    committed=true;
    return {scope,file,archive,audit,pid:owner.pid,token:owner.token};
  } finally {
    const guardOwner=await readOwner(guardFile,true);
    // A crash or audit failure after quarantine must leave the guard intact.
    // Without a durable COMMITTED record, manual reconciliation is required.
    if(guardOwner?.token===guardToken&&guardOwner.pid===process.pid
      &&(!quarantined||committed)){
      await fs.rm(guardFile);
    }
  }
}
