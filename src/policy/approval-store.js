import fs from "node:fs/promises";
import { replaceFileAtomic } from "../shared/atomic-write.js";

// Persisted "always allow" decisions made at the approval prompt. Lives in the
// app data directory so it survives session resumes and new sessions.
export class ApprovalStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.toolNames = new Set();
    this.allowAll = false;
    this.loaded = false;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    await this.reload();
  }

  // Supervisor CLI persists decisions in a *different* process. The Worker
  // may already have loaded this store before requesting approval, so it must
  // explicitly reload after the parent replies. Do not merge old grants:
  // revocations and corrupt/missing files must fail closed.
  async reload() {
    let names = new Set();
    let allowAll = false;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object"
          || (parsed.toolNames != null && !Array.isArray(parsed.toolNames))) {
        throw new Error("Invalid approvals file");
      }
      allowAll = parsed.allowAll === true;
      names = new Set((parsed.toolNames ?? []).filter((name) =>
        typeof name === "string" && name.length > 0));
    } catch {
      // ENOENT, malformed JSON, or unreadable file all mean no durable grant.
      names = new Set();
      allowAll = false;
    }
    this.toolNames = names;
    this.allowAll = allowAll;
    this.loaded = true;
  }

  isAlwaysAllowed(toolName) {
    return this.allowAll || this.toolNames.has(toolName);
  }

  setAlwaysAllowedTool(toolName) {
    this.toolNames.add(toolName);
  }

  setAlwaysAllowAll() {
    this.allowAll = true;
  }

  async save() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify({
        toolNames: [...this.toolNames].sort(),
        allowAll: this.allowAll,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    try {
      await replaceFileAtomic(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}
