#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolveLaunchPlan } from "../src/platform/command-launcher.js";

export const DEFAULT_UPGRADE_FILES = [
  "AGENTS.md",
  "skills/self-improve/SKILL.md",
  "src/protocol/project-instructions.js",
  "src/protocol/prompt-builder.js",
  "src/runtime/agent-runtime.js",
  "src/cli/main.js",
  "src/cli/startup-notices.js",
  "test/self-development.test.js",
  "scripts/self-release.js",
  "scripts/self-release.ps1",
  "test/self-release.test.js",
];

export const REQUIRED_ARCHIVE_FILES = [
  "package/package.json",
  "package/src/cli/main.js",
  "package/src/runtime/agent-runtime.js",
  "package/src/tools/registry.js",
  "package/src/tools/default-tools.js",
  "package/src/tools/browser-tools.js",
  "package/src/protocol/project-instructions.js",
];

const CHECKS = [
  { name: "syntax", cmd: "npm", args: ["run", "check"] },
  { name: "unit", cmd: "npm", args: ["run", "test:unit"] },
  { name: "integration", cmd: "npm", args: ["run", "test:integration"] },
  { name: "windows", cmd: "npm", args: ["run", "test:windows"] },
  { name: "browser-smoke", cmd: "node", args: ["--test", "test/browser-tools.test.js", "test/cdp-browser.test.js"] },
  { name: "self-release-regressions", cmd: "node", args: ["--test", "test/self-development.test.js", "test/self-release.test.js"], noSkips: true },
  { name: "all-tests", cmd: "npm", args: ["test"] },
];

export function runProgram(cmd, args, cwd) {
  // Reuse WTAgent's tested Windows .cmd launch planner. Never let Node
  // concatenate unescaped arguments into shell:true command strings.
  const plan = resolveLaunchPlan({ program: cmd, argv: args, cwd });
  const result = spawnSync(plan.command, plan.args, {
    cwd,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: plan.windowsVerbatimArguments === true,
  });
  if (result.error) return { code: -1, stdout: "", stderr: result.error.message };
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function requireSuccess(result, operation) {
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(-1800);
    throw new Error(`${operation} failed (exit ${result.code}): ${detail}`);
  }
  // Preserve leading spaces: Git porcelain uses them as meaningful status
  // columns, e.g. " M src/cli/main.js" for a tracked unstaged change.
  return (result.stdout || "").trimEnd();
}

function safeRelative(file) {
  if (typeof file !== "string" || !file || path.isAbsolute(file) ||
      file.includes("\0") || file.includes("\\") ||
      file.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`Invalid upgrade path: ${file}`);
  }
  return file;
}

function parseCounts(output) {
  const counts = { tests: null, pass: null, fail: null, skipped: null };
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:#|ℹ)\s*(tests|pass|fail|skipped)\s+(\d+)\s*$/);
    if (match) counts[match[1]] = Number(match[2]);
  }
  return counts;
}

/** Read the archive bytes rather than trusting npm's metadata or a mocked file list. */
export function inspectArchive(data) {
  const tar = gunzipSync(data, { maxOutputLength: 200 * 1024 * 1024 });
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const string = (start, end) => header.subarray(start, end).toString("utf8").split("\0")[0];
    const filename = string(0, 100);
    const prefix = string(345, 500);
    const name = prefix ? `${prefix}/${filename}` : filename;
    const size = parseInt(string(124, 136).trim() || "0", 8);
    if (!name || !Number.isSafeInteger(size) || size < 0 ||
        offset + 512 + size > tar.length || entries.has(name)) {
      throw new Error("Invalid or duplicated tar entry");
    }
    const type = string(156, 157);
    if (type === "" || type === "0") {
      entries.set(name, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function sameRoot(a, b) {
  const x = fs.realpathSync(a);
  const y = fs.realpathSync(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

async function assertRepository(root, run) {
  if (path.basename(root).toLowerCase() !== "wtagent-selfdev") {
    throw new Error("Release is restricted to a wtagent-selfdev development checkout");
  }
  const gitRoot = requireSuccess(run("git", ["rev-parse", "--show-toplevel"], root), "Git root");
  if (!sameRoot(gitRoot, root)) throw new Error("Script must run at the intended Git repository root");
  const branch = requireSuccess(run("git", ["branch", "--show-current"], root), "Git branch");
  if (!branch || branch === "main" || branch === "master") {
    throw new Error(`Refusing release on detached/protected branch: ${branch || "(detached)"}`);
  }
  const agents = await fsp.readFile(path.join(root, "AGENTS.md"), "utf8");
  if (!agents.includes("<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->")) {
    throw new Error("Missing explicit self-development opt-in");
  }
  const pkg = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
  if (pkg.name !== "wtagent" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error("Unexpected package identity/version");
  }
  return { branch, pkg };
}

export async function release({
  repositoryRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url))),
  releaseDir,
  upgradeFiles = DEFAULT_UPGRADE_FILES,
  run = runProgram,
  log = console.log,
  checks = CHECKS,
} = {}) {
  const root = path.resolve(repositoryRoot);
  const archiveDir = path.resolve(releaseDir ?? path.join(path.dirname(root), "wtagent-releases"));
  const summaries = [];
  let phase = "repository checks";
  let version = null;
  let packagePath = null;
  try {
    const { branch, pkg } = await assertRepository(root, run);
    if (archiveDir === root || archiveDir.startsWith(root + path.sep)) {
      throw new Error("Release directory must be outside the Git worktree");
    }
    const explicit = [...new Set([...upgradeFiles.map(safeRelative), "package.json", "package-lock.json"])];
    const staged = requireSuccess(run("git", ["diff", "--cached", "--name-only"], root), "staged file check");
    if (staged) throw new Error("Pre-existing staged changes detected. Unstage them before release.");
    const changed = requireSuccess(run("git", ["status", "--porcelain", "--untracked-files=all"], root), "worktree status")
      .split(/\r?\n/).filter(Boolean);
    const changedPaths = changed.map((line) => line.slice(3).replaceAll("\\", "/"));
    const scopedChanges = changedPaths.filter((file) => explicit.includes(file));
    if (scopedChanges.length === 0) throw new Error("No scoped upgrade changes to release");
    // Never package unrelated modified source files: npm packs src/ by default.
    const unscoped = changedPaths.filter((file) => !explicit.includes(file));
    if (unscoped.some((file) => file.startsWith("src/") || file === "package.json" || file === "package-lock.json")) {
      throw new Error("Unscoped runtime or manifest changes would contaminate the package");
    }
    log(`Development branch: ${branch}, current version: ${pkg.version}`);
    for (const check of checks) {
      phase = `validation: ${check.name}`;
      const result = run(check.cmd, check.args, root);
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      const counts = parseCounts(output);
      const summary = { name: check.name, code: result.code, ...counts };
      summaries.push(summary);
      log(`[${check.name}] exit=${result.code} pass=${counts.pass ?? "n/a"} fail=${counts.fail ?? "n/a"} skipped=${counts.skipped ?? "n/a"}`);
      if (result.code !== 0 || (counts.fail ?? 0) > 0 ||
          (check.noSkips && (counts.skipped == null || counts.skipped > 0)) ||
          (check.noSkips && (counts.tests == null || counts.tests === 0))) {
        throw new Error(`Required check ${check.name} did not pass: ${output.trim().slice(-1800)}`);
      }
    }
    phase = "version bump";
    const bump = requireSuccess(run("npm", ["version", "patch", "--no-git-tag-version", "--ignore-scripts"], root), phase);
    const nextPkg = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
    version = nextPkg.version;
    if (version === pkg.version || bump.replace(/^v/, "").trim() !== version) {
      throw new Error("npm version did not update the manifest consistently");
    }
    const lock = JSON.parse(await fsp.readFile(path.join(root, "package-lock.json"), "utf8"));
    if (lock.version !== version || lock.packages?.[""]?.version !== version) {
      throw new Error("package-lock.json version does not match the new package");
    }
    phase = "npm pack";
    await fsp.mkdir(archiveDir, { recursive: true });
    const packed = requireSuccess(run("npm", [
      "pack", "--json", "--ignore-scripts", "--pack-destination", archiveDir,
    ], root), phase);
    let packInfo;
    try { packInfo = JSON.parse(packed); } catch { throw new Error("Invalid npm pack JSON output"); }
    const filename = packInfo?.[0]?.filename;
    if (typeof filename !== "string" || !/^wtagent-[\w.-]+\.tgz$/.test(filename)) {
      throw new Error("npm pack returned an unexpected archive filename");
    }
    packagePath = path.join(archiveDir, filename);
    const archive = await fsp.readFile(packagePath);
    const entries = inspectArchive(archive);
    for (const required of REQUIRED_ARCHIVE_FILES) {
      if (!entries.has(required)) throw new Error(`Archive missing required file: ${required}`);
    }
    const archivedManifest = JSON.parse(entries.get("package/package.json").toString("utf8"));
    if (archivedManifest.name !== "wtagent" || archivedManifest.version !== version) {
      throw new Error("Archive manifest does not match new version");
    }
    phase = "Git staging";
    const include = explicit.filter((file) => changedPaths.includes(file) || ["package.json", "package-lock.json"].includes(file));
    requireSuccess(run("git", ["add", "--", ...include], root), phase);
    const actuallyStaged = requireSuccess(run("git", ["diff", "--cached", "--name-only"], root), "Git staged verification")
      .split(/\r?\n/).filter(Boolean).map((p) => p.replaceAll("\\", "/"));
    if (actuallyStaged.length === 0 || actuallyStaged.some((file) => !explicit.includes(file))) {
      throw new Error("Git staging did not match the explicit upgrade file scope");
    }
    phase = "Git commit";
    requireSuccess(run("git", ["commit", "-m", `self-improve: release ${version} (${scopedChanges.length} upgrade files)`], root), phase);
    const sha = requireSuccess(run("git", ["rev-parse", "HEAD"], root), "Git commit SHA");
    phase = "Git version tag";
    const tag = `selfdev-v${version}`;
    requireSuccess(run("git", ["tag", "-a", tag, "-m", `Validated WTAgent self-development ${version}`], root), phase);
    log(`SUCCESS version=${version} commit=${sha} tag=${tag}`);
    log(`Package: ${packagePath}`);
    log(`Restart: cd "${root}"; node .\\src\\cli\\main.js -C "${root}"`);
    log(`No global install, publish or push was performed.`);
    return { ok: true, version, sha, tag, packagePath, summaries, stagedFiles: actuallyStaged };
  } catch (error) {
    log(`RELEASE INCOMPLETE at ${phase}: ${error.message}`);
    if (version) log(`Local candidate version: ${version}`);
    if (packagePath) log(`Candidate archive (not necessarily released): ${packagePath}`);
    log("Recover using the current working tree, Git history and any retained archive; no global version was changed.");
    return { ok: false, error: error.message, phase, version, packagePath, summaries };
  }
}

function parseArgs(argv) {
  const options = { upgradeFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file" && argv[i + 1]) options.upgradeFiles.push(argv[++i]);
    else if (argv[i] === "--release-dir" && argv[i + 1]) options.releaseDir = argv[++i];
    else if (argv[i] === "--help") { options.help = true; }
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!options.upgradeFiles.length) delete options.upgradeFiles;
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/self-release.js [--file <relative-upgrade-path> ...] [--release-dir <outside-Git-path>]");
    } else {
      const result = await release(options);
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(`RELEASE INCOMPLETE: ${error.message}`);
    process.exitCode = 1;
  }
}
