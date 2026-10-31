import { createHash } from "node:crypto";

export function approvalIdentity(toolCall) {
  return createHash("sha256").update(JSON.stringify({
    id: toolCall.id, name: toolCall.name, args: toolCall.args,
  })).digest("hex");
}

export class SupervisorApprovalProvider {
  constructor({ onRequired, control }) {
    this.onRequired = onRequired;
    this.control = control;
    this.pending = null;
  }
  async request({ toolCall, reasons }) {
    this.control.checkpoint();
    const requestId = approvalIdentity(toolCall);
    // Install both the decision handler and stop listener before publishing
    // waiting_approval. An API consumer can decide as soon as that state is
    // visible; publishing first used to lose early decisions.
    let resolveDecision;
    let rejectDecision;
    const decision = new Promise((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });
    // A stop may reject while the durable state transition is still pending.
    // Attach a handler immediately to avoid an unhandled rejection.
    void decision.catch(() => {});
    this.pending = {
      requestId,
      decide: (value) => resolveDecision(value === "approve"),
      abort: (error) => rejectDecision(error),
    };
    const unsubscribe = this.control.onStop(rejectDecision);
    try {
      this.control.checkpoint();
      await this.onRequired({ requestId, toolCall: {
        id: toolCall.id, name: toolCall.name, args: toolCall.args,
      }, reasons });
      this.control.checkpoint();
      return await decision;
    } finally {
      unsubscribe();
      if (this.pending?.requestId === requestId) this.pending = null;
    }
  }
  decide(requestId, decision) {
    if (!this.pending || this.pending.requestId !== requestId) return false;
    if (decision !== "approve" && decision !== "deny") throw new Error("Invalid approval decision.");
    this.pending.decide(decision);
    return true;
  }
  abort(error) {
    if (!this.pending) return false;
    this.pending.abort(error);
    return true;
  }
}
