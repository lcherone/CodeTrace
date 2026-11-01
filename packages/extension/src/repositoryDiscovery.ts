import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import * as vscode from "vscode";
import type { DiscoveredRepositories } from "./scanner";

const DISCOVERY_EXCLUDE = "**/{.git,node_modules,vendor,.trace,dist,build,coverage,cache,caches}/**";

export async function discoverWorkspaceRepositories(maxComposerManifests: number, signal: AbortSignal): Promise<DiscoveredRepositories> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file");
  if (!folders.length || signal.aborted) return { roots: [], truncated: false };

  const cancellation = new vscode.CancellationTokenSource();
  const abort = () => cancellation.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const limit = Math.max(1, maxComposerManifests);
    const manifests = await vscode.workspace.findFiles("**/composer.json", DISCOVERY_EXCLUDE, limit, cancellation.token);
    if (signal.aborted) return { roots: [], truncated: false };
    const candidates = new Set(folders.map((folder) => folder.uri.fsPath));
    for (const manifest of manifests) if (manifest.scheme === "file") candidates.add(dirname(manifest.fsPath));
    const roots = await gitRoots([...candidates], signal, 4);
    return { roots: [...new Set(roots)].sort(), truncated: manifests.length >= limit };
  } finally {
    signal.removeEventListener("abort", abort);
    cancellation.dispose();
  }
}

export async function repositoryRootForPath(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return undefined;
  return gitRoot(dirname(filePath), signal);
}

async function gitRoots(candidates: string[], signal: AbortSignal, concurrency: number): Promise<string[]> {
  const roots: string[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (!signal.aborted) {
      const candidate = candidates[cursor++];
      if (!candidate) return;
      const root = await gitRoot(candidate, signal);
      if (root) roots.push(root);
    }
  });
  await Promise.all(workers);
  return roots;
}

async function gitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    return realpath(output.trim());
  } catch {
    return undefined;
  }
}
