// A bounded goal-wide execution budget. Reservations persist before work
// begins. A crashed or uncertain slice consumes its full reserved allowance.
const DEFAULTS=Object.freeze({
  maxElapsedMs:3600000,
  maxCalls:500,
  maxAttempts:500,
  maxConcurrent:1,
});
const LIMITS=Object.freeze({
  maxElapsedMs:[10,86400000],
  maxCalls:[1,100000],
  maxAttempts:[1,100000],
  maxConcurrent:[1,1],
});
function invalid() {
  return Object.assign(new Error("Unsafe goal resource budget"),
    {code:"ORCHESTRATOR_BUDGET_UNSAFE"});
}
function int(value,min,max) {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}
export function normalizeBudgetLimits(input=null) {
  if(input!==null&&(typeof input!=="object"||Array.isArray(input)))
    throw invalid();
  const source=input??{};
  if(Object.keys(source).some(k=>!(k in DEFAULTS)))throw invalid();
  const limits={};
  for(const [key,[min,max]] of Object.entries(LIMITS)){
    const value=source[key]??DEFAULTS[key];
    if(!int(value,min,max))throw invalid();
    limits[key]=value;
  }
  return limits;
}
export function makeGoalBudget(limits=null,priorCalls=0,legacySliceMs=0) {
  const configured=normalizeBudgetLimits(limits);
  if(!int(priorCalls,0,100000)||!int(legacySliceMs,0,300000))
    throw invalid();
  return {
    schema:1,limits:configured,
    used:{elapsedMs:Math.min(configured.maxElapsedMs,priorCalls*legacySliceMs),
      calls:priorCalls,attempts:priorCalls},
    active:0,reservedMs:0,
  };
}
export function validateGoalBudget(budget) {
  if(!budget||budget.schema!==1
    ||JSON.stringify(normalizeBudgetLimits(budget.limits))!==JSON.stringify(budget.limits)
    ||!budget.used||typeof budget.used!=="object"
    ||!int(budget.used.elapsedMs,0,86400000)
    ||!int(budget.used.calls,0,100000)
    ||!int(budget.used.attempts,0,100000)
    ||!int(budget.active,0,1)
    ||!int(budget.reservedMs,0,300000)
    ||(budget.active===0&&budget.reservedMs!==0)
    ||(budget.active===1&&budget.reservedMs<10))throw invalid();
  return budget;
}
export function budgetAllowance(budget,requestedMs) {
  validateGoalBudget(budget);
  if(!int(requestedMs,0,300000))throw invalid();
  if(budget.active!==0||budget.used.calls>=budget.limits.maxCalls
    ||budget.used.attempts>=budget.limits.maxAttempts)return 0;
  const remaining=Math.max(0,budget.limits.maxElapsedMs-budget.used.elapsedMs);
  const allowance=Math.min(requestedMs,remaining);
  return allowance>=10?allowance:0;
}
export function reserveGoalBudget(budget,requestedMs) {
  const allowed=budgetAllowance(budget,requestedMs);
  if(!allowed)throw Object.assign(new Error("Goal budget exhausted"),
    {code:"GOAL_BUDGET_EXHAUSTED"});
  budget.used.calls++;
  budget.used.attempts++;
  budget.used.elapsedMs+=allowed;
  budget.active=1;
  budget.reservedMs=allowed;
  return allowed;
}
export function settleGoalBudget(budget,elapsedMs,{uncertain=false}={}) {
  validateGoalBudget(budget);
  if(budget.active!==1)throw invalid();
  if(!Number.isFinite(elapsedMs)||elapsedMs<0)throw invalid();
  if(!uncertain) {
    const billed=Math.min(budget.reservedMs,Math.ceil(elapsedMs));
    budget.used.elapsedMs-=budget.reservedMs-billed;
  }
  budget.active=0;
  budget.reservedMs=0;
  return budget;
}
export function recoverOrphanedBudget(budget) {
  validateGoalBudget(budget);
  // Keep the full reservation charged; only release the stale active slot.
  budget.active=0;
  budget.reservedMs=0;
  return budget;
}
