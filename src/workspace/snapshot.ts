import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isDeniedSecretPath } from "./fsAccess.js";

export interface WorkspaceSnapshotSummary {
  workspace: string;
  generatedAt: string;
  visibleRootEntries: Array<{ name: string; type: "file" | "directory"; size?: number }>;
}

export async function createWorkspaceSnapshotSummary(workspace: string, limit = 50): Promise<WorkspaceSnapshotSummary> {
  const entries = await readdir(workspace, { withFileTypes: true });
  const visibleRootEntries: WorkspaceSnapshotSummary["visibleRootEntries"] = [];
  for (const entry of entries) {
    if (visibleRootEntries.length >= limit) {
      break;
    }
    const absolute = path.join(workspace, entry.name);
    if (isDeniedSecretPath(workspace, absolute)) {
      continue;
    }
    const entryStat = await stat(absolute);
    if (!entryStat.isFile() && !entryStat.isDirectory()) {
      continue;
    }
    visibleRootEntries.push({
      name: entry.name,
      type: entryStat.isDirectory() ? "directory" : "file",
      size: entryStat.isFile() ? entryStat.size : undefined
    });
  }
  return {
    workspace,
    generatedAt: new Date().toISOString(),
    visibleRootEntries
  };
}
