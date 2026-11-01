import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SYNC_BASE, SYNC_AUTHOR, isMergedVerifiedPR, fastForwardVerifiedMerge,
} from "../scripts/sync-merged-prs.js";
import {
  REPOSITORY, syncMergedVerifiedPullRequests, loadWatchState, saveWatchState,
} from "../scripts/watch-prs.js";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "1123456789abcdef0123456789abcdef01234567";
const SHA3 = "2123456789abcdef0123456789abcdef01234567";

function prInfo({
  pr = 10, sha = SHA1, mergeSha = SHA2,
  state = "closed", merged = true, author = SYNC_AUTHOR,
  headRepo = REPOSITORY, baseRepo = REPOSITORY, baseRef = SYNC_BASE,
} = {}) {
  return {
    number: pr, state, merged, merge_commit_sha: mergeSha,
    user: { login: author },
    head: { sha, repo: { full_name: headRepo } },
    base: { ref: baseRef, repo: { full_name: baseRepo } },
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-sync-test-"));
  await fs.writeFile(path.join(root, "AGENTS.md"),
    "<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, stateFile: path.join(root, "state.json") };
}

function fakeGit(root, {
  localSha = SHA1, remoteSha = SHA2, parentSha = SHA1,
  branch = SYNC_BASE, dirty = false, fetchCode = 0,
} = {}) {
  let head = localSha;
  const commands = [];
  const run = (program, args) => {
    assert.equal(program, "git");
    commands.push(args);
    if (args[0] === "rev-parse") {
      const query = args[1];
      return { code: 0, stdout:
        query === "--show-toplevel" ? root
        : query === "HEAD" ? head
        : query === "FETCH_HEAD" ? remoteSha
        : query === "FETCH_HEAD^1" ? parentSha
        : "", stderr: "" };
    }
    if (args[0] === "symbolic-ref") return { code: 0, stdout: branch + "\n", stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: dirty ? " M src/x.js\n" : "", stderr: "" };
    if (args[0] === "fetch") return { code: fetchCode, stdout: "", stderr: "" };
    if (args[0] === "merge") { head = remoteSha; return { code: 0, stdout: "", stderr: "" }; }
    throw new Error("Unexpected git: " + args.join(" "));
  };
  return { run, commands, get head() { return head; } };
}

test("merged PR must match exact locally verified SHA and trusted repository", () => {
  assert.equal(isMergedVerifiedPR(prInfo(), { pr: 10, sha: SHA1 }), true);
  for (const changed of [
    { state: "open" }, { merged: false }, { author: "attacker" },
    { headRepo: "fork/wtagent" }, { baseRepo: "fork/wtagent" },
    { baseRef: "main" }, { sha: SHA3 }, { mergeSha: "bad" },
  ]) {
    assert.equal(isMergedVerifiedPR(prInfo(changed), { pr: 10, sha: SHA1 }), false);
  }
  assert.equal(isMergedVerifiedPR(prInfo(), { pr: 11, sha: SHA1 }), false);
  assert.equal(isMergedVerifiedPR(prInfo(), { pr: 10, sha: SHA3 }), false);
});

test("clean opted-in development branch fast-forwards only to exact approved merge", async (t) => {
  const { root } = await fixture(t);
  const fake = fakeGit(root);
  const result = await fastForwardVerifiedMerge({ mergeSha: SHA2, root, run: fake.run });
  assert.deepEqual(result, { status: "synced", sha: SHA2 });
  assert.equal(fake.head, SHA2);
  assert.equal(fake.commands.filter((x) => x[0] === "merge").length, 1);
  assert.ok(fake.commands.some((x) => x.join(" ") ===
    "fetch --no-tags https://github.com/" + REPOSITORY + ".git refs/heads/" + SYNC_BASE));
  assert.equal(fake.commands.some((x) => x.includes("push") || x.includes("reset")), false);
});

test("already updated branch is recorded without another git merge", async (t) => {
  const { root } = await fixture(t);
  const fake = fakeGit(root, { localSha: SHA2 });
  assert.equal((await fastForwardVerifiedMerge({ mergeSha: SHA2, root, run: fake.run })).status,
    "already-current");
  assert.equal(fake.commands.some((x) => x[0] === "merge"), false);
});

for (const [name, settings, reason] of [
  ["dirty worktree", { dirty: true }, "DIRTY_WORKTREE"],
  ["wrong branch", { branch: "main" }, "WRONG_BRANCH"],
  ["remote advanced after merge", { remoteSha: SHA3 }, "REMOTE_MOVED_AFTER_MERGE"],
  ["unrelated previous merge", { parentSha: SHA3 }, "NOT_SINGLE_FAST_FORWARD"],
  ["failed fetch", { fetchCode: 1 }, "FETCH_FAILED"],
]) {
  test("sync refuses " + name, async (t) => {
    const { root } = await fixture(t);
    const fake = fakeGit(root, settings);
    const result = await fastForwardVerifiedMerge({ mergeSha: SHA2, root, run: fake.run });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, reason);
    assert.equal(fake.commands.some((x) => x[0] === "merge"), false);
  });
}

test("sync refuses checkout without explicit self-development opt-in", async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, "AGENTS.md"), "not opted in");
  const fake = fakeGit(root);
  assert.equal((await fastForwardVerifiedMerge({ mergeSha: SHA2, root, run: fake.run })).reason,
    "NOT_OPTED_IN");
  assert.equal(fake.commands.length, 0);
});

test("watcher syncs locally passing SHA once after trusted GitHub merge", async (t) => {
  const { stateFile } = await fixture(t);
  await saveWatchState(stateFile, {
    schema: 1, verified: {
      "10": { sha: SHA1, status: "passed", checkedAt: "2026-01-01T00:00:00Z" },
      "11": { sha: SHA3, status: "failed" },
    },
  });
  let syncCalls = 0, lookupCalls = 0;
  const options = {
    stateFile,
    lookup: async (pr) => { lookupCalls++; return prInfo({ pr }); },
    fastForward: async ({ mergeSha }) => {
      syncCalls++;
      assert.equal(mergeSha, SHA2);
      return { status: "synced", sha: SHA2 };
    },
    log() {},
  };
  const first = await syncMergedVerifiedPullRequests(options);
  assert.equal(first[0].status, "synced");
  assert.equal(syncCalls, 1);
  assert.equal(lookupCalls, 1);
  const state = await loadWatchState(stateFile);
  assert.equal(state.verified["10"].syncedSha, SHA1);
  assert.equal(state.verified["11"].syncedSha, undefined);
  assert.deepEqual(await syncMergedVerifiedPullRequests(options), []);
  assert.equal(syncCalls, 1);
});

test("blocked merge sync stays pending and retries after worktree is made clean", async (t) => {
  const { stateFile } = await fixture(t);
  await saveWatchState(stateFile, {
    schema: 1, verified: { "10": { sha: SHA1, status: "passed" } },
  });
  let attempts = 0;
  const options = {
    stateFile,
    lookup: () => prInfo(),
    fastForward: async () => {
      attempts++;
      return attempts === 1
        ? { status: "blocked", reason: "DIRTY_WORKTREE" }
        : { status: "synced", sha: SHA2 };
    },
    log() {},
  };
  assert.equal((await syncMergedVerifiedPullRequests(options))[0].reason, "DIRTY_WORKTREE");
  assert.equal((await loadWatchState(stateFile)).verified["10"].syncedSha, undefined);
  assert.equal((await syncMergedVerifiedPullRequests(options))[0].status, "synced");
  assert.equal(attempts, 2);
});
