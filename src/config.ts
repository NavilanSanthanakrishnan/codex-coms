import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_DATA_DIR = ".codex-coms";
export const DEFAULT_ROOM = "default";
export const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface WakeSettings {
  enabled: boolean;
  command?: string[];
  staticPrompt?: string;
  appendEventPath?: boolean;
}

export interface CodexComsConfig {
  agentId: string;
  displayName?: string;
  workspace: string;
  dataDir: string;
  relay?: string;
  room?: string;
  token?: string;
  wake?: WakeSettings;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeStatus {
  connected: boolean;
  agentId?: string;
  pid?: number;
  relay?: string;
  room?: string;
  connectedAt?: string;
  disconnectedAt?: string;
}

export function resolveWorkspace(workspace?: string): string {
  return path.resolve(workspace ?? process.cwd());
}

export function resolveDataDir(workspace: string, dataDir?: string): string {
  if (dataDir && path.isAbsolute(dataDir)) {
    return dataDir;
  }
  return path.resolve(workspace, dataDir ?? DEFAULT_DATA_DIR);
}

export function validateAgentId(agentId: string): void {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error("agent id must contain only letters, numbers, dot, underscore, colon, or hyphen; use display names for spaces");
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function initWorkspace(input: {
  agentId: string;
  displayName?: string;
  workspace?: string;
  dataDir?: string;
  relay?: string;
  room?: string;
  token?: string;
}): Promise<CodexComsConfig> {
  validateAgentId(input.agentId);
  const workspace = resolveWorkspace(input.workspace);
  const dataDir = resolveDataDir(workspace, input.dataDir);
  const now = new Date().toISOString();
  await mkdir(path.join(dataDir, "transfers"), { recursive: true });
  const configFile = path.join(dataDir, "config.json");
  const existing = await readJson<Partial<CodexComsConfig>>(configFile, {});
  const config: CodexComsConfig = {
    agentId: input.agentId,
    displayName: input.displayName ?? existing.displayName,
    workspace,
    dataDir,
    relay: input.relay ?? existing.relay,
    room: input.room ?? existing.room ?? DEFAULT_ROOM,
    token: input.token ?? existing.token,
    wake: existing.wake,
    createdAt: existing.createdAt ?? now,
    updatedAt: now
  };
  await writeJson(configFile, config);
  const files = ["inbox.jsonl", "outbox.jsonl", "audit.jsonl"];
  for (const file of files) {
    const target = path.join(dataDir, file);
    if (!(await pathExists(target))) {
      await writeFile(target, "", "utf8");
    }
  }
  const grantsFile = path.join(dataDir, "grants.json");
  if (!(await pathExists(grantsFile))) {
    await writeJson(grantsFile, { grants: [] });
  }
  await setRuntimeStatus(dataDir, {
    connected: false,
    relay: config.relay,
    room: config.room
  });
  return config;
}

export async function loadConfig(workspace?: string, dataDir?: string): Promise<CodexComsConfig> {
  const resolvedWorkspace = resolveWorkspace(workspace);
  const resolvedDataDir = resolveDataDir(resolvedWorkspace, dataDir);
  return readJson<CodexComsConfig>(path.join(resolvedDataDir, "config.json"), undefined as never);
}

export async function saveConfig(config: CodexComsConfig): Promise<void> {
  await writeJson(path.join(config.dataDir, "config.json"), {
    ...config,
    updatedAt: new Date().toISOString()
  });
}

export async function updateConfig(config: CodexComsConfig, patch: Partial<CodexComsConfig>): Promise<CodexComsConfig> {
  const next = {
    ...config,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await saveConfig(next);
  return next;
}

export async function loadRuntimeStatus(dataDir: string): Promise<RuntimeStatus> {
  return readJson<RuntimeStatus>(path.join(dataDir, "status.json"), { connected: false });
}

export async function setRuntimeStatus(dataDir: string, status: RuntimeStatus): Promise<void> {
  await writeJson(path.join(dataDir, "status.json"), status);
}
