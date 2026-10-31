import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseArgs, verifyPullRequest, REPOSITORY,
} from "../scripts/verify-pr.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-verify-test-"));
  const root = path.join(base, "dev");
  const reports = path.join(base, "reports");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "AGENTS.md"),
    "<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->\n");
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { root, reports };
}

function fakeRun(root, { fail = null, comment = true } = {}) {
  const calls = [];
  const run = (program, args, cwd) => {
    calls.push({ program, args, cwd });
    if (program === "git" && args[0] === "rev-parse") {
      return { code: 0, stdout: args[1] === "--show-toplevel" ? root : SHA, stderr: "" };
    }
    if (program === "gh") return { code: comment ? 0 : 1, stdout: "", stderr: "" };
    const isFailed = program === "npm" && args[0] === fail;
    return { code: isFailed ? 1 : 0,
      stdout: "ℹ tests 2\nℹ pass " + (isFailed ? "1" : "2")
        + "\nℹ fail " + (isFailed ? "1" : "0") + "\nℹ skipped 0\n",
      stderr: isFailed ? "PRIVATE_LOG_CONTENT" : "",
    };
  };
  return { run, calls };
}

test("PR verifier accepts only explicit positive PR number and safe options", () => {
  assert.deepEqual(parseArgs(["--pr", "4"]), { pr: 4, postComment: false });
  assert.deepEqual(parseArgs(["--pr", "4", "--post-comment"]),
    { pr: 4, postComment: true });
  for (const args of [
    [], ["--pr"], ["--pr", "0"], ["--pr", "-1"], ["--pr", "abc"],
    ["--pr", "4;rm"], ["--pr", "4", "--pr", "5"], ["--repo", "other"],
  ]) assert.throws(() => parseArgs(args));
});

test("isolated PR verification runs checks, reports SHA, never merges or posts by default", async (t) => {
  const { root, reports } = await fixture(t);
  const fake = fakeRun(root);
  const result = await verifyPullRequest({
    pr: 4, root, reportRoot: reports, run: fake.run,
    log() {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.sha, SHA);
  assert.equal(result.steps.length, 5);
  assert.equal(result.commentPosted, false);
  assert.equal(result.browserSmoke, "NOT_RUN");
  assert.ok(fake.calls.some((item) => item.program === "git"
    && item.args[0] === "fetch"
    && item.args.includes("refs/pull/4/head")
    && item.args.includes("https://github.com/" + REPOSITORY + ".git")));
  assert.ok(fake.calls.some((item) => item.program === "git"
    && item.args[0] === "worktree" && item.args[1] === "add"));
  assert.ok(fake.calls.some((item) => item.program === "git"
    && item.args[0] === "worktree" && item.args[1] === "remove"));
  assert.equal(fake.calls.some((item) => item.program === "gh"), false);
  assert.equal(fake.calls.some((item) => item.args.includes("merge")
    || item.args.includes("publish") || item.args.includes("-g")), false);
  const written = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
  assert.equal(written.ok, true);
  assert.equal(written.steps[2].summary.pass, 2);
});

test("failed check blocks package and produces local failure report", async (t) => {
  const { root, reports } = await fixture(t);
  const fake = fakeRun(root, { fail: "run" });
  const result = await verifyPullRequest({
    pr: 7, root, reportRoot: reports, run: fake.run,
    log() {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 2);
  assert.equal(result.error, "Check failed: syntax");
  assert.equal(fake.calls.some((item) => item.args[0] === "pack"), false);
  assert.equal(result.commentPosted, false);
  assert.ok((await fs.readFile(result.reportPath, "utf8")).includes("Check failed: syntax"));
});

test("posting only occurs with opt-in and never includes raw test log", async (t) => {
  const { root, reports } = await fixture(t);
  const fake = fakeRun(root, { fail: "run" });
  const result = await verifyPullRequest({
    pr: 8, postComment: true, root, reportRoot: reports,
    run: fake.run, log() {},
  });
  assert.equal(result.commentPosted, true);
  const call = fake.calls.find((item) => item.program === "gh");
  assert.ok(call);
  assert.ok(call.args.includes("repos/" + REPOSITORY + "/issues/8/comments"));
  const body = call.args.find((arg) => arg.startsWith("body="));
  assert.match(body, /Check \| Exit/);
  assert.match(body, /Result: FAIL/);
  assert.doesNotMatch(body, /PRIVATE_LOG_CONTENT/);
});
