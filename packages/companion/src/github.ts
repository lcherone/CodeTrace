import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { normalizeRepositoryUrl } from "./composer.js";

const execFileAsync = promisify(execFile);

export interface GitHubRepositoryIdentity { owner: string; name: string; fullName: string; url: string }
export interface GitHubPullRequest {
  number: number; url: string; title: string; state: "open" | "closed"; mergedAt?: string | null;
  headRepository?: string; headRepositoryUrl?: string; headCommit?: string;
}
export interface GitHubRelease {
  url: string; name?: string | null; publishedAt?: string | null; draft: boolean; prerelease: boolean; targetCommitish?: string;
}

export function parseGitHubRepository(value: string | undefined): GitHubRepositoryIdentity | undefined {
  const normalized = normalizeRepositoryUrl(value);
  const match = normalized?.match(/^github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match) return undefined;
  const owner = match[1]!; const name = match[2]!;
  return { owner, name, fullName: `${owner}/${name}`, url: `https://github.com/${owner}/${name}` };
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "GitHubApiError"; }
}

export class GitHubClient {
  constructor(private readonly token: string, private readonly apiBase = "https://api.github.com") {}

  private headers(): Record<string, string> { return { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }; }

  async listOrganisationRepositories(organisation: string, signal?: AbortSignal, maxPages = 10): Promise<Array<{ id: number; fullName: string; cloneUrl: string; defaultBranch: string; private: boolean }>> {
    const repositories: Array<{ id: number; fullName: string; cloneUrl: string; defaultBranch: string; private: boolean }> = [];
    for (let page = 1; page <= maxPages; page++) {
      const response = await fetch(`${this.apiBase}/orgs/${encodeURIComponent(organisation)}/repos?per_page=100&page=${page}`, {
        headers: this.headers(), ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(`GitHub repository discovery failed (${response.status})`);
      const body = await response.json() as any[];
      for (const repo of body) repositories.push({ id: repo.id, fullName: repo.full_name, cloneUrl: repo.clone_url, defaultBranch: repo.default_branch, private: repo.private });
      if (body.length < 100) break;
    }
    return repositories;
  }

  async pullRequestsForCommit(repository: GitHubRepositoryIdentity, commit: string, signal?: AbortSignal, maxPages = 2, maxResults = 50): Promise<{ pullRequests: GitHubPullRequest[]; truncated: boolean }> {
    const result: GitHubPullRequest[] = [];
    let truncated = false;
    const perPage = Math.min(100, Math.max(1, maxResults));
    for (let page = 1; page <= maxPages && result.length < maxResults; page++) {
      const response = await fetch(`${this.apiBase}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${encodeURIComponent(commit)}/pulls?per_page=${perPage}&page=${page}`, { headers: this.headers(), ...(signal ? { signal } : {}) });
      if (!response.ok) throw new GitHubApiError(response.status, `GitHub commit pull-request association failed (${response.status})`);
      const body = await response.json() as any[];
      for (const item of body.slice(0, maxResults - result.length)) result.push({
        number: Number(item.number), url: String(item.html_url), title: String(item.title ?? ""), state: item.state === "open" ? "open" : "closed",
        ...(item.merged_at !== undefined ? { mergedAt: item.merged_at as string | null } : {}),
        ...(item.head?.repo?.full_name ? { headRepository: String(item.head.repo.full_name) } : {}),
        ...(item.head?.repo?.html_url ? { headRepositoryUrl: String(item.head.repo.html_url) } : {}),
        ...(item.head?.sha ? { headCommit: String(item.head.sha) } : {}),
      });
      if (body.length < perPage) break;
      if (page === maxPages || result.length >= maxResults) truncated = true;
    }
    return { pullRequests: result, truncated };
  }

  async releaseForTag(repository: GitHubRepositoryIdentity, tag: string, signal?: AbortSignal): Promise<GitHubRelease | undefined> {
    const response = await fetch(`${this.apiBase}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/releases/tags/${encodeURIComponent(tag)}`, { headers: this.headers(), ...(signal ? { signal } : {}) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new GitHubApiError(response.status, `GitHub exact-tag release association failed (${response.status})`);
    const item = await response.json() as any;
    return {
      url: String(item.html_url), ...(item.name !== undefined ? { name: item.name as string | null } : {}),
      ...(item.published_at !== undefined ? { publishedAt: item.published_at as string | null } : {}),
      draft: Boolean(item.draft), prerelease: Boolean(item.prerelease),
      ...(typeof item.target_commitish === "string" ? { targetCommitish: item.target_commitish } : {}),
    };
  }
}

export class RepositoryCache {
  constructor(readonly root: string) {}
  async cloneOrFetch(fullName: string, cloneUrl: string, branch: string): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error("Invalid repository name");
    const destination = path.join(this.root, ...fullName.split("/"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await execFileAsync("git", ["-C", destination, "fetch", "--prune", "origin", branch], { maxBuffer: 16 * 1024 * 1024 });
    } catch {
      await execFileAsync("git", ["clone", "--filter=blob:none", "--no-checkout", "--branch", branch, "--", cloneUrl, destination], { maxBuffer: 16 * 1024 * 1024 });
    }
    return destination;
  }
}
