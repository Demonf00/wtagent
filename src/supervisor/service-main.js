#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAppDataDir, getSessionsDir } from "../platform/paths.js";
import { TaskSupervisor } from "./task-supervisor.js";
import { startControlApi } from "./control-api.js";

export async function startSupervisorService({
  configPath,
  token = process.env.WTAGENT_SUPERVISOR_TOKEN,
} = {}) {
  if (!configPath || typeof configPath !== "string") {
    throw new Error("Provide --config <absolute-or-relative-config.json>.");
  }
  const resolvedConfig = path.resolve(configPath);
  const configStat = await fs.lstat(resolvedConfig);
  if (!configStat.isFile() || configStat.isSymbolicLink()) {
    throw new Error("Supervisor config must be a regular file, not a symbolic link.");
  }
  const config = JSON.parse(await fs.readFile(resolvedConfig, "utf8"));
  if (!config || Array.isArray(config) || typeof config !== "object"
    || !Array.isArray(config.workspaces)
    || Object.keys(config).some((key) => !["home", "workspaces", "port", "options"].includes(key))) {
    throw new Error("Invalid supervisor configuration.");
  }
  const home = path.resolve(config.home ?? getAppDataDir());
  if (config.home != null && !path.isAbsolute(config.home)) {
    throw new Error("Supervisor home must be an absolute path.");
  }
  const supervisor = new TaskSupervisor({
    dataDir: path.join(home, "supervisor"),
    sessionsDir: getSessionsDir(home),
    workspaces: config.workspaces,
    options: { home, ...(config.options ?? {}) },
  });
  await supervisor.init();
  let api;
  try {
    api = await startControlApi({ supervisor, token, port: config.port ?? 8765 });
  } catch (error) {
    await supervisor.close();
    throw error;
  }
  return {
    supervisor, api,
    async close() {
      await api.close();
      await supervisor.close();
    },
  };
}

const entry = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
const moduleFile = await fs.realpath(fileURLToPath(import.meta.url)).catch(() => null);
if (entry && moduleFile && (process.platform === "win32"
  ? entry.toLowerCase() === moduleFile.toLowerCase() : entry === moduleFile)) {
  const index = process.argv.indexOf("--config");
  if (index < 0 || !process.argv[index + 1]) {
    console.error("Usage: node src/supervisor/service-main.js --config config.json");
    process.exitCode = 2;
  } else {
    try {
      const service = await startSupervisorService({ configPath: process.argv[index + 1] });
      console.log(`WTAgent Task Supervisor listening on ${service.api.url}`);
      console.log("Workspace IDs:", [...service.supervisor.workspaces.keys()].join(", "));
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        await service.close();
      };
      process.once("SIGINT", () => void shutdown().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      }));
      process.once("SIGTERM", () => void shutdown().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      }));
    } catch (error) {
      console.error(`Supervisor startup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
