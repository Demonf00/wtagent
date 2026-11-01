#!/usr/bin/env node
/**
 * Dedicated local PR verification coordinator. This process is independent
 * from the WTAgent Supervisor/Worker being tested.
 *
 * Explicit --pr or --label scope. Same-repo, same-author and fixed-base
 * checks are mandatory before any candidate code is run.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { REPOSITORY, SOURCE_ROOT, runProgram, verifyPullRequest } from "./verify-pr.js";
import { fastForwardVerifiedMerge, isMergedVerifiedPR, lookupMergedPR } from "./sync-merged-prs.js";
import { githubApi } from "./github-api.js";
export { REPOSITORY } from "./verify-pr.js";

export const TRUSTED_AUTHOR = "Demonf00";
export const TRUSTED_BASE = "feat/self-extension";
export const DEFAULT_INTERVAL_SECONDS = 60;
const SHA = /^[0-9a-f]{40}$/i;
const SAFE_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export function parseWatchArgs(argv) {
  let pr = null;
  let label = null;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let postComment = false;
  let syncAfterMerge = false;
  let once = false;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error("Duplicate argument: " + flag);
    seen.add(flag);
    if (flag === "--pr") {
      const value = argv[++i] ?? "";
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("Expected --pr <positive integer>");
      }
      pr = Number(value);
    } else if (flag === "--label") {
      const value = argv[++i] ?? "";
      if (!SAFE_LABEL.test(value)) throw new Error("Invalid PR label.");
      label = value;
    } else if (flag === "--interval-seconds") {
      const value = argv[++i] ?? "";
      if (!/^[0-9]+$/.test(value) || Number(value) < 15 || Number(value) > 3600) {
        throw new Error("--interval-seconds must be between 15 and 3600.");
      }
      intervalSeconds = Number(value);
    } else if (flag === "--once") {
      once = true;
    } else if (flag === "--post-comment") {
      postComment = true;
    } else if (flag === "--sync-after-merge") {
      syncAfterMerge = true;
    } else {
      throw new Error("Unknown PR watch argument: " + flag);
    }
  }
  if (Boolean(pr) === Boolean(label)) {
    throw new Error("Specify exactly one scope: --pr NUMBER or --label NAME.");
  }
  return { pr, label, intervalSeconds, postComment, once, syncAfterMerge };
}

export function isTrustedCandidate(item) {
  return item !== null
    && typeof item === "object"
    && Number.isSafeInteger(item.number) && item.number > 0
    && item.state === "open"
    && item.draft !== true
    && item.user?.login === TRUSTED_AUTHOR
    && item.head?.repo?.full_name === REPOSITORY
    && item.base?.repo?.full_name === REPOSITORY
    && item.base?.ref === TRUSTED_BASE
    && SHA.test(item.head?.sha ?? "");
}

export async function lookupCandidates({ pr = null, label = null, request = githubApi } = {}) {
  const route = pr == null
    ? "repos/" + REPOSITORY + "/pulls?state=open&per_page=100"
    : "repos/" + REPOSITORY + "/pulls/" + pr;
  const parsed = await request(route);
  const candidates = pr == null ? parsed : [parsed];
  if (!Array.isArray(candidates)) throw new Error("GitHub PR API returned the wrong shape.");
  return candidates.filter((item) =>
    isTrustedCandidate(item) &&
    (pr != null || item.labels?.some((entry) => entry.name === label))
  ).map((item) => ({
    pr: item.number,
    sha: item.head.sha.toLowerCase(),
  })).sort((a, b) => a.pr - b.pr);
}

export function defaultStatePath() {
  return path.join(process.env.APPDATA || os.tmpdir(), "wtagent", "pr-verifications", "watch-state.json");
}

export async function loadWatchState(file) {
  try {
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    if (state.schema !== 1 || !state.verified || typeof state.verified !== "object"
      || Array.isArray(state.verified)) throw new Error("Watch checkpoint format invalid.");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { schema: 1, verified: {} };
    throw error;
  }
}

export async function saveWatchState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * One bounded reconciliation pass. All durable progress is keyed by
 * (PR number, exact head SHA), so restarts and repeated polls are idempotent.
 * A failed test does not rerun the same commit forever; wait for a new SHA.
 */
export async function checkForPullRequests({
  pr = null, label = null, postComment = false,
  stateFile = defaultStatePath(),
  lookup = lookupCandidates,
  verify = verifyPullRequest,
  log = console.log,
} = {}) {
  const state = await loadWatchState(stateFile);
  const candidates = await lookup({ pr, label });
  const results = [];
  for (const candidate of candidates) {
    const key = String(candidate.pr);
    if (state.verified[key]?.sha === candidate.sha) {
      results.push({ pr: candidate.pr, sha: candidate.sha, status: "unchanged" });
      continue;
    }
    log("[watch-pr] verifying PR #" + candidate.pr + " @ " + candidate.sha.slice(0, 12));
    let report;
    try {
      report = await verify({
        pr: candidate.pr,
        expectedSha: candidate.sha,
        postComment,
      });
    } catch (error) {
      // A verifier crash or IO failure is NOT a verified candidate.
      log("[watch-pr] verification infrastructure error for #" + candidate.pr
        + ": " + String(error?.message ?? error));
      results.push({ ...candidate, status: "infrastructure-error" });
      continue;
    }
    if (report.sha?.toLowerCase() !== candidate.sha) {
      // The PR was pushed while the verifier was fetching. Re-read on next poll.
      results.push({ ...candidate, status: "changed-during-fetch" });
      continue;
    }
    const status = report.ok
      ? (postComment && !report.commentPosted ? "pass-feedback-failed" : "passed")
      : (postComment && !report.commentPosted ? "fail-feedback-failed" : "failed");
    state.verified[key] = {
      sha: candidate.sha, status,
      checkedAt: new Date().toISOString(),
      reportPath: report.reportPath ?? null,
    };
    await saveWatchState(stateFile, state);
    log("[watch-pr] PR #" + candidate.pr + ": " + status
      + (postComment ? (report.commentPosted ? " (feedback posted)" : " (feedback NOT posted)") : ""));
    results.push({ ...candidate, status });
  }
  return results;
}

/**
 * Sync only after a previously locally verified SHA is confirmed merged on
 * GitHub. Never sync a PR merely because its unit tests passed.
 */
export async function syncMergedVerifiedPullRequests({
  stateFile = defaultStatePath(),
  lookup = lookupMergedPR,
  fastForward = fastForwardVerifiedMerge,
  log = console.log,
} = {}) {
  const state = await loadWatchState(stateFile);
  const results = [];
  for (const [key, record] of Object.entries(state.verified)) {
    if (!["passed", "pass-feedback-failed"].includes(record?.status)
      || !SHA.test(record.sha ?? "") || record.syncedSha === record.sha) continue;
    const pr = Number(key);
    if (!Number.isSafeInteger(pr) || pr < 1) continue;
    let metadata;
    try {
      metadata = await lookup(pr);
    } catch (error) {
      results.push({ pr, status: "lookup-error" });
      log("[watch-pr] merged PR lookup failed for #" + pr);
      continue;
    }
    if (!isMergedVerifiedPR(metadata, { pr, sha: record.sha })) continue;
    let sync;
    try {
      sync = await fastForward({ mergeSha: metadata.merge_commit_sha });
    } catch (error) {
      sync = { status: "blocked", reason: "SYNC_INFRASTRUCTURE_ERROR" };
    }
    log("[watch-pr] sync PR #" + pr + ": " + sync.status
      + (sync.reason ? " (" + sync.reason + ")" : ""));
    results.push({ pr, ...sync });
    if (sync.status === "synced" || sync.status === "already-current") {
      record.syncedSha = record.sha;
      record.syncedAt = new Date().toISOString();
      await saveWatchState(stateFile, state);
    }
  }
  return results;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const aborted = () => { clearTimeout(timer); done(); };
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export async function watchPullRequests(options, {
  signal, check = checkForPullRequests,
  syncMerged = syncMergedVerifiedPullRequests, log = console.log,
} = {}) {
  do {
    try {
      await check({ ...options, log });
      if (options.syncAfterMerge) await syncMerged({ log });
    } catch (error) {
      log("[watch-pr] polling error: " + String(error?.message ?? error));
      if (options.once) return false;
    }
    if (options.once || signal?.aborted) break;
    await delay(options.intervalSeconds * 1000, signal);
  } while (!signal?.aborted);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseWatchArgs(process.argv.slice(2));
    const controller = new AbortController();
    for (const name of ["SIGINT", "SIGTERM"]) {
      process.once(name, () => controller.abort());
    }
    console.log("[watch-pr] Listening for trusted " + (options.pr ? "PR #" + options.pr : "label " + options.label)
      + ", polling every " + options.intervalSeconds + "s");
    console.log("[watch-pr] Candidate code runs with your local user permissions. Never run this elevated.");
    console.log("[watch-pr] PR merging, publishing, global install and authenticated browser smoke are disabled.");
    if (options.syncAfterMerge) console.log("[watch-pr] Post-merge fast-forward sync enabled for clean checked-out development branch only; running processes are NOT restarted.");
    if (!options.postComment) console.log("[watch-pr] Feedback is local only; add --post-comment to publish sanitized results.");
    const success = await watchPullRequests(options, { signal: controller.signal });
    if (!success) process.exitCode = 1;
  } catch (error) {
    console.error("[watch-pr] " + String(error?.message ?? error));
    process.exitCode = 1;
  }
}
