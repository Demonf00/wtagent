import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  inspectArchive,
  REQUIRED_ARCHIVE_FILES,
  release,
  runProgram,
} from "../scripts/self-release.js";

function git(root, ...args) {
  const result = runProgram("git", args, root);
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function archiveFor(version, files = REQUIRED_ARCHIVE_FILES) {
  const manifest = JSON.stringify({ name: "wtagent", version });
  const blocks = [];
  for (const name of files) {
    const contents = Buffer.from(name === "package/package.json" ? manifest : `fixture: ${name}`);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(contents.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, contents);
    if (contents.length % 512) blocks.push(Buffer.alloc(512 - (contents.length % 512)));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function fixture(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "wtagent-release-test-"));
  t.after(async () => await fsp.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "wtagent-selfdev");
  await fsp.mkdir(path.join(root, "src", "cli"), { recursive: true });
  const manifest = { name: "wtagent", version: "1.0.2", files: ["src"] };
  const lock = {
    name: "wtagent", version: "1.0.2", lockfileVersion: 3,
    packages: { "": { name: "wtagent", version: "1.0.2" } },
  };
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock, null, 2));
  await fsp.writeFile(path.join(root, "AGENTS.md"), "<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->\n");
  await fsp.writeFile(path.join(root, "src", "cli", "main.js"), "// baseline\n");
  git(root, "init");
  git(root, "checkout", "-b", "feat/release-test");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "config", "user.name", "Release test");
  git(root, "add", "--", "package.json", "package-lock.json", "AGENTS.md", "src/cli/main.js");
  git(root, "commit", "-m", "fixture baseline");
  await fsp.writeFile(path.join(root, "src", "cli", "main.js"), "// next capability\n");
  await fsp.writeFile(path.join(root, "personal-secret.txt"), "should not be committed");
  return { root, base, archiveDir: path.join(base, "persistent-releases") };
}

function simulatedRunner(options = {}) {
  const calls = [];
  let testCalls = 0;
  const run = (program, args, cwd) => {
    calls.push([program, ...args]);
    if (program === "git") return runProgram(program, args, cwd);
    if (program === "npm" && args[0] === "version") {
      const file = path.join(cwd, "package.json");
      const lockFile = path.join(cwd, "package-lock.json");
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      const [major, minor, patch] = pkg.version.split(".").map(Number);
      const next = `${major}.${minor}.${patch + 1}`;
      pkg.version = next;
      lock.version = next;
      lock.packages[""].version = next;
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
      fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2));
      return { code: 0, stdout: `v${next}\n`, stderr: "" };
    }
    if (program === "npm" && args[0] === "pack") {
      const dest = args[args.indexOf("--pack-destination") + 1];
      const version = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version;
      const filename = `wtagent-${version}.tgz`;
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, filename),
        archiveFor(version, options.archiveFiles ?? REQUIRED_ARCHIVE_FILES));
      return { code: 0, stdout: JSON.stringify([{ filename }]), stderr: "" };
    }
    testCalls++;
    const failed = options.failTest && testCalls === 1;
    const skipped = options.skipTest && testCalls === 1;
    return {
      code: failed ? 1 : 0,
      stdout: `ℹ tests 2\nℹ pass ${failed ? 1 : skipped ? 1 : 2}\nℹ fail ${failed ? 1 : 0}\nℹ skipped ${skipped ? 1 : 0}\n`,
      stderr: "",
    };
  };
  return { run, calls };
}

const tests = [
  { name: "syntax", cmd: "npm", args: ["run", "check"] },
  { name: "required-integration", cmd: "node", args: ["--test", "integration.test.js"], noSkips: true },
];

test("tarball inspector reads actual gzip archive entries", () => {
  const entries = inspectArchive(archiveFor("1.0.3"));
  assert.equal(entries.size, REQUIRED_ARCHIVE_FILES.length);
  assert.equal(JSON.parse(entries.get("package/package.json").toString()).version, "1.0.3");
  assert.throws(() => inspectArchive(Buffer.from("not an archive")));
});

test("a failing required check stops before version, package, commit or tag", async (t) => {
  const { root, archiveDir } = await fixture(t);
  const original = git(root, "rev-parse", "HEAD");
  const mock = simulatedRunner({ failTest: true });
  const result = await release({
    repositoryRoot: root, releaseDir: archiveDir,
    upgradeFiles: ["src/cli/main.js"], checks: tests, run: mock.run, log() {},
  });
  assert.equal(result.ok, false);
  assert.match(result.phase, /validation/);
  assert.equal(git(root, "rev-parse", "HEAD"), original);
  assert.equal(JSON.parse(await fsp.readFile(path.join(root, "package.json"))).version, "1.0.2");
  assert.equal(mock.calls.some(([program, action]) => program === "npm" && action === "pack"), false);
  assert.equal(git(root, "tag", "--list", "selfdev-v*"), "");
});

test("a skipped required feature fails closed before packaging and committing", async (t) => {
  const { root, archiveDir } = await fixture(t);
  const original = git(root, "rev-parse", "HEAD");
  const mock = simulatedRunner({ skipTest: true });
  const result = await release({
    repositoryRoot: root, releaseDir: archiveDir,
    upgradeFiles: ["src/cli/main.js"], checks: [tests[1]],
    run: mock.run, log() {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Required check/);
  assert.equal(git(root, "rev-parse", "HEAD"), original);
  assert.equal(mock.calls.some(([program, action]) => program === "npm" && action === "pack"), false);
});

test("successful validation packages, verifies, commits and tags only scoped changes", async (t) => {
  const { root, archiveDir } = await fixture(t);
  const original = git(root, "rev-parse", "HEAD");
  const mock = simulatedRunner();
  const result = await release({
    repositoryRoot: root, releaseDir: archiveDir,
    upgradeFiles: ["src/cli/main.js"], checks: tests,
    run: mock.run, log() {},
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.version, "1.0.3");
  assert.notEqual(result.sha, original);
  assert.equal(result.sha, git(root, "rev-parse", "HEAD"));
  assert.equal(git(root, "tag", "--list", "selfdev-v1.0.3"), "selfdev-v1.0.3");
  assert.ok(fs.existsSync(result.packagePath));
  assert.ok(result.packagePath.startsWith(archiveDir));
  assert.deepEqual(result.stagedFiles.sort(), ["package-lock.json", "package.json", "src/cli/main.js"]);
  const committed = git(root, "show", "--pretty=format:", "--name-only", "HEAD").split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(committed, result.stagedFiles.sort());
  assert.ok(fs.existsSync(path.join(root, "personal-secret.txt")));
  assert.match(git(root, "status", "--short"), /personal-secret\.txt/);
  assert.deepEqual(result.summaries.map((s) => s.code), [0, 0]);
});

test("missing required runtime files in tgz blocks commit and preserves candidate", async (t) => {
  const { root, archiveDir } = await fixture(t);
  const original = git(root, "rev-parse", "HEAD");
  const mock = simulatedRunner({
    archiveFiles: REQUIRED_ARCHIVE_FILES.filter((name) => name !== "package/src/runtime/agent-runtime.js"),
  });
  const result = await release({
    repositoryRoot: root, releaseDir: archiveDir,
    upgradeFiles: ["src/cli/main.js"], checks: tests,
    run: mock.run, log() {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Archive missing required file/);
  assert.equal(git(root, "rev-parse", "HEAD"), original);
  assert.equal(JSON.parse(await fsp.readFile(path.join(root, "package.json"))).version, "1.0.3");
  assert.ok(fs.existsSync(result.packagePath));
});

test("unscoped modified source blocks release before packaging", async (t) => {
  const { root, archiveDir } = await fixture(t);
  await fsp.mkdir(path.join(root, "src", "tools"), { recursive: true });
  await fsp.writeFile(path.join(root, "src", "tools", "unrelated.js"), "unrelated source");
  const mock = simulatedRunner();
  const result = await release({
    repositoryRoot: root, releaseDir: archiveDir,
    upgradeFiles: ["src/cli/main.js"], checks: tests,
    run: mock.run, log() {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unscoped runtime/);
  assert.equal(mock.calls.some(([program, action]) => program === "npm" && action === "pack"), false);
});
