import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";

export class CredentialStore {
  constructor(private readonly dataDirectory: string) {}
  private get file(): string { return path.join(this.dataDirectory, "credentials.json"); }

  async getGitHubToken(): Promise<string | undefined> {
    if (process.env.TRACE_GITHUB_TOKEN) return process.env.TRACE_GITHUB_TOKEN;
    try { return (JSON.parse(await readFile(this.file, "utf8")) as { githubToken?: string }).githubToken; } catch { return undefined; }
  }

  async setGitHubToken(token: string): Promise<void> {
    if (!token.trim()) throw new Error("GitHub token cannot be empty");
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify({ githubToken: token }), { mode: 0o600 });
    await chmod(this.file, 0o600);
  }
}
