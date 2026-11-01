// Durable, content-free progress projection for Supervisor events.
// Never persist model text, tool arguments, result bodies or raw failures.
const TYPES = new Set([
  "tool.proposed","tool.started","tool.completed","tool.completion_unknown",
  "tool.invalid","tool.reused","tool.reused_unknown","tool.result_sent",
]);
const STATUS = new Set([
  "queued","running","recovering","waiting_retry","waiting_approval",
  "pausing","paused","blocked_uncertain","completed","failed",
  "cancelled","cancelling",
]);
const NEXT = {
  queued:"WAIT_FOR_WORKER",
  running:"MONITOR_WORKER",
  recovering:"MONITOR_RECOVERY",
  waiting_retry:"WAIT_FOR_RETRY",
  waiting_approval:"HUMAN_APPROVAL_REQUIRED",
  pausing:"WAIT_FOR_PAUSE",
  paused:"EXPLICIT_RESUME_REQUIRED",
  blocked_uncertain:"RECONCILE_UNCERTAIN_EXECUTION",
  completed:"VERIFY_RESULT",
  failed:"INSPECT_FAILURE",
  cancelled:"STOPPED",
  cancelling:"WAIT_FOR_CANCEL",
};
export function sanitizeDurableToolEvent(event) {
  if (!TYPES.has(event?.type)) return null;
  // safeRuntimeEvent persists toolClass rather than tool names. This is
  // intentional: the live-only display may show an exact tool name, while
  // reattachment exposes a bounded and non-sensitive category.
  const toolClass=event?.payload?.toolClass;
  // Only the four categories emitted by recovery-controller.safeRuntimeEvent
  // may enter a persisted progress view. A tool name from an event payload
  // may be model-generated; never copy it into a durable status summary.
  if(!["read","verify","other","unknown"].includes(toolClass))return null;
  const payload={name:toolClass};
  if(event.type==="tool.completed"){
    payload.ok=event?.payload?.result?.ok===true;
  }
  return {type:event.type,payload};
}
export function buildDurableProgress(task,events=[]) {
  if(!task||typeof task!=="object")throw new TypeError("A task is required");
  const status=STATUS.has(task.status)?task.status:"unknown";
  let latest=null;
  let attempts=Number.isSafeInteger(task.attempts)&&task.attempts>=0?task.attempts:0;
  let retries=Number.isSafeInteger(task.retries)&&task.retries>=0?task.retries:0;
  let lastEventSeq=0;
  let totalTools=0;
  for(const event of events) {
    if(!Number.isSafeInteger(event?.seq)||event.seq<=lastEventSeq)continue;
    lastEventSeq=event.seq;
    const safe=sanitizeDurableToolEvent(event);
    if(safe){
      latest={tool:safe.payload.name,stage:safe.type,
        ...(safe.type==="tool.completed"?{ok:safe.payload.ok}:{})};
      if(safe.type==="tool.started")totalTools++;
    }
  }
  return {
    taskId:typeof task.taskId==="string"&&/^task_[a-f0-9-]{36}$/.test(task.taskId)
      ?task.taskId:null,
    status,attempts,retries,totalToolStarts:totalTools,
    lastAction:latest,nextStep:NEXT[status]??"INSPECT_STATE",
    lastEventSeq,
  };
}
export function formatDurableProgress(progress) {
  const fields=[
    "[Progress] "+progress.status,
    "attempts="+progress.attempts,
    "retries="+progress.retries,
    "next="+progress.nextStep,
  ];
  if(progress.lastAction) {
    fields.push("action="+progress.lastAction.tool);
    fields.push("stage="+progress.lastAction.stage);
  }
  return fields.join(" ");
}
