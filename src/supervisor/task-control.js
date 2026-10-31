export class TaskStoppedError extends Error {
  constructor(reason) {
    super(reason === "cancel" ? "Task cancelled at a safe checkpoint." : "Task paused at a safe checkpoint.");
    this.name = "TaskStoppedError";
    this.code = reason === "cancel" ? "TASK_CANCELLED" : "TASK_PAUSED";
  }
}

export class TaskControl {
  constructor() {
    this.reason = null;
    this.listeners = new Set();
  }
  checkpoint() {
    if (this.reason) throw new TaskStoppedError(this.reason);
  }
  request(reason) {
    if (reason !== "pause" && reason !== "cancel") throw new Error("Invalid task control.");
    if (this.reason === "cancel") return;
    this.reason = reason;
    for (const listener of [...this.listeners]) listener(new TaskStoppedError(reason));
  }
  onStop(listener) {
    this.listeners.add(listener);
    if (this.reason) listener(new TaskStoppedError(this.reason));
    return () => this.listeners.delete(listener);
  }
}
