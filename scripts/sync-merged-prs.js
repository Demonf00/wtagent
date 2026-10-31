/**
 * Safe, opt-in synchronization of merged and locally verified PRs.
 *
 * This updates SOURCE FILES ONLY, after a PR has already been merged by
 * an authorized actor. It never merges a PR on GitHub, reinstalls packages,
 * restarts a Worker, or writes over a dirty developer worktree.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { REPOSITORY, SOURCE_ROOT, runProgram } from "./verify-pr.js";

export const SYNC_BASE = "feat/self-extension";
export const SYNC_AUTHOR = "Demonf00";
const SHA = /^[0-9a-f]{40}$/i;

export function isMergedVerifiedPR(pr, candidate) {
  return Boolean(
    pr && typeof pr === "object"
    && Number.isSafeInteger(pr.number) && pr.number === candidate?.pr
    && pr.state === "closed" && pr.merged === true
    && pr.user?.login === SYNC_AUTHOR
    && pr.head?.repo?.full_name === REPOSITORY
    && pr.base?.repo?.full_name === REPOSITORY
    && pr.base?.ref === SYNC_BASE
    && SHA.test(pr.head?.sha ?? "")
    && pr.head.sha.toLowerCase() === candidate?.sha?.toLowerCase()
    && SHA.test(pr.merge_commit_sha ?? "")
  );
}

export function lookupMergedPR(pr, { run = runProgram, root = SOURCE_ROOT } = {}) {
  const response = run("gh", ["api", "repos/" + REPOSITORY + "/pulls/" + pr], root);
  if (response.code !== 0) throw new Error("GitHub PR status unavailable");
  try { return JSON.parse(response.stdout); }
  catch { throw new Error("Invalid GitHub PR status response"); }
}

/**
 * The git operations below deliberately require the local HEAD to be the
 * immediate first parent of the remote PR merge commit. If several merges
 * happened or the branch diverged, stop rather than implicitly trusting
 * unrelated commits.
 */
export async function fastForwardVerifiedMerge({
  mergeSha, root = SOURCE_ROOT, run = runProgram,
} = {}) {
  if (!SHA.test(mergeSha ?? "")) return { status: "blocked", reason: "BAD_MERGE_SHA" };

  const runGit = (args) => run("git", args, root);
  const expectedRoot = path.resolve(root);
  const marker = await fs.readFile(path.join(root, "AGENTS.md"), "utf8").catch(() => "");
  if (!marker.includes("<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->")) {
    return { status: "blocked", reason: "NOT_OPTED_IN" };
  }
  const repoRoot = runGit(["rev-parse", "--show-toplevel"]);
  if (repoRoot.code !== 0
    || path.resolve(repoRoot.stdout.trim()).toLowerCase() !== expectedRoot.toLowerCase()) {
    return { status: "blocked", reason: "WRONG_REPO_ROOT" };
  }
  const branch = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 || branch.stdout.trim() !== SYNC_BASE) {
    return { status: "blocked", reason: "WRONG_BRANCH" };
  }
  const dirty = runGit(["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty.code !== 0 || dirty.stdout.trim() !== "") {
    return { status: "blocked", reason: "DIRTY_WORKTREE" };
  }
  const previous = runGit(["rev-parse", "HEAD"]);
  if (previous.code !== 0 || !SHA.test(previous.stdout.trim())) {
    return { status: "blocked", reason: "LOCAL_SHA_UNAVAILABLE" };
  }

  const fetched = runGit([
    "fetch", "--no-tags",
    "https://github.com/" + REPOSITORY + ".git",
    "refs/heads/" + SYNC_BASE,
  ]);
  if (fetched.code !== 0) return { status: "blocked", reason: "FETCH_FAILED" };
  const remote = runGit(["rev-parse", "FETCH_HEAD"]);
  if (remote.code !== 0 || remote.stdout.trim().toLowerCase() !== mergeSha.toLowerCase()) {
    return { status: "blocked", reason: "REMOTE_MOVED_AFTER_MERGE" };
  }
  if (previous.stdout.trim().toLowerCase() === mergeSha.toLowerCase()) {
    return { status: "already-current", sha: mergeSha.toLowerCase() };
  }

  const parent = runGit(["rev-parse", "FETCH_HEAD^1"]);
  if (parent.code !== 0
    || parent.stdout.trim().toLowerCase() !== previous.stdout.trim().toLowerCase()) {
    return { status: "blocked", reason: "NOT_SINGLE_FAST_FORWARD" };
  }

  const merged = runGit(["merge", "--ff-only", "FETCH_HEAD"]);
  if (merged.code !== 0) return { status: "blocked", reason: "FAST_FORWARD_FAILED" };
  const updated = runGit(["rev-parse", "HEAD"]);
  if (updated.code !== 0 || updated.stdout.trim().toLowerCase() !== mergeSha.toLowerCase()) {
    return { status: "blocked", reason: "POST_SYNC_SHA_MISMATCH" };
  }
  return { status: "synced", sha: mergeSha.toLowerCase() };
}
