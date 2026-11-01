import path from "node:path";
import type { SourceRange } from "@trace/contracts";
import { parseGitHubRepository } from "./github.js";
import { GitRepository } from "./git.js";
import { TraceStore } from "./store.js";

export interface SourceLink {
  label: string; repositoryId: string; commit: string; path?: string; range?: SourceRange;
  githubUrl?: string; vscodeUrl?: string; unavailable?: string;
}

export function immutableGitHubSource(remote: string | undefined, commit: string, file: string, range?: SourceRange): string | undefined {
  const repository = parseGitHubRepository(remote);
  if (!repository || !/^[\da-f]{40}(?:[\da-f]{24})?$/i.test(commit)) return undefined;
  if (![repository.owner, repository.name].every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== "..")) return undefined;
  if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").some((part) => part === ".." || part === "." || !part)) return undefined;
  const anchor = range ? `#L${Math.max(1, range.startLine)}-L${Math.max(range.startLine, range.endLine)}` : "";
  return `${repository.url}/blob/${commit}/${file.split("/").map(encodeURIComponent).join("/")}${anchor}`;
}

export class SourceNavigation {
  constructor(private readonly store: TraceStore) {}

  repositoryUrl(repositoryId: string): string | undefined {
    const record = this.store.repository(repositoryId);
    const pkg = this.store.activePackages().find((item) => item.repositoryId === repositoryId);
    return parseGitHubRepository(record?.remoteUrl ?? pkg?.repositoryUrl)?.url;
  }

  link(repositoryId: string, commit: string, file: string, range?: SourceRange, dirty = false, label = "Source"): SourceLink {
    const record = this.store.repository(repositoryId);
    const repositoryUrl = this.repositoryUrl(repositoryId);
    const githubUrl = dirty ? undefined : immutableGitHubSource(repositoryUrl, commit, file, range);
    const safeFile = Boolean(file && !path.isAbsolute(file) && !file.includes("\\") && !file.split("/").includes(".."));
    const local = record && safeFile ? path.resolve(record.root, file) : undefined;
    const vscodeUrl = local ? `vscode://file${local.split("/").map(encodeURIComponent).join("/")}:${range?.startLine ?? 1}:${(range?.startColumn ?? 0) + 1}` : undefined;
    return { label, repositoryId, commit, path: file, ...(range ? { range } : {}), ...(githubUrl ? { githubUrl } : {}), ...(vscodeUrl ? { vscodeUrl } : {}), ...(!githubUrl ? { unavailable: dirty ? "Unsaved local changes: an exact GitHub source link is unavailable." : "No validated GitHub repository and exact indexed commit are available." } : {}) };
  }

  async dependency(repositoryId: string, packageName: string, commit?: string): Promise<SourceLink[]> {
    const repository = this.store.repository(repositoryId);
    const basis = this.store.activeGenerationBasis(repositoryId);
    if (!repository || !basis) return [];
    const revision = commit && /^[\da-f]{40}(?:[\da-f]{24})?$/i.test(commit) ? commit : basis.commit;
    const pkg = this.store.activePackages().find((item) => item.repositoryId === repositoryId);
    const root = pkg?.rootPath ? `${pkg.rootPath.replace(/\/$/, "")}/` : "";
    return (await Promise.all(["composer.json", "composer.lock"].map(async (name) => {
      const file = `${root}${name}`;
      const source = await new GitRepository(repository.root).show(revision, file);
      if (!source) return undefined;
      const lines = source.split("\n");
      const needle = JSON.stringify(packageName);
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const declaration = new RegExp(name === "composer.lock" ? `"name"\\s*:\\s*${escaped}` : `${escaped}\\s*:`);
      const index = lines.findIndex((line) => declaration.test(line));
      if (index < 0) return undefined;
      const range = { startLine: index + 1, startColumn: 0, endLine: index + 1, endColumn: lines[index]!.length };
      return this.link(repositoryId, revision, file, range, false, name === "composer.lock" ? `Lock evidence · ${packageName}` : `Dependency declaration · ${packageName}`);
    }))).filter((item): item is SourceLink => Boolean(item));
  }

  async preview(link: SourceLink): Promise<string | undefined> {
    if (!link.path || link.unavailable?.startsWith("Unsaved")) return undefined;
    const repository = this.store.repository(link.repositoryId);
    if (!repository) return undefined;
    const source = await new GitRepository(repository.root).show(link.commit, link.path);
    if (!source) return undefined;
    const start = Math.max(0, (link.range?.startLine ?? 1) - 1);
    return source.split("\n").slice(start, Math.min(link.range?.endLine ?? start + 100, start + 120)).join("\n").slice(0, 16_000);
  }
}
