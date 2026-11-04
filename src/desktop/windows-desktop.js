import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveCanonicalWriteTarget } from "../policy/path-guard.js";
import { runProgram } from "../tools/terminal-exec.js";

const scriptPath = fileURLToPath(new URL("./windows-desktop.ps1", import.meta.url));
const TIMEOUT_MS = 30_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const HOTKEY = /^(?:(?:CTRL|ALT|SHIFT)\+){0,3}(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|ENTER|ESC|TAB|BACKSPACE|DELETE|SPACE|UP|DOWN|LEFT|RIGHT|HOME|END|PGUP|PGDN)$/;

function failure(message, { completionUnknown = false } = {}) {
  return {
    ok: false,
    message,
    meta: completionUnknown
      ? { completionUnknown: true, recoverable: false }
      : { recoverable: true },
  };
}

/** Strictly typed Windows operations: no command string, shell, URLs, or scripts
 * supplied by the model. The action/payload arguments are fixed before spawn.
 */
export async function runWindowsDesktopOperation(action, payload, {
  projectRoot, runner = runProgram,
} = {}) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const outcome = await runner({
    program: "powershell.exe",
    argv: [
      "-NoLogo", "-NoProfile", "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-Action", action,
      "-PayloadBase64", encoded,
    ],
    cwd: projectRoot,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: 8192,
    maxLogBytes: 8192,
  });
  if (outcome.completionUnknown || outcome.timedOut) {
    // The subprocess may already have acted on the desktop. Do not replay it.
    return failure("Desktop action timed out. Outcome is unknown; inspect the desktop before retrying.", {
      completionUnknown: true,
    });
  }
  if (outcome.exitCode !== 0 || outcome.error) {
    return failure("Windows desktop action failed; check that an unlocked interactive session is available.", {
      completionUnknown: action !== "observe",
    });
  }
  let result;
  try {
    result = JSON.parse(outcome.stdout.trim());
  } catch {
    return failure("Windows desktop returned an invalid result.", {
      completionUnknown: action !== "observe",
    });
  }
  if (result?.ok !== true || typeof result !== "object" || Array.isArray(result)) {
    return failure("Windows desktop did not confirm the operation.", {
      completionUnknown: action !== "observe",
    });
  }
  return { ok: true, data: result };
}

export function registerDesktopTools(registry, {
  platform = process.platform,
  runner = runProgram,
} = {}) {
  // Windows desktop input is deliberately unavailable on other platforms.
  if (platform !== "win32") return registry;

  async function execute(action, payload, context) {
    return await runWindowsDesktopOperation(action, payload, {
      projectRoot: context.projectRoot, runner,
    });
  }

  registry.register({
    name: "desktop.observe",
    description: "Capture the currently visible Windows desktop (all monitors) as a PNG and attach it to the next model tool result for visual inspection. Screenshot preview is scaled to fit 1600 px. It may include private information. Requires owner approval.",
    inputDescription: "<args></args>",
    risk: "read",
    managesTimeout: true,
    inputSchema: z.object({}),
    execute: async (_args, context) => {
      const dir = path.join(context.projectRoot, ".wtagent", "desktop-captures");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, "shot-" + randomUUID() + ".png");
      const verified = await resolveCanonicalWriteTarget(context.projectRoot, target);
      const operation = await execute("observe", { output: verified }, context);
      if (!operation.ok) return operation;
      const stat = await fs.lstat(verified);
      if (!stat.isFile() || stat.isSymbolicLink()
          || stat.size < 100 || stat.size > MAX_SCREENSHOT_BYTES) {
        return failure("Desktop screenshot was invalid or too large to upload.");
      }
      return {
        ok: true,
        message: "Desktop screenshot captured. The image is attached to the next model message. Review it before any click.",
        data: {
          previewWidth: operation.data.width,
          previewHeight: operation.data.height,
          imagePath: verified,
        },
        meta: { modelAttachment: verified },
      };
    },
  });

  registry.register({
    name: "desktop.click",
    description: "Click on the Windows desktop at (x,y) in the latest 1600px screenshot PREVIEW coordinate space, not native monitor pixels. Requires owner approval. Observe again after changing the UI.",
    inputDescription: "<args><x>400</x><y>250</y><button>left</button><clicks>1</clicks></args>",
    risk: "execute",
    managesTimeout: true,
    inputSchema: z.object({
      x: z.coerce.number().int().min(0).max(8000),
      y: z.coerce.number().int().min(0).max(8000),
      button: z.enum(["left", "right"]).default("left"),
      clicks: z.coerce.number().int().min(1).max(2).default(1),
    }),
    execute: async (args, context) => {
      const outcome = await execute("click", args, context);
      return outcome.ok
        ? { ok: true, message: "Windows mouse click sent; screenshot again to verify the outcome.", data: outcome.data }
        : outcome;
    },
  });

  registry.register({
    name: "desktop.type",
    description: "Type a short text into the focused Windows application using SendKeys, without modifying the clipboard. Focus the intended field first. Do not type passwords, access tokens, or other secrets. Requires owner approval.",
    inputDescription: "<args><text><![CDATA[Hello world]]></text></args>",
    risk: "execute",
    managesTimeout: true,
    inputSchema: z.object({ text: z.string().min(1).max(500) }),
    execute: async (args, context) => {
      const outcome = await execute("type", args, context);
      return outcome.ok
        ? { ok: true, message: "Text input sent to focused application.", data: { characters: outcome.data.characters } }
        : outcome;
    },
  });

  registry.register({
    name: "desktop.hotkey",
    description: "Send a single approved Windows SendKeys key combination such as CTRL+L, ALT+TAB, CTRL+S, ENTER or ESC. Does not support the Windows-logo key or secure desktop. Requires owner approval.",
    inputDescription: "<args><combo>CTRL+L</combo></args>",
    risk: "execute",
    managesTimeout: true,
    inputSchema: z.object({
      combo: z.string().max(32).transform(value => value.toUpperCase())
        .refine(value => HOTKEY.test(value)
          && new Set(value.split("+").slice(0, -1)).size === value.split("+").length - 1,
        "Unsupported key combination."),
    }),
    execute: async (args, context) => {
      const outcome = await execute("hotkey", args, context);
      return outcome.ok
        ? { ok: true, message: "Windows key combination sent.", data: outcome.data }
        : outcome;
    },
  });
  return registry;
}
