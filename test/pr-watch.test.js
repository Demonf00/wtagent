import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  REPOSITORY, TRUSTED_AUTHOR, TRUSTED_BASE,
  parseWatchArgs, isTrustedCandidate, lookupCandidates,
  checkForPullRequests, loadWatchState, watchPullRequests,
} from "../scripts/watch-prs.js";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "1123456789abcdef0123456789abcdef01234567";

function candidate({ sha = SHA1, number = 13, labels = ["wtagent-verify"], ...changes } = {}) {
  return {
    number, state: "open", draft: false,
    user: { login: TRUSTED_AUTHOR },
    head: { sha, repo: { full_name: REPOSITORY } },
    base: { ref: TRUSTED_BASE, repo: { full_name: REPOSITORY } },
    labels: labels.map((name) => ({ name })),
    ...changes,
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-watch-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, "watch-state.json");
}

test("watcher requires explicit one-PR or one-label scope", () => {
  assert.deepEqual(parseWatchArgs(["--pr", "13", "--post-comment", "--once"]), {
    pr: 13, label: null, postComment: true, once: true, intervalSeconds: 60, syncAfterMerge: false,
  });
  assert.deepEqual(parseWatchArgs(["--label", "wtagent-verify", "--interval-seconds", "15"]), {
    pr: null, label: "wtagent-verify", postComment: false, once: false, intervalSeconds: 15, syncAfterMerge: false,
  });
  for (const input of [
    [], ["--pr", "0"], ["--pr", "1;whoami"], ["--label", "../../etc"],
    ["--pr", "13", "--label", "test"], ["--pr", "13", "--pr", "14"],
    ["--pr", "13", "--interval-seconds", "0"], ["--pr", "13", "--interval-seconds", "3601"],
    ["--pr", "13", "--post-comment", "--post-comment"],
    ["--pr", "13", "--sync-after-merge", "--sync-after-merge"],
  ]) assert.throws(() => parseWatchArgs(input), input.join(" "));
});

test("only same-repo owner PRs based on development branch are trusted", () => {
  assert.equal(isTrustedCandidate(candidate()), true);
  for (const value of [
    candidate({ state: "closed" }),
    candidate({ draft: true }),
    candidate({ user: { login: "other" } }),
    candidate({ head: { sha: SHA1, repo: { full_name: "attacker/wtagent" } } }),
    candidate({ base: { repo: { full_name: REPOSITORY }, ref: "main" } }),
    candidate({ head: { sha: "not-a-sha", repo: { full_name: REPOSITORY } } }),
    null,
  ]) assert.equal(isTrustedCandidate(value), false);
});

test("GitHub API lookup filters labels and rejects untrusted PRs without gh CLI", async () => {
  const calls = [];
  const request = async (route) => {
    calls.push(route);
    return [
      candidate({ number: 14 }),
      candidate({ number: 13 }),
      candidate({ number: 12, labels: ["other"] }),
      candidate({ number: 11, user: { login: "attacker" } }),
    ];
  };
  assert.deepEqual(await lookupCandidates({ label: "wtagent-verify", request }),
    [{ pr: 13, sha: SHA1 }, { pr: 14, sha: SHA1 }]);
  assert.deepEqual(calls, [
    "repos/" + REPOSITORY + "/pulls?state=open&per_page=100",
  ]);
});

test("same SHA is checked exactly once across repeated polls and process restarts", async (t) => {
  const stateFile = await fixture(t);
  const seen = [];
  let sha = SHA1;
  const verify = async ({ pr, expectedSha, postComment }) => {
    seen.push({ pr, expectedSha, postComment });
    return { ok: true, sha: expectedSha, commentPosted: true, reportPath: "/appdata/report.json" };
  };
  const args = {
    pr: 13, stateFile, postComment: true, verify,
    lookup: () => [{ pr: 13, sha }],
    log() {},
  };
  const first = await checkForPullRequests(args);
  assert.equal(first[0].status, "passed");
  assert.equal((await checkForPullRequests(args))[0].status, "unchanged");
  sha = SHA2;
  assert.equal((await checkForPullRequests(args))[0].status, "passed");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((x) => x.expectedSha), [SHA1, SHA2]);
  assert.equal(seen[0].postComment, true);
  const saved = await loadWatchState(stateFile);
  assert.equal(saved.verified["13"].sha, SHA2);
});

test("failing tests are checkpointed, and retried only after PR is updated", async (t) => {
  const stateFile = await fixture(t);
  let runs = 0;
  const args = {
    pr: 13, stateFile, lookup: () => [{ pr: 13, sha: SHA1 }],
    verify: async () => { runs++; return { ok: false, sha: SHA1, commentPosted: false }; },
    log() {},
  };
  assert.equal((await checkForPullRequests(args))[0].status, "failed");
  assert.equal((await checkForPullRequests(args))[0].status, "unchanged");
  assert.equal(runs, 1);
});

test("changed PR during fetch does not persist a false verification result", async (t) => {
  const stateFile = await fixture(t);
  let runs = 0;
  const args = {
    pr: 13, stateFile, lookup: () => [{ pr: 13, sha: SHA1 }],
    verify: async ({ expectedSha }) => {
      assert.equal(expectedSha, SHA1);
      runs++;
      return { ok: false, sha: SHA2, error: "PR head changed" };
    },
    log() {},
  };
  assert.equal((await checkForPullRequests(args))[0].status, "changed-during-fetch");
  assert.equal((await checkForPullRequests(args))[0].status, "changed-during-fetch");
  assert.equal(runs, 2);
  const state = await loadWatchState(stateFile);
  assert.deepEqual(state.verified, {});
});

test("infrastructure error does not claim verified status", async (t) => {
  const stateFile = await fixture(t);
  const result = await checkForPullRequests({
    pr: 13, stateFile, lookup: () => [{ pr: 13, sha: SHA1 }],
    verify: async () => { throw new Error("test runner unavailable"); },
    log() {},
  });
  assert.equal(result[0].status, "infrastructure-error");
  assert.deepEqual((await loadWatchState(stateFile)).verified, {});
});

test("CLI watcher bounded once mode performs one cycle", async () => {
  let cycles = 0;
  assert.equal(await watchPullRequests({
    pr: 13, once: true, intervalSeconds: 15,
  }, { check: async () => { cycles++; }, log() {} }), true);
  assert.equal(cycles, 1);
});

test("CLI watcher opt-in sync is disabled by default and runs only when enabled", async () => {
  assert.equal(parseWatchArgs(["--pr", "13", "--sync-after-merge"]).syncAfterMerge, true);
  let checked = 0;
  let synced = 0;
  const run = (syncAfterMerge) => watchPullRequests({
    pr: 13, once: true, intervalSeconds: 15, syncAfterMerge,
  }, {
    check: async () => { checked++; },
    syncMerged: async () => { synced++; },
    log() {},
  });
  await run(false);
  assert.equal(checked, 1);
  assert.equal(synced, 0);
  await run(true);
  assert.equal(checked, 2);
  assert.equal(synced, 1);
});
