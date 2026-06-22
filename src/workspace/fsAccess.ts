import { readdir, readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RemoteFileEntry } from "../protocol/types.js";
import type { WorkspaceGrant } from "./grants.js";

export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
export const DEFAULT_MAX_LIST_ENTRIES = 200;

export class FsAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsAccessError";
  }
}

export function isSubpath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function decodeRemotePath(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    throw new FsAccessError("path is not valid URI text");
  }
}

function hasTraversal(input: string): boolean {
  return input.split(/[\\/]+/).includes("..");
}

export function isDeniedSecretPath(workspaceRoot: string, absolutePath: string): boolean {
  const relative = path.relative(workspaceRoot, absolutePath);
  const normalized = relative.split(path.sep).join("/");
  const parts = normalized.split("/").filter(Boolean);
  const basename = path.basename(absolutePath);
  if (normalized === "" || normalized.startsWith("../")) {
    return true;
  }
  if (basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }
  if (basename === ".npmrc" || basename === ".pypirc" || basename === ".git-credentials") {
    return true;
  }
  if (basename.endsWith(".pem") || basename.endsWith(".key") || basename === "id_rsa" || basename === "id_ed25519") {
    return true;
  }
  if (parts.includes(".git") || parts.includes("node_modules") || parts.includes(".ssh") || parts.includes(".aws") || parts.includes(".config")) {
    return true;
  }
  if (parts[0] === ".codex-coms") {
    return true;
  }
  return false;
}

async function resolveGrantTarget(grant: WorkspaceGrant, remotePath: string): Promise<string> {
  const decoded = decodeRemotePath(remotePath || ".");
  if (decoded.includes("\0")) {
    throw new FsAccessError("path contains a null byte");
  }
  if (hasTraversal(decoded)) {
    throw new FsAccessError("path traversal is not allowed");
  }
  const candidate = path.isAbsolute(decoded) ? decoded : path.resolve(grant.root, decoded);
  const realRoot = await realpath(grant.root);
  let realTarget: string;
  try {
    realTarget = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FsAccessError("path does not exist");
    }
    throw error;
  }
  if (!isSubpath(realRoot, realTarget)) {
    throw new FsAccessError("path escapes the grant root");
  }
  if (isDeniedSecretPath(grant.workspaceRoot, realTarget)) {
    throw new FsAccessError("path is denied by the secret filter");
  }
  return realTarget;
}

function relativeEntryPath(grant: WorkspaceGrant, absolutePath: string): string {
  const relative = path.relative(grant.root, absolutePath).split(path.sep).join("/");
  return relative || ".";
}

export async function listGrantedPath(grant: WorkspaceGrant, remotePath = "."): Promise<RemoteFileEntry[]> {
  const target = await resolveGrantTarget(grant, remotePath);
  const targetStat = await stat(target);
  if (targetStat.isFile()) {
    return [{
      name: path.basename(target),
      path: relativeEntryPath(grant, target),
      type: "file",
      size: targetStat.size
    }];
  }
  if (!targetStat.isDirectory()) {
    throw new FsAccessError("path is neither a file nor a directory");
  }
  const entries = await readdir(target, { withFileTypes: true });
  const output: RemoteFileEntry[] = [];
  for (const entry of entries) {
    if (output.length >= grant.maxListEntries) {
      break;
    }
    const absolute = path.join(target, entry.name);
    let resolved: string;
    try {
      resolved = await realpath(absolute);
    } catch {
      continue;
    }
    if (!isSubpath(grant.root, resolved) || isDeniedSecretPath(grant.workspaceRoot, resolved)) {
      continue;
    }
    const entryStat = await stat(resolved);
    if (!entryStat.isFile() && !entryStat.isDirectory()) {
      continue;
    }
    output.push({
      name: entry.name,
      path: relativeEntryPath(grant, resolved),
      type: entryStat.isDirectory() ? "directory" : "file",
      size: entryStat.isFile() ? entryStat.size : undefined
    });
  }
  return output;
}

export async function readGrantedFile(grant: WorkspaceGrant, remotePath: string): Promise<{ path: string; size: number; sha256: string; contentBase64: string }> {
  const target = await resolveGrantTarget(grant, remotePath);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new FsAccessError("path is not a file");
  }
  if (targetStat.size > grant.maxReadBytes) {
    throw new FsAccessError(`file exceeds max read size of ${grant.maxReadBytes} bytes`);
  }
  const content = await readFile(target);
  return {
    path: relativeEntryPath(grant, target),
    size: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    contentBase64: content.toString("base64")
  };
}
