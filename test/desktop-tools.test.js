import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ToolRegistry } from "../src/tools/registry.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { registerDesktopTools } from "../src/desktop/windows-desktop.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";

const fakeResult = (data = { ok: true }) => ({
  exitCode: 0, timedOut: false, stdout: JSON.stringify(data), stderr: "",
});

test("Desktop actions are registered only on Windows and approvals cannot be bypassed", async () => {
  const linux = new ToolRegistry();
  registerDesktopTools(linux, { platform: "linux" });
  assert.deepEqual(linux.list(), []);

  const windows = new ToolRegistry();
  registerDesktopTools(windows, { platform: "win32", runner: async () => fakeResult() });
  assert.deepEqual(windows.list().map(item => item.name), [
    "desktop.observe", "desktop.click", "desktop.type", "desktop.hotkey",
  ]);
  const policy = new PolicyEngine({
    store: { ensureLoaded: async () => {}, isAlwaysAllowed: () => true },
  });
  for (const name of windows.list().map(item => item.name)) {
    const decision = await policy.evaluate({ name, args: {} }, { projectRoot: "/any" });
    assert.equal(decision.action, "confirm");
    assert.equal(decision.grants.allowOutside, false);
  }
});

test("Desktop click and hotkey strictly validate data before launching PowerShell", async () => {
  const calls = [];
  const registry = new ToolRegistry();
  registerDesktopTools(registry, {
    platform: "win32",
    runner: async (request) => {
      calls.push(request);
      return fakeResult({ ok: true, x: 120, y: 80, clicks: 1, button: "left" });
    },
  });
  assert.throws(() => registry.validate({
    id: "1", name: "desktop.click", args: { x: -1, y: 20 },
  }));
  assert.throws(() => registry.validate({
    id: "1", name: "desktop.hotkey", args: { combo: "CTRL+CTRL+L" },
  }));
  assert.throws(() => registry.validate({
    id: "1", name: "desktop.type", args: { text: "x".repeat(501) },
  }));
  const click = registry.validate({
    id: "2", name: "desktop.click", args: { x: 120, y: 80 },
  });
  const result = await registry.execute(click, {
    projectRoot: "/tmp", toolTimeoutMs: 2000,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv.slice(0, 7), [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass", "-File", calls[0].argv[6],
  ]);
  assert.equal(calls[0].argv[7], "-Action");
  assert.equal(calls[0].argv[8], "click");
  assert.equal(calls[0].argv[9], "-PayloadBase64");
  const decoded = JSON.parse(Buffer.from(calls[0].argv[10], "base64").toString("utf8"));
  assert.deepEqual(decoded, { x: 120, y: 80, button: "left", clicks: 1 });
});

test("Desktop observe returns real file and the runtime attaches it only from inside workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-desktop-"));
  try {
    const registry = new ToolRegistry();
    registerDesktopTools(registry, {
      platform: "win32",
      runner: async (request) => {
        const args = JSON.parse(Buffer.from(request.argv[10], "base64").toString("utf8"));
        assert.equal(request.argv[8], "observe");
        await fs.writeFile(args.output, Buffer.alloc(512, 137));
        return fakeResult({ ok: true, width: 1600, height: 900 });
      },
    });
    const call = registry.validate({ id: "1", name: "desktop.observe", args: {} });
    const result = await registry.execute(call, {
      projectRoot: root, toolTimeoutMs: 1000,
    });
    assert.equal(result.ok, true);
    assert.ok(result.meta.modelAttachment.startsWith(root));
    const out = [];
    const runtime = {
      session: { state: { projectRoot: root } },
      limits: { maxBrowserToolResultBytes: 10000 },
      buildToolResultMessage: () => "<tool_result/>",
      sendMessage: async (text, options) => { out.push({ text, options }); return {}; },
    };
    await AgentRuntime.prototype.sendToolResult.call(runtime, result);
    assert.equal(out.length, 1);
    assert.equal(out[0].options.requireAttachments, true);
    assert.equal(out[0].options.files[0].path, result.meta.modelAttachment);

    const outside = path.join(os.tmpdir(), "other-wtagent-" + randomUUID() + ".png");
    await fs.writeFile(outside, Buffer.alloc(512));
    try {
      await assert.rejects(AgentRuntime.prototype.sendToolResult.call(runtime, {
        name: "desktop.observe", ok: true, meta: { modelAttachment: outside },
      }), /outside the selected workspace/);
    } finally {
      await fs.rm(outside, { force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Ambiguous desktop timeout never silently retries or reports success", async () => {
  const registry = new ToolRegistry();
  registerDesktopTools(registry, {
    platform: "win32", runner: async () => ({
      timedOut: true, completionUnknown: true, exitCode: null,
    }),
  });
  const call = registry.validate({
    id: "1", name: "desktop.hotkey", args: { combo: "CTRL+S" },
  });
  const result = await registry.execute(call, {
    projectRoot: "/tmp", toolTimeoutMs: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.meta.completionUnknown, true);
  assert.equal(result.meta.recoverable, false);
});


test("Windows PowerShell desktop helper parses without executing GUI operations", {
  skip: process.platform !== "win32",
}, () => {
  const script = fileURLToPath(new URL("../src/desktop/windows-desktop.ps1", import.meta.url));
  const command = [
    "$tokens = $null; $errors = $null;",
    "[void][System.Management.Automation.Language.Parser]::ParseFile(",
    "'" + script.replaceAll("'", "''") + "',",
    "[ref]$tokens, [ref]$errors);",
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
  ].join(" ");
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
