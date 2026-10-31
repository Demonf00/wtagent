import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { z } from "zod";
import { resolveCanonicalWriteTarget, resolveToolPath } from "../policy/path-guard.js";

const TIMEOUT = 10000;
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function allowedTestUrl(raw) {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:")
      && localHosts.has(url.hostname.toLowerCase())
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

export class TestBrowser {
  constructor({ launch = (options) => chromium.launch(options) } = {}) {
    this.launch = launch;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.consoleErrors = [];
    this.failedRequests = [];
  }

  async ensure() {
    if (this.page && !this.page.isClosed()) return this.page;
    this.browser = await this.launch({
      channel: "chrome",
      headless: true,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    try {
      this.context = await this.browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      await this.context.route("**/*", async (route) => {
        if (allowedTestUrl(route.request().url())) {
          await route.continue();
        } else {
          await route.abort("blockedbyclient");
        }
      });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(TIMEOUT);
      this.page.on("pageerror", (error) => this.consoleErrors.push(error.message));
      this.page.on("console", (message) => {
        if (message.type() === "error") this.consoleErrors.push(message.text());
      });
      this.page.on("requestfailed", (request) => {
        this.failedRequests.push({
          url: request.url(),
          error: request.failure()?.errorText ?? "unknown",
        });
      });
      this.page.on("popup", (popup) => { void popup.close().catch(() => {}); });
      return this.page;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    if (browser) await browser.close();
  }

  async navigate(url) {
    if (!allowedTestUrl(url)) throw new Error("Browser navigation is restricted to localhost test applications.");
    const page = await this.ensure();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    if (!allowedTestUrl(page.url())) throw new Error("Test page navigated outside localhost.");
    return { url: page.url(), status: response?.status() ?? null, title: await page.title() };
  }

  async click(selector) {
    const page = await this.ensure();
    await page.locator(selector).click({ timeout: TIMEOUT });
    return { url: page.url(), selector };
  }

  async fill(selector, value) {
    const page = await this.ensure();
    await page.locator(selector).fill(value, { timeout: TIMEOUT });
    return { selector, valueLength: value.length };
  }

  async inspect(selector = "body") {
    const page = await this.ensure();
    const target = page.locator(selector).first();
    const count = await page.locator(selector).count();
    const text = count ? (await target.innerText({ timeout: TIMEOUT })).slice(0, 8000) : "";
    return {
      url: page.url(),
      title: await page.title(),
      selector,
      count,
      text,
      consoleErrors: this.consoleErrors.slice(-20),
      failedRequests: this.failedRequests.slice(-20),
    };
  }

  async screenshot(targetPath) {
    const page = await this.ensure();
    await page.screenshot({ path: targetPath, fullPage: true, timeout: TIMEOUT });
    const stat = await fs.stat(targetPath);
    return { path: targetPath, bytes: stat.size, format: "png", visuallyInspected: false };
  }
}

export function registerBrowserTools(registry, { browser = new TestBrowser() } = {}) {
  const register = (name, description, schema, run, risk = "execute") => {
    registry.register({
      name,
      description,
      inputDescription: name === "browser.navigate"
        ? "<args><url>http://127.0.0.1:3000</url></args>"
        : name === "browser.fill"
          ? "<args><selector>#name</selector><value>example</value></args>"
          : name === "browser.screenshot"
            ? "<args><path>artifacts/browser.png</path></args>"
            : name === "browser.close"
              ? "<args></args>"
              : `<args><selector>${name === "browser.inspect" ? "body" : "#submit"}</selector></args>`,
      risk,
      managesTimeout: true,
      inputSchema: schema,
      execute: async (args, context) => {
        const data = await run(args, context);
        return { ok: true, message: `${name} completed.`, data };
      },
    });
  };
  register("browser.navigate", "Navigate isolated test browser to a localhost web application. External sites are forbidden.", z.object({
    url: z.string().url().refine(allowedTestUrl, "Only localhost URLs are allowed"),
  }), ({ url }) => browser.navigate(url));
  register("browser.click", "Click a matching element in the isolated test browser.", z.object({
    selector: z.string().min(1).max(500),
  }), ({ selector }) => browser.click(selector));
  register("browser.fill", "Fill a field in the isolated test browser.", z.object({
    selector: z.string().min(1).max(500),
    value: z.string().max(20000),
  }), ({ selector, value }) => browser.fill(selector, value));
  register("browser.inspect", "Inspect visible page text, count matches, JavaScript errors and failed requests.", z.object({
    selector: z.string().min(1).max(500).default("body"),
  }), ({ selector }) => browser.inspect(selector), "read");
  register("browser.screenshot", "Capture test-browser PNG in the project; image is not automatically visible to the model.", z.object({
    path: z.string().min(1),
  }), async ({ path: filename }, context) => {
    const target = await resolveToolPath(context.projectRoot, filename);
    if (!target.inside) throw new Error("Screenshot path is outside project root.");
    if (path.extname(target.path).toLowerCase() !== ".png") throw new Error("Screenshot must use a .png path.");
    await fs.mkdir(path.dirname(target.path), { recursive: true });
    const verified = await resolveCanonicalWriteTarget(context.projectRoot, target.path, { allowOutside: false });
    return browser.screenshot(verified);
  });
  register("browser.close", "Close the isolated test browser without touching the ChatGPT browser.", z.object({}), () => browser.close());
  return registry;
}
