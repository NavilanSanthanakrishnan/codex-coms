import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "../config.js";
import { DEFAULT_MAX_LIST_ENTRIES, DEFAULT_MAX_READ_BYTES, isDeniedSecretPath, isSubpath } from "./fsAccess.js";

export interface WorkspaceGrant {
  id: string;
  ownerAgentId: string;
  targetAgentId: string;
  name: string;
  path: string;
  root: string;
  workspaceRoot: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  maxReadBytes: number;
  maxListEntries: number;
}

export interface GrantsFile {
  grants: WorkspaceGrant[];
}

export function parseTtl(ttl: string): number {
  const match = /^(\d+)(m|h|d)$/i.exec(ttl.trim());
  if (!match) {
    throw new Error("TTL must look like 30m, 2h, or 1d");
  }
  const amountText = match[1];
  const unitText = match[2];
  if (!amountText || !unitText) {
    throw new Error("TTL must look like 30m, 2h, or 1d");
  }
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error("TTL amount must be a positive safe integer");
  }
  const unit = unitText.toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const durationMs = amount * multiplier;
  if (!Number.isSafeInteger(durationMs)) {
    throw new Error("TTL duration is too large");
  }
  return durationMs;
}

function positiveIntegerLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return resolved;
}

export async function loadGrants(dataDir: string): Promise<WorkspaceGrant[]> {
  const file = path.join(dataDir, "grants.json");
  const data = await readJson<GrantsFile>(file, { grants: [] });
  return data.grants;
}

export async function saveGrants(dataDir: string, grants: WorkspaceGrant[]): Promise<void> {
  await writeJson(path.join(dataDir, "grants.json"), { grants });
}

export function isGrantActive(grant: WorkspaceGrant, now = new Date()): boolean {
  return !grant.revokedAt && new Date(grant.expiresAt).getTime() > now.getTime();
}

export async function createGrant(input: {
  dataDir: string;
  workspace: string;
  ownerAgentId: string;
  targetAgentId: string;
  grantPath: string;
  name: string;
  ttl: string;
  maxReadBytes?: number;
  maxListEntries?: number;
}): Promise<WorkspaceGrant> {
  const workspaceRoot = await realpath(input.workspace);
  const requested = path.isAbsolute(input.grantPath) ? input.grantPath : path.resolve(workspaceRoot, input.grantPath);
  const root = await realpath(requested);
  if (!isSubpath(workspaceRoot, root)) {
    throw new Error("grant path must resolve inside the workspace");
  }
  if (isDeniedSecretPath(workspaceRoot, root)) {
    throw new Error("grant path is denied by the secret filter");
  }
  await stat(root);
  const now = new Date();
  const grant: WorkspaceGrant = {
    id: `grant_${randomUUID()}`,
    ownerAgentId: input.ownerAgentId,
    targetAgentId: input.targetAgentId,
    name: input.name,
    path: path.relative(workspaceRoot, root).split(path.sep).join("/") || ".",
    root,
    workspaceRoot,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + parseTtl(input.ttl)).toISOString(),
    maxReadBytes: positiveIntegerLimit(input.maxReadBytes, DEFAULT_MAX_READ_BYTES, "maxReadBytes"),
    maxListEntries: positiveIntegerLimit(input.maxListEntries, DEFAULT_MAX_LIST_ENTRIES, "maxListEntries")
  };
  const grants = await loadGrants(input.dataDir);
  grants.push(grant);
  await saveGrants(input.dataDir, grants);
  return grant;
}

export async function revokeGrant(dataDir: string, grantId: string): Promise<WorkspaceGrant | undefined> {
  const grants = await loadGrants(dataDir);
  const grant = grants.find((item) => item.id === grantId);
  if (!grant) {
    return undefined;
  }
  grant.revokedAt = new Date().toISOString();
  await saveGrants(dataDir, grants);
  return grant;
}

export async function findUsableGrant(input: {
  dataDir: string;
  ownerAgentId: string;
  requesterAgentId: string;
  grantId: string;
}): Promise<WorkspaceGrant | undefined> {
  const grants = await loadGrants(input.dataDir);
  return grants.find((grant) => {
    return grant.id === input.grantId && grant.ownerAgentId === input.ownerAgentId && grant.targetAgentId === input.requesterAgentId && isGrantActive(grant);
  });
}
