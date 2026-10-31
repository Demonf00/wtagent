#!/usr/bin/env node
/**
 * Verify a GitHub PR in a disposable Git worktree. This deliberately never
 * checks out, merges, releases, or globally installs the candidate.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveLaunchPlan } from "../src/platform/command-launcher.js";

export const REPOSITORY = "Demonf00/wtagent";
export const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const CHECKS = Object.freeze([
  { name: "install", program: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] },
  { name: "syntax", program: "npm", args: ["run", "check"] },
  { name: "supervisor-regression", program: "node", args: [
    "--test", "test/supervisor-worker.test.js", "test/supervisor-lifecycle.test.js",
    "test/supervisor-recovery.test.js", "test/supervisor-conversation-cleanup.test.js",
    "test/cli-supervisor-integration.test.js", "test/supervisor-approval-sync.test.js",
    "test/browser-adapter.test.js",
  ] },
  { name: "all-tests", program: "npm", args: ["test"] },
  { name: "package-dry-run", program: "npm", args: ["pack", "--dry-run", "--ignore-scripts"] },
]);

function requiredNumber(pr) {
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error("PR number must be a positive integer.");
  }
  return pr;
}

export function parseArgs(args) {
  let pr = null;
  let postComment = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pr") {
      if (pr !== null || !/^[1-9][0-9]*$/.test(args[i + 1] ?? "")) {
        throw new Error("Specify exactly one --pr <positive integer>.");
      }
      pr = requiredNumber(Number(args[++i]));
    } else if (args[i] === "--post-comment") {
      if (postComment) throw new Error("--post-comment specified twice.");
      postComment = true;
    } else {
      throw new Error("Unknown verification argument: " + args[i]);
    }
  }
  requiredNumber(pr);
  return { pr, postComment };
}

export function runProgram(program, args, cwd) {
  const plan = resolveLaunchPlan({ program, argv: args, cwd });
  const result = spawnSync(plan.command, plan.args, {
    cwd, encoding: "utf8", windowsHide: true, timeout: 600000,
    maxBuffer: 16 * 1024 * 1024, shell: false,
    windowsVerbatimArguments: plan.windowsVerbatimArguments === true,
  });
  return {
    code: result.error ? -1 : (result.status ?? -1),
    stdout: result.stdout ?? "",
    stderr: result.error ? result.error.message : (result.stderr ?? ""),
  };
}

function summary(result) {
  const output = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  const counts = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:#|ℹ)\s*(tests|pass|fail|skipped)\s+(\d+)\s*$/);
    if (match) counts[match[1]] = Number(match[2]);
  }
  return { exitCode: result.code, ...counts };
}

function commentBody(report) {
  const lines = [
    "<!-- WT_VERIFY_V1 sha=" + (report.sha ?? "unknown")
      + " result=" + (report.ok ? "PASS" : "FAIL") + " -->",
    "WTAgent Windows PR verification (isolated worktree)",
    "",
    "PR: #" + report.pr,
    "Candidate: " + (report.sha ?? "fetch failed"),
    "Platform: " + process.platform + ", Node " + process.version,
    "Result: " + (report.ok ? "PASS" : "FAIL"),
    "",
    "| Check | Exit | Tests | Passed | Failed | Skipped |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const step of report.steps) {
    const c = step.summary;
    lines.push("| " + step.name + " | " + c.exitCode
      + " | " + (c.tests ?? "-") + " | " + (c.pass ?? "-")
      + " | " + (c.fail ?? "-") + " | " + (c.skipped ?? "-") + " |");
  }
  lines.push("", "Browser/authenticated live smoke: NOT RUN (requires separate explicit approval).");
  lines.push("Candidate was NOT merged, installed, released, or published.");
  return lines.join("\n");
}

export async function verifyPullRequest({
  pr, postComment = false, expectedSha = null, root = SOURCE_ROOT, reportRoot = null,
  run = runProgram, checks = CHECKS, log = console.log,
} = {}) {
  requiredNumber(pr);
  if (expectedSha !== null && !/^[0-9a-f]{40}$/i.test(expectedSha)) {
    throw new Error("Expected PR SHA must be a full 40-character commit ID.");
  }
  const rootPath = path.resolve(root);
  const agents = await fs.readFile(path.join(rootPath, "AGENTS.md"), "utf8");
  if (!agents.includes("<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->")) {
    throw new Error("Verification requires the opted-in WTAgent development source.");
  }
  const gitRoot = run("git", ["rev-parse", "--show-toplevel"], rootPath);
  if (gitRoot.code !== 0 || path.resolve(gitRoot.stdout.trim()).toLowerCase()
    !== rootPath.toLowerCase()) {
    throw new Error("Verification must run from the source Git repository root.");
  }

  const targetReports = path.resolve(reportRoot
    ?? path.join(process.env.APPDATA || os.tmpdir(), "wtagent", "pr-verifications"));
  await fs.mkdir(targetReports, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-pr-"));
  const worktree = path.join(temp, "candidate");
  const report = {
    schema: 1, repository: REPOSITORY, pr, sha: null,
    platform: process.platform, node: process.version,
    startedAt: new Date().toISOString(), steps: [],
    ok: false, browserSmoke: "NOT_RUN", commentPosted: false,
  };
  let attached = false;
  const runChecked = (program, args, cwd, name) => {
    const result = run(program, args, cwd);
    if (result.code !== 0) {
      throw new Error(name + " failed (exit " + result.code + "): "
        + (result.stderr || result.stdout || "").slice(-500));
    }
    return result;
  };
  try {
    runChecked("git", ["fetch", "--no-tags",
      "https://github.com/" + REPOSITORY + ".git",
      "refs/pull/" + pr + "/head"], rootPath, "PR fetch");
    const revision = runChecked("git", ["rev-parse", "FETCH_HEAD"], rootPath, "Revision").stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("Invalid PR commit SHA.");
    report.sha = revision;
    if (expectedSha && revision.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new Error("PR head changed before verification; candidate SHA mismatch.");
    }
    runChecked("git", ["worktree", "add", "--detach", worktree, revision], rootPath, "Worktree");
    attached = true;

    for (const step of checks) {
      log("[verify-pr] " + step.name + " for " + revision.slice(0, 12));
      const result = run(step.program, step.args, worktree);
      const counts = summary(result);
      report.steps.push({ name: step.name, summary: counts });
      // Raw output stays on this machine, never goes into a public PR comment.
      await fs.writeFile(path.join(targetReports,
        "pr-" + pr + "-" + revision.slice(0, 12) + "-" + step.name + ".log"),
        ((result.stdout ?? "") + "\n" + (result.stderr ?? "")).slice(-2_000_000), "utf8");
      if (result.code !== 0 || (counts.fail ?? 0) > 0) {
        report.error = "Check failed: " + step.name;
        break;
      }
    }
    report.ok = report.steps.length === checks.length && !report.error;
  } catch (error) {
    report.error = String(error.message ?? error);
  } finally {
    if (attached) {
      const removed = run("git", ["worktree", "remove", "--force", worktree], rootPath);
      if (removed.code !== 0) {
        report.cleanupError = "Git worktree removal failed";
        report.ok = false;
      }
    }
    if (!attached || !report.cleanupError) {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    }
    report.finishedAt = new Date().toISOString();
    // Keep only local metadata and test counts in public comments.
    const name = "pr-" + pr + "-" + (report.sha?.slice(0, 12) ?? "fetch-failed");
    report.reportPath = path.join(targetReports, name + ".json");
    if (postComment && !report.error?.startsWith("PR head changed")) {
      const body = commentBody(report);
      try {
        const result = run("gh", [
          "api", "repos/" + REPOSITORY + "/issues/" + pr + "/comments",
          "-f", "body=" + body,
        ], rootPath);
        report.commentPosted = result.code === 0;
      } catch {
        report.commentPosted = false;
      }
      if (!report.commentPosted) {
        report.commentError = "GitHub CLI comment post failed; check gh auth status";
      }
    }
    await fs.writeFile(report.reportPath, JSON.stringify(report, null, 2) + "\n");
    log("[verify-pr] " + (report.ok ? "PASS" : "FAIL")
      + " PR #" + pr + " candidate=" + (report.sha ?? "unknown"));
    log("[verify-pr] report: " + report.reportPath);
    if (postComment) log("[verify-pr] PR comment: " + (report.commentPosted ? "posted" : "NOT posted"));
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await verifyPullRequest(options);
    process.exitCode = result.ok && (!options.postComment || result.commentPosted) ? 0 : 1;
  } catch (error) {
    console.error("[verify-pr] " + error.message);
    process.exitCode = 1;
  }
}
