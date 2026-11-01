import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const INPUT_SCHEMA = 1;
const SOURCE_DIRS = [
  "src", "lib", "test", "tests", "scripts", "config", "configs", "__tests__", "e2e",
];
const ROOT_FILES = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb", ".npmrc",
  "tsconfig.json", "jsconfig.json", "babel.config.js", "babel.config.cjs",
  "eslint.config.js", "eslint.config.mjs", "jest.config.js", "vitest.config.js",
  "vitest.config.ts", "playwright.config.js", "playwright.config.ts",
  "vite.config.js", "vite.config.ts", "webpack.config.js", "next.config.js",
];
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_SINGLE_BYTES = 16 * 1024 * 1024;

function reject(message, code = "VERIFIER_INPUT_UNSAFE") {
  return Object.assign(new Error(message), { code });
}

const sortNames = (items) => items.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

/**
 * Bounded, deterministic snapshot of local verification inputs.
 *
 * This covers recognized source/test/config roots, not arbitrary external
 * dependencies, generated outputs, node_modules, or the full OS environment.
 * It is an integrity check, not a security sandbox or an authenticated seal.
 */
export async function fingerprintVerificationInputs(root) {
  const base = await fs.realpath(root);
  if (base !== root) throw reject("Verification workspace path must be canonical.");
  const files = [];
  let totalBytes = 0;
  let fileCount = 0;

  async function visit(relative, optional = false) {
    const absolute = path.join(base, relative);
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if (optional && error.code === "ENOENT") return;
      throw reject("Verification input is inaccessible or missing.");
    }
    if (stat.isSymbolicLink()) {
      throw reject("Symlinked verification inputs are not supported.");
    }
    if (stat.isDirectory()) {
      const names = sortNames(await fs.readdir(absolute));
      for (const name of names) {
        await visit(`${relative}/${name}`);
      }
      return;
    }
    if (!stat.isFile()) {
      throw reject("Non-file verification input encountered.");
    }
    fileCount += 1;
    totalBytes += stat.size;
    if (fileCount > MAX_FILES || stat.size > MAX_SINGLE_BYTES
      || totalBytes > MAX_TOTAL_BYTES) {
      throw reject("Verification input scan exceeded its limits.", "VERIFIER_INPUT_LIMIT");
    }
    const bytes = await fs.readFile(absolute);
    if (bytes.length !== stat.size) {
      throw reject("Verification input changed during fingerprint capture.",
        "VERIFIER_INPUT_DRIFT");
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    files.push([relative.replaceAll("\\", "/"), hash]);
  }

  for (const file of ROOT_FILES) await visit(file, true);
  for (const directory of SOURCE_DIRS) await visit(directory, true);
  files.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    inputsSchema: INPUT_SCHEMA,
    inputsHash: createHash("sha256").update(JSON.stringify({
      schema: INPUT_SCHEMA, files,
    })).digest("hex"),
    inputFileCount: fileCount,
    inputTotalBytes: totalBytes,
  };
}

export async function assertVerificationInputsUnchanged(root, proof) {
  if (!proof || proof.inputsSchema !== INPUT_SCHEMA
    || typeof proof.inputsHash !== "string"
    || !/^[a-f0-9]{64}$/.test(proof.inputsHash)
    || !Number.isSafeInteger(proof.inputFileCount)
    || !Number.isSafeInteger(proof.inputTotalBytes)) {
    throw reject("Missing or invalid verifier input fingerprint.",
      "VERIFIER_EVIDENCE_INVALID");
  }
  const actual = await fingerprintVerificationInputs(root);
  if (actual.inputsHash !== proof.inputsHash
    || actual.inputFileCount !== proof.inputFileCount
    || actual.inputTotalBytes !== proof.inputTotalBytes) {
    throw reject("Verification inputs changed since the successful check.",
      "VERIFIER_INPUT_DRIFT");
  }
  return true;
}
