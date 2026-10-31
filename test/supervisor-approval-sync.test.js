import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalStore } from "../src/policy/approval-store.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { requestSupervisorApproval } from "../src/runtime/conversation-runner.js";

const inlineNode = {
  name: "terminal.exec",
  args: {
    program: "node", argv: ["-e", "console.log(1)"],
    cwd: ".",
  },
};

async function fixture(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-approval-sync-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const filePath = path.join(projectRoot, "approvals.json");
  // Two different instances represent the parent CLI and isolated Worker.
  const parent = new ApprovalStore({ filePath });
  const worker = new ApprovalStore({ filePath });
  const policy = new PolicyEngine({ store: worker });
  return { projectRoot, filePath, parent, worker, policy };
}

test("Supervisor parent always-tool decision takes effect in running Worker", async (t) => {
  const { projectRoot, parent, worker, policy } = await fixture(t);
  const before = await policy.evaluate(inlineNode, { projectRoot });
  assert.equal(before.action, "confirm");
  assert.equal(worker.loaded, true);

  const approved = await requestSupervisorApproval({
    approvalProvider: {
      async request({ toolCall }) {
        assert.equal(toolCall.name, "terminal.exec");
        await parent.ensureLoaded();
        parent.setAlwaysAllowedTool("terminal.exec");
        await parent.save();
        return true;
      },
    },
    approvalStore: worker,
    toolCall: inlineNode,
    reasons: before.reasons,
  });
  assert.equal(approved, true);
  assert.equal(worker.isAlwaysAllowed("terminal.exec"), true);
  const after = await policy.evaluate(inlineNode, { projectRoot });
  assert.equal(after.action, "allow");
  assert.equal(after.grants.allowOutside, true);
  // Grant stays scoped to a tool, not the entire session.
  assert.equal(worker.isAlwaysAllowed("browser.click"), false);
});

test("Supervisor parent always-all decision is visible before next Worker tool", async (t) => {
  const { projectRoot, parent, worker, policy } = await fixture(t);
  assert.equal((await policy.evaluate(inlineNode, { projectRoot })).action, "confirm");
  await requestSupervisorApproval({
    approvalProvider: {
      async request() {
        await parent.ensureLoaded();
        parent.setAlwaysAllowAll();
        await parent.save();
        return true;
      },
    },
    approvalStore: worker,
    toolCall: inlineNode,
    reasons: [],
  });
  assert.equal((await policy.evaluate(inlineNode, { projectRoot })).action, "allow");
  assert.equal(worker.isAlwaysAllowed("browser.click"), true);
});

test("Allow once remains one-time and does not persist a grant", async (t) => {
  const { projectRoot, worker, policy } = await fixture(t);
  const decision = await policy.evaluate(inlineNode, { projectRoot });
  assert.equal(decision.action, "confirm");
  assert.equal(await requestSupervisorApproval({
    approvalProvider: { async request() { return true; } },
    approvalStore: worker, toolCall: inlineNode, reasons: decision.reasons,
  }), true);
  assert.equal((await policy.evaluate(inlineNode, { projectRoot })).action, "confirm");
});

test("corrupt, removed, or revoked approvals fail closed on Worker reload", async (t) => {
  const { projectRoot, filePath, parent, worker, policy } = await fixture(t);
  parent.setAlwaysAllowAll();
  await parent.save();
  await worker.ensureLoaded();
  assert.equal((await policy.evaluate(inlineNode, { projectRoot })).action, "allow");

  await fs.writeFile(filePath, "{ corrupt approvals", "utf8");
  await worker.reload();
  assert.equal((await policy.evaluate(inlineNode, { projectRoot })).action, "confirm");

  await fs.writeFile(filePath, JSON.stringify({ allowAll: false, toolNames: [] }), "utf8");
  await worker.reload();
  assert.equal((await policy.evaluate(inlineNode, { projectRoot })).action, "confirm");

  await fs.rm(filePath);
  await worker.reload();
  assert.equal((await policy.evaluate(inlineNode, { projectRoot })).action, "confirm");
});

test("saved approval does not leak into another session store", async (t) => {
  const { projectRoot, parent, worker } = await fixture(t);
  const other = new ApprovalStore({ filePath: path.join(projectRoot, "other-session-approvals.json") });
  parent.setAlwaysAllowedTool("terminal.exec");
  await parent.save();
  await worker.reload();
  await other.ensureLoaded();
  assert.equal(worker.isAlwaysAllowed("terminal.exec"), true);
  assert.equal(other.isAlwaysAllowed("terminal.exec"), false);
});
