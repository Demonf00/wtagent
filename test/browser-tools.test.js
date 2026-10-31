import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultToolRegistry } from "../src/tools/default-tools.js";
import { allowedTestUrl, TestBrowser } from "../src/tools/browser-tools.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";

test("browser URL boundary rejects remote, credentials and unsafe protocols", () => {
  for (const url of [
    "https://example.com", "file:///etc/passwd", "http://localhost.evil.com",
    "http://user:secret@localhost:3000/", "javascript:alert(1)",
  ]) assert.equal(allowedTestUrl(url), false, url);
  assert.equal(allowedTestUrl("http://127.0.0.1:3000/"), true);
  assert.equal(allowedTestUrl("http://localhost:8080/test"), true);
});

test("browser tools are registered and validate arguments", () => {
  const registry = createDefaultToolRegistry();
  for (const name of ["browser.navigate", "browser.click", "browser.fill",
    "browser.inspect", "browser.screenshot", "browser.close"]) {
    assert.ok(registry.list().some((entry) => entry.name === name), name);
  }
  assert.throws(() => registry.validate({
    name: "browser.navigate", args: { url: "https://example.com" },
  }));
});

test("browser interactions require approval", async () => {
  const policy = new PolicyEngine();
  for (const name of ["browser.navigate", "browser.click", "browser.fill"]) {
    const decision = await policy.evaluate({ name, args: {} }, { projectRoot: process.cwd() });
    assert.equal(decision.action, "confirm", name);
  }
  const readonly = await policy.evaluate({
    name: "browser.inspect", args: {},
  }, { projectRoot: process.cwd() });
  assert.equal(readonly.action, "allow");
});

test("browser tools execute through registry and enforce screenshot containment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-registry-browser-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = createDefaultToolRegistry();
  const context = { projectRoot: root, toolTimeoutMs: 15000, allowOutside: false };
  const call = async (name, args) => registry.execute(
    registry.validate({ id: name, name, args }), context,
  );
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end('<title>Registry check</title><main id="ok">Ready</main>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => call("browser.close", {}));
  const navigate = await call("browser.navigate", {
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  assert.equal(navigate.ok, true, navigate.message);
  const inspect = await call("browser.inspect", { selector: "#ok" });
  assert.equal(inspect.ok, true, inspect.message);
  assert.equal(inspect.data.text, "Ready");
  const screenshot = await call("browser.screenshot", { path: "browser-check.png" });
  assert.equal(screenshot.ok, true, screenshot.message);
  assert.ok((await fs.stat(path.join(root, "browser-check.png"))).size > 100);
  const escaped = await call("browser.screenshot", { path: "../outside.png" });
  assert.equal(escaped.ok, false, "Screenshot must never escape project root");
});

test("isolated Chromium interacts with local web application and captures failures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-test-browser-"));
  let fixed = false;
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><title>WTAgent fixture</title></head><body>
      <input id="name" /><button id="submit">Submit</button><p id="result">Waiting</p>
      <script>
        document.getElementById('submit').onclick = () => {
          document.getElementById('result').textContent =
            ${JSON.stringify(fixed)} ? 'Hello ' + document.getElementById('name').value : 'BUG';
        };
      </script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const browser = new TestBrowser();
  t.after(() => browser.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await browser.navigate(url);
  } catch (error) {
    if (/executable doesn't exist|not found|browserType.launch|ENOENT/i.test(error.message)) {
      t.skip(`Chrome unavailable for real-browser integration: ${error.message.slice(0, 180)}`);
      return;
    }
    throw error;
  }
  await browser.fill("#name", "Agent");
  await browser.click("#submit");
  const failure = await browser.inspect("#result");
  assert.equal(failure.text, "BUG", "Deliberate fixture failure must be observable");
  assert.notEqual(failure.text, "Hello Agent", "Fixture must initially fail acceptance");

  // Repair deliberately broken application fixture and repeat browser acceptance.
  fixed = true;
  await browser.navigate(url);
  await browser.fill("#name", "Agent");
  await browser.click("#submit");
  const success = await browser.inspect("#result");
  assert.equal(success.text, "Hello Agent");

  const screenshot = await browser.screenshot(path.join(root, "verified.png"));
  assert.ok(screenshot.bytes > 100);
  assert.equal(screenshot.visuallyInspected, false);
  await assert.rejects(browser.navigate("https://example.com"), /restricted/);
});
