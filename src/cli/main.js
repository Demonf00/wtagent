#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {stageCandidate,readUpgradeState,promoteCandidate,rollbackCandidate} from "./self-upgrade.js";
import { Command } from "commander";
import { confirm, select, input } from "@inquirer/prompts";
import { launchNativeLoginBrowser } from "../browser/native-login.js";
import {
  createWebAdapter,
  DEFAULT_PROVIDER,
  getProvider,
  getProviderProfileDir,
  isProviderProfileBasename,
  listActiveProviderIds,
  resolveProvider,
} from "../browser/provider-registry.js";
import {
  ensureDirectory,
  formatHomePath,
  getAppDataDir,
  getSessionsDir,
  getTasksDir,
} from "../platform/paths.js";
import { discoverChromeExecutable } from "../platform/chrome-discovery.js";
import { isProcessAlive } from "../browser/cdp-state.js";
import {
  assertNativeRuntimeSupported,
  collectDoctorReport,
} from "../platform/windows-diagnostics.js";
import { ConversationRunner, resolveRuntimePaths } from "../runtime/conversation-runner.js";
import { executeSupervisorSession } from "./supervisor-session.js";
import { inspectSessionContext, prepareContextRotation } from "../context/context-manager.js";
import { runAutonomyCommand } from "./autonomy-command.js";
import { runDurableOrchestrator, readDurableOrchestratorState } from "../autonomy/durable-orchestrator.js";
import { createHeartbeatNotifier } from "../supervisor/heartbeat-notifier.js";
import { readAutonomyProgress } from "./progress-command.js";
import { readEvidenceDeliveryReport } from "../autonomy/delivery-report.js";
import {
  inspectOrchestratorOwner, recoverStaleOrchestratorOwner,
} from "../autonomy/orchestrator-ownership.js";
import { AgentSession } from "../session/agent-session.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { ApprovalStore } from "../policy/approval-store.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import { ProcessManager } from "../tools/process-manager.js";
import { NativeImageReceiver } from "../image/native-image-receiver.js";
import { NativeMusicReceiver, validateGenerationType } from "../audio/native-music-receiver.js";
import { resolveLimits } from "../shared/limits.js";
import { BrowserAdapterError } from "../shared/errors.js";
import { EXPORTERS } from "../session/session-export.js";
import { getPackageVersion } from "../shared/package-info.js";
import { extractAtMentions } from "./at-files.js";
import {
  classifyChatInput,
  promptForConfirm,
  promptForContinue,
  promptForText,
  promptForSelect,
  readChatMessage,
  ShellChatInput,
} from "./prompt-input.js";
import { createRenderer } from "./render-events.js";
import { t } from "./i18n.js";
import { runSelfUpdate } from "./self-update.js";
import { isSelfDevelopmentSource } from "../protocol/project-instructions.js";
import { runStartupChecks } from "./startup-notices.js";

async function assertDirectory(directory) {
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Project directory does not exist: ${directory}`);
  }
}

async function runLogin(options) {
  assertNativeRuntimeSupported();
  const provider = resolveProvider(options.model ?? DEFAULT_PROVIDER);
  const { profileDir } = resolveRuntimePaths(options, provider.id);
  const { label, baseUrl } = provider;
  for (;;) {
    console.log(t("login.openingProfile", { profileDir }));
    console.log(t("login.finishSignIn", { provider: label }));
    const browser = await launchNativeLoginBrowser({
      profileDir,
      chromePath: options.chromePath,
      url: baseUrl,
    });

    try {
      const answer = await promptForText({
        message: t("login.pressEnterVerify", { provider: label }),
      });
      if (answer == null) {
        return;
      }
      console.log(t("login.savingProfile"));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await browser.close();
    }

    const verifier = createWebAdapter({
      provider,
      profileDir,
      chromePath: options.chromePath,
    });
    try {
      await verifier.launch();
      let authenticated = await verifier.getAuthState() === "authenticated";
      if (!authenticated) {
        try {
          await verifier.waitForManualLogin({ timeoutMs: 8_000 });
          authenticated = true;
        } catch {
          authenticated = false;
        }
      }
      if (authenticated) {
        console.log(t("login.verified", { provider: label }));
        return;
      }
    } finally {
      await verifier.close();
    }

    console.log(t("login.stillGuest", { provider: label }));
  }
}

// Resets local login by deleting the dedicated Chrome profile. Login state for
// this app lives entirely in that profile (provider cookies + localStorage), so
// removing it returns wtagent to a clean guest state — useful for testing the
// full login → run flow. It never touches the real account server-side.
async function runLogout(options) {
  // `logout` targets one provider's profile; unknown ids are rejected but a
  // "planned" provider is still allowed (its profile may exist from a prior
  // login attempt), so use getProvider rather than resolveProvider.
  const provider = getProvider(options.model ?? DEFAULT_PROVIDER);
  const { profileDir } = resolveRuntimePaths(options, provider.id);
  const exists = await fs.stat(profileDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!exists) {
    console.log(t("logout.none", { profileDir }));
    return;
  }

  // Guard: only ever delete something that is actually a dedicated profile.
  // A profile Chrome has used contains a "Default" profile directory; otherwise
  // require a known provider profile basename before removing.
  const looksLikeProfile = await fs.stat(path.join(profileDir, "Default"))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!looksLikeProfile && !isProviderProfileBasename(path.basename(profileDir))) {
    throw new Error(t("logout.refuse", { profileDir }));
  }

  if (!options.yes) {
    const confirmed = await confirm({
      message: t("logout.confirm", {
        provider: provider.label,
        profileDir,
      }),
      default: false,
    });
    if (!confirmed) {
      console.log(t("logout.cancelled"));
      return;
    }
  }

  await fs.rm(profileDir, { recursive: true, force: true });
  console.log(t("logout.done", { profileDir }));
  console.log(
    provider.id === DEFAULT_PROVIDER
      ? t("logout.loginAgainDefault")
      : t("logout.loginAgainProvider", { provider: provider.id }),
  );
}

async function runDoctor(options) {
  const paths = resolveRuntimePaths(options);
  const report = await collectDoctorReport({
    paths,
    chromePath: options.chromePath,
  });

  for (const item of report.items) {
    const status = item.status.toUpperCase().padEnd(8);
    console.log(`${status} ${item.label}: ${item.detail}`);
  }
  console.log(`Data: ${paths.appDataDir}`);
  console.log(`Profile: ${paths.profileDir}`);
  const hasWarnings = report.items.some((item) => item.status === "degraded");
  console.log(
    report.exitCode !== 0
      ? "Doctor: FAILED"
      : hasWarnings
        ? "Doctor: OK (with warnings)"
        : "Doctor: OK",
  );
  process.exitCode = report.exitCode;
}

async function waitForProcessToExit(pid, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return !isProcessAlive(pid);
}

// A live session holds the provider's Chrome profile lock. In an interactive
// session, ask the user how to proceed instead of failing outright: kill the
// other session, or have the user close its Chrome window so that session
// fails and releases the profile. Returns true when the turn should be retried.
export async function promptToResolveProfileLock(error) {
  const pid = Number(error.details?.pid);
  if (pid === process.pid) {
    throw new Error(
      "The current WTAgent process still holds its browser profile lock. Refusing to terminate itself.",
      { cause: error },
    );
  }
  console.log(`\n${"\x1b[33m"}${error.message}${"\x1b[0m"}`);
  const choice = await promptForSelect({
    message: t("profileLock.how"),
    choices: [
      { name: t("profileLock.kill"), value: "kill" },
      { name: t("profileLock.retry"), value: "retry" },
      { name: t("profileLock.quit"), value: "quit" },
    ],
  });
  if (choice == null || choice === "quit") {
    return false;
  }
  if (choice === "kill" && Number.isSafeInteger(pid) && pid > 0) {
    console.log(t("profileLock.stopping", { pid }));
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    if (!await waitForProcessToExit(pid, 5_000)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  // Either the holder was killed or the user closed its Chrome window: wait
  // for the other session to release the profile, then retry the turn.
  await waitForProcessToExit(pid, 60_000);
  return true;
}

export async function executeSession({
  session,
  options,
  resume = false,
  instruction = null,
  files = [],
  chatInput = null,
  mode = null,
}, {
  interactive = !options.once && process.stdin.isTTY && process.stdout.isTTY,
  createRunner = (config) => new ConversationRunner(config),
  readNextMessage = promptForNextMessage,
} = {}) {
  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  const runner = createRunner({ session, options, interactive });

  const onInterrupt = () => {
    if (runner.interrupted) {
      console.log(`\n${t("session.forceQuit")}`);
      // process.exit skips the finally block, so repeat the session/resume
      // hint here — the user should always know how to continue.
      console.log(t("session.savedAt", { directory: session.directory }));
      printResumeHint(session.sessionId);
      process.exit(130);
    }
    runner.interrupted = true;
    runner.adapter.escCancelRequested = true;
    runner.renderer.stopSpinner();
    console.log(`\n${t("session.ctrlC")}`);
    process.exitCode = 130;
  };
  process.on("SIGINT", onInterrupt);
  const activeChatInput = chatInput
    ?? (interactive ? new ShellChatInput() : null);
  if (instruction) {
    activeChatInput?.remember(instruction);
  }

  let runFailed = false;

  try {
    runner.renderer.hint(`Session ID: ${session.sessionId}`);
    let turnResume = resume;
    let turnInstruction = instruction;
    let turnFiles = files;
    let turnInPlaceRecovery = false;

    for (;;) {
      let result;
      try {
        result = await runner.runTurn({
          resume: turnResume,
          instruction: turnInstruction,
          files: turnFiles,
          inPlaceRecovery: turnInPlaceRecovery,
          mode,
        });
      } catch (error) {
        // Another live session holds the provider profile lock. Interactively,
        // offer to resolve it and retry the same turn; otherwise fail cleanly
        // (the top-level handler prints the actionable message).
        if (error?.code === "PROFILE_LOCKED" && interactive) {
          if (await promptToResolveProfileLock(error)) {
            continue;
          }
          return null;
        }
        throw error;
      }
      if (runner.interrupted) {
        break;
      }
      if (result?.cancelled) {
        if (!interactive) {
          throw result.error;
        }
        runner.renderer.hint(t("session.cancelledHint"));
        // Fall through to the same input prompt as a completed turn. Never
        // resume automatically or reuse the cancelled instruction/attachments.
      }
      if (result?.recoveryRequired) {
        if (!interactive) {
          throw result.error;
        }
        runner.renderer.hint(
          t("session.recoveryHint", {
            provider: runner.renderer.providerLabel,
          }),
        );
        const pendingRecovery = session.state.pendingOutbound != null
          || session.state.pendingAssistantTurn != null;
        let next;
        let retryOnly = false;
        for (;;) {
          next = await readNextMessage(runner, activeChatInput, {
            resolveAttachments: !pendingRecovery,
          });
          if (next == null) {
            break;
          }
          retryOnly = next.text.trim().toLowerCase() === "/retry";
          if (!pendingRecovery || retryOnly) {
            break;
          }
          runner.renderer.hint(
            t("session.recoveryHint", {
              provider: runner.renderer.providerLabel,
            }),
          );
        }
        if (next == null) {
          break;
        }
        if (!retryOnly) {
          await session.appendInstruction(next.text, { files: next.files });
        }
        turnResume = true;
        turnInstruction = retryOnly ? null : next.text;
        turnFiles = retryOnly ? [] : next.files;
        // This Chrome tab still contains the original message/tool result, so
        // the next run must not resend a persisted pending result.
        turnInPlaceRecovery = true;
        continue;
      }
      if (!interactive) {
        return result;
      }

      turnInPlaceRecovery = false;

      // Managed dev servers keep running between turns; surface them once.
      const running = runner.processManager.list({ includeOutput: false }).filter(
        (item) => item.status === "running",
      );
      if (running.length > 0) {
        runner.renderer.hint(t("session.processesRunning"));
        for (const item of running) {
          runner.renderer.hint(
            `  ${item.processId} pid=${item.pid} ${item.detectedUrls.join(" ")}`,
          );
        }
      }

      const next = await readNextMessage(runner, activeChatInput);
      if (next == null) {
        break;
      }
      await session.appendInstruction(next.text, { files: next.files });
      turnResume = true;
      turnInstruction = next.text;
      turnFiles = next.files;
    }
    return null;
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    activeChatInput?.close();
    await runner.close({ keepBrowser: runFailed });
    console.log(t("session.savedAt", { directory: session.directory }));
    printResumeHint(session.sessionId);
  }
}

// A highly visible, blank-line-separated hint for continuing the conversation,
// printed last so it is not lost in the run output (like Claude Code).
function printResumeHint(sessionId) {
  const rule = "─".repeat(48);
  console.log("");
  console.log(rule);
  console.log(t("session.resumeWith", { sessionId }));
  console.log(rule);
  console.log("");
}

// Reads the user's next message from the interactive prompt. Empty input simply
// re-prompts. Returns null for an explicit exit command, Ctrl+C, Ctrl+D, or EOF;
// otherwise returns
// { text, files } where files are resolved @file attachments.
async function promptForNextMessage(
  runner,
  chatInput,
  { resolveAttachments = true } = {},
) {
  for (;;) {
    const answer = chatInput
      ? await chatInput.read()
      : await promptForText({
        message: t("task.youPrompt"),
        theme: { prefix: "" },
      });
    if (answer == null) {
      // Ctrl+C / Ctrl+D inside the prompt ends the conversation cleanly.
      runner.renderer.println("");
      return null;
    }
    const classified = classifyChatInput(answer);
    if (classified.kind === "empty") {
      continue;
    }
    if (classified.kind === "exit") {
      return null;
    }
    const { text } = classified;
    const files = resolveAttachments
      ? await resolveMessageAttachments(runner, text)
      : [];
    return { text, files };
  }
}

// Parses @file mentions in a message, reports attached/missing files to the
// user, and returns the resolved attachment list.
async function resolveMessageAttachments(runner, text) {
  const projectRoot = runner.session.state.projectRoot;
  const { files, missing } = await extractAtMentions(text, projectRoot);
  if (files.length > 0) {
    runner.renderer.hint(
      t("attachment.attaching", {
        files: files.map((file) => file.name).join(", "),
      }),
    );
  }
  if (missing.length > 0) {
    runner.renderer.hint(
      t("attachment.notAttached", {
        details: missing.map((m) => `${m.requested}: ${m.reason}`).join("; "),
      }),
    );
  }
  return files;
}

function isInteractiveSession(options) {
  return !options.once && process.stdin.isTTY && process.stdout.isTTY;
}

async function promptForUpdate({ currentVersion, latest }) {
  return await promptForConfirm({
    message: t("update.prompt", { currentVersion, latest }),
    default: true,
  });
}

export function formatStartupBanner(now = new Date(), version = getPackageVersion()) {
  const localTime = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return `WEAgent v${version} · ${localTime}`;
}

async function maybeRunStartupChecks(options) {
  const developmentSource = await isSelfDevelopmentSource();
  console.log(formatStartupBanner());
  return await runStartupChecks({
    appDataDir: resolveRuntimePaths(options).appDataDir,
    interactive: isInteractiveSession(options),
    allowUpdates: !developmentSource,
    promptUpdate: promptForUpdate,
  });
}

async function runUpdate() {
  if (await isSelfDevelopmentSource()) {
    console.error("Upstream npm updates are disabled for this source development checkout. Use scripts/self-release.ps1 and restart from source.");
    process.exitCode = 1;
    return { status: "blocked-development-source" };
  }
  const result = await runSelfUpdate();
  if (result.status === "error") {
    process.exitCode = 1;
  }
  return result;
}

async function executeSelectedSession(args) {
 if (args.options.legacy) return await executeSession(args);
 let current = args;
 for (let rotations = 0; rotations < 8; rotations++) {
   const result = await executeSupervisorSession(current, {
     interactive: isInteractiveSession(args.options),
     readNextMessage: promptForNextMessage,
     printResumeHint,
   });
   if (result?.kind !== "automatic-context-rotation") return result;
   // executeSupervisorSession releases the old lock before returning.
   const sessionsDir = path.dirname(current.session.directory);
   const next = await AgentSession.load({
     sessionsDir, sessionId: result.nextSessionId,
   });
   if (next.state.previousContextSessionId !== current.session.sessionId) {
     throw Object.assign(
       new Error("Automatic replacement session identity mismatch."),
       { code: "CONTEXT_ROTATION_STATE_UNSAFE" },
     );
   }
   console.log("[Context] Continuing in a new conversation via Session " + next.sessionId);
   const pendingInstruction = result.pendingInstruction ?? null;
   const pendingFiles = result.pendingFiles ?? [];
   current = { session: next, options: args.options,
     resume: Boolean(pendingInstruction?.trim() || pendingFiles.length),
     instruction: pendingInstruction, files: pendingFiles };
 }
 throw Object.assign(
   new Error("Context rotation hop limit reached; Session state preserved."),
   { code: "CONTEXT_ROTATION_HOP_LIMIT" },
 );
}

async function runAgent(taskParts, options) {
  assertNativeRuntimeSupported();
  const projectRoot = path.resolve(options.project ?? process.cwd());
  await assertDirectory(projectRoot);

  // Fail fast on an unknown/unsupported --model before any startup work.
  const provider = resolveProvider(options.model ?? DEFAULT_PROVIDER);

  const generationType = validateGenerationType(options.type, provider.id);

  const startup = await maybeRunStartupChecks(options);
  if (startup === "updated" || startup === "aborted") {
    return null;
  }

  const interactive = isInteractiveSession(options);
  const chatInput = interactive ? new ShellChatInput() : null;

  if (interactive) {
    printChatBanner(projectRoot, provider);
  }

  // In interactive mode an initial task is optional: the user can just start
  // typing at the prompt. In one-shot mode a task is required.
  let task = taskParts.join(" ").trim();
  if (!task) {
    const initialMessage = interactive
      ? await readChatMessage(() => chatInput.read())
      : await promptForText({
        message: t("task.prompt"),
        validate: (value) => value.trim() ? true : t("task.required"),
      });
    if (initialMessage == null) {
      chatInput?.close();
      console.log("");
      return null;
    }
    task = initialMessage.trim();
  } else if (interactive) {
    chatInput.remember(task);
  }

  const paths = resolveRuntimePaths(options, provider.id);
  await ensureDirectory(paths.sessionsDir);
  const session = await AgentSession.create({
    sessionsDir: paths.sessionsDir,
    task,
    projectRoot,
    provider: provider.id,
    mode: null,
    generationType,
  });

  // Resolve @file attachments in the opening task, if any. The task itself is
  // already stored by AgentSession.create; here we only resolve the files to
  // attach on the first turn (run() records them on the opening user item).
  let files = [];
  if (task) {
    const { files: found, missing } = await extractAtMentions(task, projectRoot);
    files = found;
    if (found.length > 0) {
      console.log(t("attachment.attaching", {
        files: found.map((file) => file.name).join(", "),
      }));
    }
    if (missing.length > 0) {
      console.log(t("attachment.notAttached", {
        details: missing.map((m) => `${m.requested}: ${m.reason}`).join("; "),
      }));
    }
  }

  return await executeSelectedSession({ session, options, files, chatInput });
}

function printChatBanner(projectRoot, provider) {
  const CYAN = "\x1b[36m";
  const DIM = "\x1b[2m";
  const RESET = "\x1b[0m";
  console.log("");
  console.log(`${CYAN}WTAgent${RESET} ${DIM}· ${provider.label} · ${formatHomePath(projectRoot)}${RESET}`);
  console.log(`${DIM}${t("banner.controls")}${RESET}`);
  console.log("");
}

async function loadSession(paths, sessionId) {
  try {
    return await AgentSession.load({
      sessionsDir: paths.sessionsDir,
      sessionId,
    });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return await AgentSession.load({
      sessionsDir: paths.legacyTasksDir,
      sessionId,
    });
  }
}

async function runResume(sessionId, instructionParts, options) {
  assertNativeRuntimeSupported();
  // Loading only needs the sessions dir (provider-independent); the provider is
  // then read from the session so the run reuses the right adapter + profile.
  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  const session = await loadSession(paths, sessionId);
  await assertDirectory(session.state.projectRoot);
  const instruction = instructionParts.join(" ").trim();
  if (
    instruction
    && (
      session.state.pendingOutbound != null
      || session.state.pendingAssistantTurn != null
    )
  ) {
    throw new BrowserAdapterError(
      "This session has a pending browser handoff. Resume it without an instruction or attachment first.",
      { code: "RECOVERY_REQUIRES_BARE_RESUME", recoverable: false },
    );
  }

  const provider = resolveProvider(session.state.provider ?? DEFAULT_PROVIDER);
  if (options.type != null && validateGenerationType(options.type, provider.id) !== (session.state.generationType ?? "agent")) {
    throw new Error("--type cannot change the generation type of an existing session.");
  }
  // A conversation belongs to one provider. --model on resume is only allowed
  // if it names the same provider; switching mid-conversation is rejected.
  if (options.model != null && getProvider(options.model).id !== provider.id) {
    throw new Error(
      `Session ${sessionId} uses ${provider.label}; `
        + `--model ${options.model} cannot change a conversation's provider.`,
    );
  }

  const startup = await maybeRunStartupChecks(options);
  if (startup === "updated" || startup === "aborted") {
    return null;
  }

  let files = [];
  if (instruction) {
    const projectRoot = session.state.projectRoot;
    const { files: found, missing } = await extractAtMentions(instruction, projectRoot);
    files = found;
    if (found.length > 0) {
      console.log(t("attachment.attaching", {
        files: found.map((file) => file.name).join(", "),
      }));
    }
    if (missing.length > 0) {
      console.log(t("attachment.notAttached", {
        details: missing.map((m) => `${m.requested}: ${m.reason}`).join("; "),
      }));
    }
    // Default Supervisor mode persists the follow-up after locking and checking any active task.
 if (options.legacy) await session.appendInstruction(instruction, { files });
  }

  return await executeSelectedSession({
 session,
 options,
 resume: true,
    instruction: instruction || null,
    files,
  });
}

async function runStatus(sessionId, options) {
  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  if (sessionId) {
    const session = await loadSession(paths, sessionId);
    console.log(JSON.stringify(session.state, null, 2));
    return;
  }

  const currentSessions = await AgentSession.list({
    sessionsDir: paths.sessionsDir,
  });
  const legacySessions = await AgentSession.list({
    sessionsDir: paths.legacyTasksDir,
  });
  const sessions = [...currentSessions, ...legacySessions]
    .filter((session, index, values) =>
      values.findIndex((candidate) =>
        candidate.sessionId === session.sessionId
      ) === index
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 20);
  if (sessions.length === 0) {
    console.log(t("status.none"));
    return;
  }

  for (const session of sessions) {
    const summary = session.task.replaceAll(/\s+/g, " ").slice(0, 72);
    console.log(
      `${session.sessionId}\t${session.phase}\tturn=${session.turn}\t${summary}`,
    );
  }
}

async function runExport(sessionId, options) {
  const paths = resolveRuntimePaths(options);
  await ensureDirectory(paths.sessionsDir);
  const session = await loadSession(paths, sessionId);

  const format = options.format ?? "codex";
  const exporter = EXPORTERS[format];
  if (!exporter) {
    throw new Error(
      `Unknown export format "${format}". Use one of: ${Object.keys(EXPORTERS).join(", ")}.`,
    );
  }

  const transcript = await session.readTranscript();
  if (transcript.items.length === 0) {
    throw new Error(
      `Session ${sessionId} has no canonical transcript to export.`,
    );
  }

  const output = exporter(transcript, { sessionId: session.sessionId });
  if (options.output) {
    const target = path.resolve(options.output);
    await fs.writeFile(target, output, { mode: 0o600 });
    console.log(
      `Exported ${transcript.items.length} items to ${target} (${format}).`,
    );
  } else {
    process.stdout.write(output);
  }
}

const program = new Command()
  .name("wtagent")
  .description(t("app.description"))
  .version(getPackageVersion())
  .option("--home <path>", t("option.home"))
  .option("--profile-dir <path>", t("option.profileDir"))
  .option("--chrome-path <path>", t("option.chromePath"))
  .option("-C, --project <path>", t("option.project"), process.cwd())
  .option(
    "--model <provider>",
    t("option.model", {
      providers: listActiveProviderIds().join(", "),
      defaultProvider: DEFAULT_PROVIDER,
    }),
  )
  .option("--once", t("option.once"), false)
  .option("--type <type>", t("option.type"))
  .option("--model-turn-timeout-ms <milliseconds>", t("option.timeout"))
  .option("--no-minimize", t("option.noMinimize"))
  .option("--debug", t("option.debug"), false)
 .option("--legacy", "Use direct ConversationRunner (debugging)", false)
  .argument("[task...]", t("argument.task"))
  .action(async (task, _, command) => {
    await runAgent(task, command.optsWithGlobals());
  });

program
  .command("update")
  .description(t("command.update"))
  .action(async () => runUpdate());

program
  .command("doctor")
  .description(t("command.doctor"))
  .action(async (_, command) => runDoctor(command.optsWithGlobals()));

program
  .command("login")
  .description(t("command.login"))
  .action(async (_, command) => runLogin(command.optsWithGlobals()));

program
  .command("logout")
  .description(t("command.logout"))
  .option("--yes", t("option.yes"), false)
  .action(async (options, command) => {
    await runLogout({ ...command.optsWithGlobals(), ...options });
  });

program
  .command("resume")
  .description(t("command.resume"))
  .argument("<session-id>", t("argument.sessionId"))
  .argument("[instruction...]", t("argument.instruction"))
  .action(async (sessionId, instruction, _, command) => {
    await runResume(
      sessionId,
      instruction,
      command.optsWithGlobals(),
    );
  });

program
  .command("status")
  .description(t("command.status"))
  .argument("[session-id]", t("argument.sessionId"))
  .action(async (sessionId, _, command) => {
    await runStatus(sessionId, command.optsWithGlobals());
  });

const contextCommand = program
  .command("context")
  .description("Inspect long-session context pressure or safely rotate to a fresh conversation");

contextCommand
  .command("status")
  .argument("<session-id>", "Saved session to inspect")
  .action(async (sessionId, _, command) => {
    const options = command.optsWithGlobals();
    const paths = resolveRuntimePaths(options);
    const session = await loadSession(paths, sessionId);
    const pressure = await inspectSessionContext(session);
    console.log(JSON.stringify({
      sessionId, ...pressure,
      recommendation: pressure.warning && pressure.rotationAllowed
        ? "context rotate " + sessionId : null,
    }, null, 2));
  });

contextCommand
  .command("rotate")
  .description("Start a NEW session from a bounded checkpoint; never mutate old browser identity")
  .argument("<session-id>", "Completed, clean session")
  .action(async (sessionId, _, command) => {
    assertNativeRuntimeSupported();
    const options = command.optsWithGlobals();
    const paths = resolveRuntimePaths(options);
    const oldSession = await loadSession(paths, sessionId);
    const { next, savedFile } = await prepareContextRotation({
      session: oldSession, sessionsDir: path.dirname(oldSession.directory),
    });
    console.log("[Context] Created new session " + next.sessionId
      + " from completed session " + sessionId);
    console.log("[Context] Local handoff checkpoint: " + savedFile);
    console.log("[Context] The old Session remains unchanged. The model must inspect actual project state.");
    return await executeSelectedSession({ session: next, options, files: [], resume: false });
  });

const autonomyCommand = program
  .command("autonomy")
  .description("Experimental, explicitly approved structured task plans");

autonomyCommand
  .command("goal")
  .description("Generate and execute a verified plan from one high-level goal")
  .argument("<goal...>", "High-level goal to accomplish")
  .requiredOption("--state <path>", "Checkpoint JSON path outside the workspace")
  .option("--timeout-ms <milliseconds>", "Maximum planning and execution time", "120000")
  .action(async (goalParts, _, command) => {
    assertNativeRuntimeSupported();
    const opts = command.optsWithGlobals();
    const result = await runAutonomyCommand({
      action: "goal", goal: goalParts.join(" "), stateFile: opts.state,
      options: opts, timeoutMs: Number(opts.timeoutMs),
    });
    if (result.status !== "VERIFIED") process.exitCode = 1;
  });

autonomyCommand
  .command("start")
  .description("Execute a local task-plan JSON with durable checkpoints")
  .argument("<plan-file>", "Reviewed task plan JSON file")
  .requiredOption("--state <path>", "Checkpoint JSON path outside the workspace")
  .option("--timeout-ms <milliseconds>", "Maximum execution time", "120000")
  .action(async (planFile, _, command) => {
    assertNativeRuntimeSupported();
    const opts = command.optsWithGlobals();
    const result = await runAutonomyCommand({
      action: "start", planFile, stateFile: opts.state,
      options: opts, timeoutMs: Number(opts.timeoutMs),
    });
    if (result.status !== "VERIFIED") process.exitCode = 1;
  });

autonomyCommand
  .command("resume")
  .description("Resume the existing autonomy checkpoint without resubmitting verified tasks")
  .requiredOption("--state <path>", "Existing checkpoint JSON path")
  .option("--conversation-session <sessionId>", "Verify a rotated conversation Session before continuing tasks")
  .option("--timeout-ms <milliseconds>", "Maximum execution time", "120000")
  .action(async (_, command) => {
    assertNativeRuntimeSupported();
    const opts = command.optsWithGlobals();
    const result = await runAutonomyCommand({
      action: "resume", stateFile: opts.state,
      options: opts, timeoutMs: Number(opts.timeoutMs),
      conversationSessionId: opts.conversationSession ?? null,
    });
    if (result.status !== "VERIFIED") process.exitCode = 1;
  });

autonomyCommand
  .command("orchestrate")
  .description("Run bounded goal planning, execution and verification with a durable scheduler")
  .requiredOption("--state <path>", "Checkpoint JSON path outside the workspace")
  .option("--goal <goal>", "New goal to plan and execute")
  .option("--plan <path>", "Reviewed local JSON plan to execute")
  .option("--max-cycles <count>", "Maximum scheduler slices this invocation", "8")
  .option("--slice-ms <milliseconds>", "Per-slice execution limit", "15000")
  .option("--cooldown-ms <milliseconds>", "Minimum interval between slices", "1000")
  .option("--max-run-ms <milliseconds>", "Maximum total scheduler invocation time", "120000")
  .action(async (_, command) => {
    assertNativeRuntimeSupported();
    const opts = command.optsWithGlobals();
    const notifier = createHeartbeatNotifier({
      stateFile: opts.state,
      notify: event => console.log(
        `[Notification] ${event.severity}: ${event.type} — ${event.message}`),
    });
    const result = await runDurableOrchestrator({
      stateFile: opts.state,
      workspaceRoot: opts.project ?? process.cwd(),
      goal: opts.goal ?? null, planFile: opts.plan ?? null,
      maxCycles: Number(opts.maxCycles),
      sliceMs: Number(opts.sliceMs),
      cooldownMs: Number(opts.cooldownMs),
      maxRunMs: Number(opts.maxRunMs),
      onState: state => console.log(
        `[Orchestrator] ${state.status} stage=${state.lastStage} cycles=${state.cycles}`),
      runSlice: slice => runAutonomyCommand({
        action: slice.action, goal: slice.goal,
        planFile: slice.planFile, stateFile: slice.stateFile,
        options: opts, timeoutMs: slice.timeoutMs,
        onObservation: event => notifier.observe(event),
      }),
    });
    console.log(`[Orchestrator] ${result.status}; checkpoint=${opts.state}.orchestrator.json`);
    if (result.status !== "COMPLETE") process.exitCode = 1;
  });

autonomyCommand
  .command("progress")
  .description("Reattach to durable goal, task, verification and sanitized tool progress")
  .requiredOption("--state <path>", "Existing autonomy execution checkpoint")
  .action(async (_, command) => {
    const opts=command.optsWithGlobals();
    const result=await readAutonomyProgress({
      stateFile:opts.state,
      workspaceRoot:opts.project??process.cwd(),
    });
    console.log(JSON.stringify(result,null,2));
  });


const upgradeCommand=autonomyCommand
  .command("upgrade")
  .description("Audit local candidate promotion and rollback without installing");
upgradeCommand.option("--registry <path>","Local registry outside the Git source");
upgradeCommand.command("stage")
  .requiredOption("--report <path>","Previously generated SU-01 verification report")
  .description("Reverify exact candidate with trusted checks and archive both versions")
  .action(async (_,command)=>{
    const opts=command.optsWithGlobals();
    console.log(JSON.stringify(await stageCandidate({
      sourceRoot:opts.project??process.cwd(),
      stateRoot:opts.registry??null,
      reportPath:opts.report,
    }),null,2));
  });
upgradeCommand.command("status")
  .description("Show recorded active version, rollback target and audit history")
  .action(async (_,command)=>{
    const opts=command.optsWithGlobals();
    console.log(JSON.stringify(await readUpgradeState({
      sourceRoot:opts.project??process.cwd(),
      stateRoot:opts.registry??null,
    }),null,2));
  });
upgradeCommand.command("promote")
  .requiredOption("--sha <full-sha>","Exact staged candidate commit SHA")
  .description("Require an interactive full-SHA approval for recorded promotion")
  .action(async (_,command)=>{
    const opts=command.optsWithGlobals();
    if(!process.stdin.isTTY||!process.stdout.isTTY)
      throw new Error("Human approval requires an interactive terminal.");
    console.log(JSON.stringify(await promoteCandidate({
      sourceRoot:opts.project??process.cwd(),
      stateRoot:opts.registry??null,sha:opts.sha,
      approve:async({sha})=>input({
        message:"Type the FULL candidate SHA to approve promotion: "+sha,
      }),
    }),null,2));
  });
upgradeCommand.command("rollback")
  .description("Require interactive full-SHA approval to restore prior artifact pointer")
  .action(async (_,command)=>{
    const opts=command.optsWithGlobals();
    if(!process.stdin.isTTY||!process.stdout.isTTY)
      throw new Error("Human approval requires an interactive terminal.");
    console.log(JSON.stringify(await rollbackCandidate({
      sourceRoot:opts.project??process.cwd(),
      stateRoot:opts.registry??null,
      approve:async({sha})=>input({
        message:"Type the FULL prior SHA to approve rollback: "+sha,
      }),
    }),null,2));
  });

autonomyCommand
  .command("delivery-report")
  .description("Report task and goal acceptance with historical receipt evidence")
  .requiredOption("--state <path>", "Existing Coordinator checkpoint JSON path")
  .action(async (_, command) => {
    const opts=command.optsWithGlobals();
    const report=await readEvidenceDeliveryReport({
      stateFile:opts.state,
      workspaceRoot:opts.project??process.cwd(),
    });
    console.log(JSON.stringify(report,null,2));
    if(report.deliveryStatus!=="DELIVERED")process.exitCode=1;
  });

autonomyCommand
  .command("orchestrator-status")
  .description("Inspect persisted orchestrator state without running any work")
  .requiredOption("--state <path>", "Existing orchestration checkpoint path")
  .action(async (_, command) => {
    const opts = command.optsWithGlobals();
    const state = await readDurableOrchestratorState({
      stateFile: opts.state,
      workspaceRoot: opts.project ?? process.cwd(),
    });
    console.log(JSON.stringify(state, null, 2));
  });

autonomyCommand
  .command("orchestrator-owner")
  .description("Inspect a workspace or checkpoint process owner before recovery")
  .requiredOption("--state <path>", "Existing orchestration checkpoint path")
  .requiredOption("--scope <scope>", "Lock scope: workspace or checkpoint")
  .action(async (_, command) => {
    const opts=command.optsWithGlobals();
    const { realpath }=await import("node:fs/promises");
    const workspaceRoot=await realpath(opts.project ?? process.cwd());
    console.log(JSON.stringify(await inspectOrchestratorOwner({
      workspaceRoot,stateFile:opts.state,scope:opts.scope,
    }),null,2));
  });

autonomyCommand
  .command("orchestrator-recover")
  .description("Explicitly quarantine a proven-dead owner and write an audit trail")
  .requiredOption("--state <path>", "Existing orchestration checkpoint path")
  .requiredOption("--scope <scope>", "Lock scope: workspace or checkpoint")
  .requiredOption("--token <token>", "Observed stale owner token from orchestrator-owner")
  .action(async (_, command) => {
    assertNativeRuntimeSupported();
    const opts=command.optsWithGlobals();
    const { realpath }=await import("node:fs/promises");
    const workspaceRoot=await realpath(opts.project ?? process.cwd());
    const result=await recoverStaleOrchestratorOwner({
      workspaceRoot,stateFile:opts.state,
      scope:opts.scope,expectedToken:opts.token,
    });
    console.log(JSON.stringify(result,null,2));
  });

autonomyCommand
  .command("repair")
  .description("Explicitly execute one bounded repair of a blocked artifact check")
  .requiredOption("--state <path>", "Existing checkpoint JSON path")
  .option("--timeout-ms <milliseconds>", "Maximum repair and follow-up execution time", "120000")
  .action(async (_, command) => {
    assertNativeRuntimeSupported();
    const opts = command.optsWithGlobals();
    const result = await runAutonomyCommand({
      action: "repair", stateFile: opts.state,
      options: opts, timeoutMs: Number(opts.timeoutMs),
    });
    if (result.status !== "VERIFIED") process.exitCode = 1;
  });

autonomyCommand
  .command("status")
  .description("Show the persisted task-plan checkpoint")
  .requiredOption("--state <path>", "Existing checkpoint JSON path")
  .action(async (_, command) => {
    const opts = command.optsWithGlobals();
    await runAutonomyCommand({
      action: "status", stateFile: opts.state, options: opts,
    });
  });

program
  .command("export")
  .description(t("command.export"))
  .argument("<session-id>", t("argument.sessionId"))
  .option("--format <name>", t("option.format"), "codex")
  .option("-o, --output <path>", t("option.output"))
  .action(async (sessionId, options, command) => {
    await runExport(sessionId, { ...command.optsWithGlobals(), ...options });
  });

// Resolve npm's executable symlink as well as direct `node main.js` invocations.
// Importing the session runner in tests must not start the CLI.
const entryPath = process.argv[1]
  ? await fs.realpath(process.argv[1]).catch(() => null)
  : null;
const modulePath = await fs.realpath(fileURLToPath(import.meta.url)).catch(() => null);
// npm's Windows shim can use a short path or differently cased path. Compare
// canonical filesystem paths rather than independently encoded file URLs.
const isEntryPoint = entryPath && modulePath && (process.platform === "win32"
  ? entryPath.toLowerCase() === modulePath.toLowerCase()
  : entryPath === modulePath);
if (isEntryPoint) {
  await program.parseAsync().catch((error) => {
    // Expected, actionable failures carry a plain message instead of a stack
    // trace (e.g. the provider's Chrome profile is locked by another session).
    if (error?.code === "PROFILE_LOCKED") {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(error.stack ?? error.message);
    if (error.details?.diagnosticFile) {
      const dom = error.details.dom;
      const explanation = dom?.issues?.length ? dom.issues.join(", ") : dom?.status ?? "unavailable";
      console.error(`Page compatibility: ${explanation}`);
      console.error(`Diagnostic report: ${error.details.diagnosticFile}`);
    }
    process.exitCode = 1;
  }).finally(() => {
    // By the time every command finishes, all per-command cleanup (browser
    // detach/close, stdin raw-mode restore, process stop) has already run. A
    // stray tty handle (e.g. a keypress-machinery listener left behind on a
    // failed turn) can still pin the event loop, leaving a dead prompt that
    // never returns to the shell — exit hard instead of relying on the loop
    // to drain naturally.
    if (process.exitCode != null && process.exitCode !== 0) {
      process.stdin.setRawMode?.(false);
      process.stdin.pause?.();
      process.exit(process.exitCode);
    }
  });
}
