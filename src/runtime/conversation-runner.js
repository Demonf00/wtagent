import path from "node:path";
import { createWebAdapter, DEFAULT_PROVIDER, getProviderProfileDir, resolveProvider } from "../browser/provider-registry.js";
import { getAppDataDir, getSessionsDir, getTasksDir, formatHomePath } from "../platform/paths.js";
import { AgentRuntime } from "./agent-runtime.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { ApprovalStore } from "../policy/approval-store.js";
import { createDefaultToolRegistry } from "../tools/default-tools.js";
import { ProcessManager } from "../tools/process-manager.js";
import { NativeImageReceiver } from "../image/native-image-receiver.js";
import { NativeMusicReceiver, validateGenerationType } from "../audio/native-music-receiver.js";
import { resolveLimits } from "../shared/limits.js";
import { promptForContinue } from "../cli/prompt-input.js";
import { createRenderer } from "../cli/render-events.js";
import { t } from "../cli/i18n.js";
import { select } from "@inquirer/prompts";

// Resolves the app data dir, the provider's dedicated Chrome profile dir, and
// the sessions dirs. `providerId` selects which profile directory is used
// (each provider logs in independently); an explicit `--profile-dir` still
// overrides it. Defaults to the ChatGPT profile so callers that predate
// multi-provider support are unaffected.
export function resolveRuntimePaths(options, providerId = DEFAULT_PROVIDER) {
  const appDataDir = path.resolve(options.home ?? getAppDataDir());
  return {
    appDataDir,
    profileDir: path.resolve(
      options.profileDir ?? getProviderProfileDir(appDataDir, providerId),
    ),
    sessionsDir: getSessionsDir(appDataDir),
    legacyTasksDir: getTasksDir(appDataDir),
  };
}

// Supervisor CLI runs in the parent process and writes approvals.json there.
// The Worker caches ApprovalStore on its first policy evaluation. Refresh after
// each parent decision so an "always allow" choice takes effect *during* this
// Worker run, not only on the next CLI turn or process restart.
export async function requestSupervisorApproval({ approvalProvider, approvalStore, toolCall, reasons }) {
  const approved = await approvalProvider.request({ toolCall, reasons });
  await approvalStore.reload();
  return approved;
}

// Owns the browser adapter, process manager, and renderer for the lifetime of
// one conversation. A single instance drives many turns: the first turn boots
// the session, and each later turn reuses the same open Chrome tab and session
// state via runtime.run({ resume: true }).
export class ConversationRunner {
  constructor({ session, options, interactive = false, approvalProvider = null, onEvent = null, control = null, adapter = null, renderer = null }) {
    this.session = session;
    this.options = options;
    // A conversation belongs to exactly one provider (recorded at creation).
    // The profile dir and adapter follow from it, so resumes reuse the right
    // login even when the CLI is invoked without --model.
    const provider = resolveProvider(session.state.provider ?? DEFAULT_PROVIDER);
    this.provider = provider;
    this.interactive = interactive;
    this.approvalProvider = approvalProvider;
    this.eventListener = onEvent;
    this.control = control;
    this.paths = resolveRuntimePaths(options, provider.id);
    this.limits = resolveLimits({
      modelTurnTimeoutMs: options.modelTurnTimeoutMs,
    });
    this.processManager = new ProcessManager();
    this.renderer = renderer ?? createRenderer({ providerLabel: provider.label });
    // "Always allow" decisions are scoped to this saved session. They persist
    // across turns and `resume`, but never carry over into a different session.
    this.approvalStore = new ApprovalStore({
      filePath: path.join(this.session.directory, "approvals.json"),
    });
    this.adapter = adapter ?? createWebAdapter({
      provider,
      profileDir: this.paths.profileDir,
      chromePath: options.chromePath,
      debug: options.debug,
      // Minimize by default; `--no-minimize` sets options.minimize === false.
      minimized: options.minimize !== false,
      // ESC cancels the in-flight turn while the model is processing. Only in
      // interactive TTY sessions where stdin is available to listen on.
      cancelOnEsc: interactive,
    });
    const generationType = validateGenerationType(session.state.generationType, provider.id);
    this.nativeMusicReceiver = generationType === "music" ? new NativeMusicReceiver({ adapter: this.adapter }) : null;
    this.nativeImageReceiver = this.nativeMusicReceiver ? null : NativeImageReceiver.forAdapter(provider.id, this.adapter);
    this.interrupted = false;
    this.closed = false;
  }

  #buildRuntime() {
    return new AgentRuntime({
      adapter: this.adapter,
      nativeImageReceiver: this.nativeImageReceiver,
      nativeMusicReceiver: this.nativeMusicReceiver,
      registry: createDefaultToolRegistry({
        processManager: this.processManager,
        limits: this.limits,
      }),
      policy: new PolicyEngine({ store: this.approvalStore }),
      session: this.session,
      control: this.control,
      limits: this.limits,
      postAuthSetup: (
        this.interactive
          ? async ({ adapter }) => {
            this.renderer.stopSpinner();
            await adapter.restoreWindow?.();
            try {
              const answer = await promptForContinue({
                message: t("model.chooseInBrowser", {
                  provider: this.provider.label,
                }),
                countdown: (seconds) => t(seconds > 0
                  ? "model.continueCountdown" : "model.continuing", { seconds }),
              });
              if (answer == null) {
                throw new Error(t("model.setupCancelled"));
              }
            } finally {
              await adapter.minimizeWindow?.();
            }
          }
          : null
      ),
      approval: async ({ toolCall, reasons }) => {
        if (this.approvalProvider) {
          return await requestSupervisorApproval({
            approvalProvider: this.approvalProvider,
            approvalStore: this.approvalStore,
            toolCall, reasons,
          });
        }
        if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
        this.renderer.stopSpinner();
        console.log(
          `\n${"\x1b[33m"}${t("approval.required", { tool: toolCall.name })}${"\x1b[0m"}`,
        );
        for (const reason of reasons) {
          console.log(`- ${reason}`);
        }
        console.log(JSON.stringify(toolCall.args, null, 2));
        const choice = await select({
          message: t("approval.how"),
          choices: [
            { name: t("approval.once"), value: "once" },
            {
              name: t("approval.alwaysTool", { tool: toolCall.name }),
              value: "always-tool",
            },
            { name: t("approval.alwaysAll"), value: "always-all" },
            { name: t("approval.deny"), value: "deny" },
          ],
        });
        if (choice === "deny") {
          return false;
        }
        if (choice === "always-tool") {
          this.approvalStore.setAlwaysAllowedTool(toolCall.name);
          await this.approvalStore.save();
          console.log(t("approval.savedTool", {
            tool: toolCall.name,
            file: formatHomePath(this.approvalStore.filePath),
          }));
        } else if (choice === "always-all") {
          this.approvalStore.setAlwaysAllowAll();
          await this.approvalStore.save();
          console.log(t("approval.savedAll", {
            file: formatHomePath(this.approvalStore.filePath),
          }));
        }
        return true;
      },
      onEvent: async (event) => {
        this.renderer.handle(event);
        await this.eventListener?.(event);
      },
    });
  }

  // Runs one turn. The first turn (resume=false) boots the session; later turns
  // resume the same conversation with a new user instruction. `files` are
  // resolved @file attachments for this turn's message.
  async runTurn({
    resume,
    instruction,
    files = [],
    inPlaceRecovery = false,
    mode = null,
  }) {
    const runtime = this.#buildRuntime();
    try {
      const result = await runtime.run({
        resume,
        instruction,
        files,
        inPlaceRecovery,
        mode,
      });
      return result;
    } catch (error) {
      if (this.interrupted) {
        await this.session.update({
          phase: "interrupted",
          lastError: "Interrupted by user.",
        });
        await this.session.appendEvent("run.interrupted", {
          message: "Interrupted by user.",
        });
        return null;
      }
      if (error?.code === "TURN_CANCELLED") {
        // ESC during processing: the turn is cancelled but the conversation,
        // browser, and managed processes stay alive. Return to the prompt so
        // the user can send a new message or quit.
        this.renderer.stopSpinner();
        await this.session.update({
          phase: "interrupted",
          lastError: "Turn cancelled by user.",
        });
        await this.session.appendEvent("run.turn_cancelled", {
          message: "Turn cancelled by user.",
        });
        return { cancelled: true, error };
      }
      if (error?.code === "EMPTY_ASSISTANT_RETRIES_EXHAUSTED") {
        await this.session.update({
          phase: "awaiting_user",
          lastError: error.message,
        });
        const event = await this.session.appendEvent("run.recovery_required", {
          message: error.message,
          retries: error.details?.retries ?? null,
        });
        this.renderer.handle(event);
        return { recoveryRequired: true, error };
      }
      if (this.session.state.phase !== "idle") {
        await this.session.update({
          phase: "interrupted",
          lastError: error.message,
        });
        await this.session.appendEvent("run.interrupted", {
          message: error.message,
        });
      }
      throw error;
    }
  }

  // Closes the browser and stops managed processes. After a failed run the
  // browser is kept alive so the page state can be inspected: the saved CDP
  // state lets the next `wtagent resume` reuse the same window, and a later
  // launch reaps it if it has died in the meantime.
  async close({ keepBrowser = false } = {}) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.renderer.finish();
    await this.processManager.stopAll().catch(() => {});
    if (keepBrowser) {
      // Only offer to keep Chrome when this run actually launched one. A run
      // that failed before launch (e.g. the provider profile lock was held by
      // another live session) has no window to inspect.
      if (!this.adapter.cdpChrome) {
        return;
      }
      await this.adapter.detach().catch((error) => {
        console.error(`Warning: ${error.message}`);
      });
      console.log(
        "The run failed; Chrome was left open for debugging. "
          + "Inspect the page and close it manually, or just run "
          + "`wtagent resume` again — it will reuse this window.",
      );
      return;
    }
    await this.adapter.close().catch((error) => {
      console.error(`Warning: ${error.message}`);
    });
  }
}


export async function executeConversationTurn({
  session, options = {}, resume = false, instruction = null, files = [],
  approvalProvider, onEvent, control, adapter, renderer,
  createRunner = (config) => new ConversationRunner(config),
}) {
  const runner = createRunner({
    session, options, interactive: false, approvalProvider, onEvent, control, adapter, renderer,
  });
  try {
    return await runner.runTurn({ resume, instruction, files });
  } finally {
    // A failed/incomplete Worker turn may have already sent a web message.
    // Its exact Chrome target MUST survive the worker so a replacement can
    // reconcile the persisted handoff without submitting the message again.
    // close() on an ordinary CDP connection shuts Chrome down entirely;
    // detach() leaves Chrome and its target alive and releases the profile lock.
    const state = session.state;
    const keepBrowser = Boolean(state.pendingOutbound
      || state.pendingAssistantTurn || state.pendingAuxiliaryTurn);
    await runner.close({ keepBrowser });
  }
}
