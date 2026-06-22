import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function sidecarPidPath(dataDir: string): string {
  return path.join(dataDir, "sidecar.pid");
}

export async function readSidecarPid(dataDir: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(sidecarPidPath(dataDir), "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeSidecarPid(dataDir: string, pid = process.pid): Promise<void> {
  await writeFile(sidecarPidPath(dataDir), `${pid}\n`, "utf8");
}

export async function clearSidecarPid(dataDir: string, pid = process.pid): Promise<void> {
  const current = await readSidecarPid(dataDir);
  if (!current || current === pid) {
    await rm(sidecarPidPath(dataDir), { force: true });
  }
}

export async function ensureNoDuplicateSidecar(dataDir: string, replace = false): Promise<void> {
  const existing = await readSidecarPid(dataDir);
  if (!existing) {
    return;
  }
  if (existing === process.pid) {
    return;
  }
  if (!isProcessRunning(existing)) {
    await clearSidecarPid(dataDir, existing);
    return;
  }
  if (!replace) {
    throw new Error(`sidecar already appears to be running as pid ${existing}; stop it or pass --replace`);
  }
  process.kill(existing, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(existing)) {
      await clearSidecarPid(dataDir, existing);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`sidecar pid ${existing} did not exit after SIGTERM`);
}
