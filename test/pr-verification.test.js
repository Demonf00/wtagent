import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseArgs, verifyPullRequest, failedTestIdentifiers, REPOSITORY,
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
  const requests = [];
  const request = async (route, options) => {
    requests.push({ route, options });
    return { id: 123 };
  };
  const result = await verifyPullRequest({
    pr: 8, postComment: true, root, reportRoot: reports,
    run: fake.run, request, log() {},
  });
  assert.equal(result.commentPosted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route, "repos/" + REPOSITORY + "/issues/8/comments");
  assert.equal(requests[0].options.method, "POST");
  const body = requests[0].options.body.body;
  assert.match(body, /Check \| Exit/);
  assert.match(body, /Result: FAIL/);
  assert.match(body, /WT_VERIFY_V1 sha=0123456789abcdef0123456789abcdef01234567 result=FAIL/);
  assert.doesNotMatch(body, /PRIVATE_LOG_CONTENT/);
});


test("GitHub API failure cannot erase a completed local test report", async (t) => {
  const { root, reports } = await fixture(t);
  const fake = fakeRun(root);
  let requests = 0;
  const request = async () => {
    requests++;
    throw new Error("network unavailable");
  };
  const result = await verifyPullRequest({
    pr: 9, postComment: true, root, reportRoot: reports,
    run: fake.run, request, log() {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.commentPosted, false);
  assert.equal(requests, 1);
  assert.match(result.commentError, /GitHub API/);
  const saved = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
  assert.equal(saved.sha, SHA);
  assert.equal(saved.ok, true);
  assert.equal(saved.commentPosted, false);
});


test("SHA-pinned PR candidate refuses a moved head before executing candidate code", async (t) => {
  const { root, reports } = await fixture(t);
  const fake = fakeRun(root);
  const result = await verifyPullRequest({
    pr: 11, expectedSha: "1123456789abcdef0123456789abcdef01234567",
    postComment: true, root, reportRoot: reports,
    run: fake.run, log() {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /PR head changed/);
  assert.equal(fake.calls.some((item) =>
    item.program === "git" && item.args[0] === "worktree"), false);
  assert.equal(fake.calls.some((item) => item.program === "npm"), false);
  assert.equal(fake.calls.some((item) => item.program === "gh"), false);
});

test("expected SHA is validated before accessing GitHub", async (t) => {
  const { root, reports } = await fixture(t);
  const fake = fakeRun(root);
  await assert.rejects(verifyPullRequest({
    pr: 11, expectedSha: "wrong", root, reportRoot: reports,
    run: fake.run, log() {},
  }), /Expected PR SHA/);
  assert.equal(fake.calls.length, 0);
});


test("TAP failure identifiers exclude filesystem paths and private output", () => {
  const output = [
    "not ok 17 - C:\\Users\\archi\\secret-project\\test\\approval.test.js:77",
    "  error: actual password=ABCD123",
    "  stack: token=MY_SECRET_CREDENTIAL",
    "not ok 18 - safe test name",
    "not ok 19 - password=SECRET",
    "not ok 20 - https://example.com/private",
  ].join("\n");
  assert.deepEqual(failedTestIdentifiers(output), [
    "approval.test.js", "safe test name",
  ]);
});

test("GitHub PR feedback includes bounded failing test identifiers, never raw failure output", async (t) => {
  const { root, reports } = await fixture(t);
  const fake = fakeRun(root);
  const secret = "PRIVATE_SECRET_TEST_OUTPUT_998877";
  const run = (program, args, cwd) => {
    if (program === "npm" && args[0] === "test") {
      return {
        code: 1,
        stdout: [
          "not ok 13 - C:\\Users\\archi\\test\\approval.test.js",
          "  error: " + secret,
          "# tests 4", "# pass 3", "# fail 1", "# skipped 0",
        ].join("\n"),
        stderr: "provider text: " + secret,
      };
    }
    return fake.run(program, args, cwd);
  };
  const requests = [];
  const request = async (route, options) => {
    requests.push({ route, options });
    return { id: 123 };
  };
  const report = await verifyPullRequest({
    pr: 12, postComment: true, root, reportRoot: reports, run, request,
    checks: [{ name: "all-tests", program: "npm", args: ["test"] }],
    log() {},
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.steps[0].summary.failedTestIdentifiers, ["approval.test.js"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route, "repos/" + REPOSITORY + "/issues/12/comments");
  assert.equal(requests[0].options.method, "POST");
  const body = requests[0].options.body.body;
  assert.match(body, /Failed test identifiers/);
  assert.match(body, /approval\.test\.js/);
  assert.doesNotMatch(body, /PRIVATE_SECRET_TEST_OUTPUT_998877|Users|archi/);
});
