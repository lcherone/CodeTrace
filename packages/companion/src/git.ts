import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitRepository {
  constructor(readonly root: string) {}

  private async git(args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", this.root, ...args], { encoding: "utf8", maxBuffer });
    return stdout;
  }

  async revision(): Promise<{ commit: string; branch?: string; dirty: boolean }> {
    const commit = (await this.git(["rev-parse", "HEAD"])).trim();
    const branch = (await this.git(["branch", "--show-current"])).trim() || undefined;
    const dirty = Boolean((await this.git(["status", "--porcelain", "--untracked-files=no"])).trim());
    return { commit, ...(branch ? { branch } : {}), dirty };
  }

  async resolveCommit(commit: string): Promise<string | undefined> {
    try { return (await this.git(["rev-parse", "--verify", `${commit}^{commit}`])).trim() || undefined; }
    catch { return undefined; }
  }

  async treeFiles(commit: string): Promise<Array<{ path: string; objectId: string }>> {
    const output = await this.git(["ls-tree", "-r", "-z", "--full-tree", commit]);
    return output.split("\0").filter(Boolean).flatMap((record) => {
      const separator = record.indexOf("\t");
      if (separator < 0) return [];
      const [mode, type, objectId] = record.slice(0, separator).split(" ");
      if (!mode || type !== "blob" || !objectId) return [];
      return [{ path: record.slice(separator + 1), objectId }];
    });
  }

  async trackedFiles(): Promise<string[]> {
    return (await this.git(["ls-files", "-z"])).split("\0").filter(Boolean);
  }

  /**
   * Returns Git's index object id for each tracked stage-0 file. For a clean
   * worktree this is a stable content fingerprint and avoids opening every
   * source file merely to discover that it has not changed.
   */
  async trackedFileFingerprints(): Promise<Array<{ path: string; fingerprint: string }>> {
    const records = (await this.git(["ls-files", "--stage", "-z"])).split("\0").filter(Boolean);
    return records.flatMap((record) => {
      const separator = record.indexOf("\t");
      if (separator < 0) return [];
      const metadata = record.slice(0, separator).split(" ");
      const objectId = metadata[1];
      const stage = metadata[2];
      if (!objectId || stage !== "0") return [];
      return [{ path: record.slice(separator + 1), fingerprint: `git:${objectId}` }];
    });
  }

  async changedTrackedFiles(): Promise<Set<string>> {
    const [worktree, staged] = await Promise.all([
      this.git(["diff", "--name-only", "-z", "--diff-filter=ACMRTUXB"]),
      this.git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRTUXB"]),
    ]);
    return new Set(`${worktree}\0${staged}`.split("\0").filter(Boolean));
  }

  async deletedTrackedFiles(): Promise<Set<string>> {
    return new Set((await this.git(["ls-files", "--deleted", "-z"])).split("\0").filter(Boolean));
  }

  async show(commit: string, path: string): Promise<string | undefined> {
    try { return await this.git(["show", `${commit}:${path}`]); } catch { return undefined; }
  }

  async commitsForPath(path: string, limit = 1000): Promise<Array<{ commit: string; parents: string[]; authorName: string; authorEmail: string; authoredAt: string; summary: string }>> {
    const format = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";
    const output = await this.git(["log", "--follow", `--max-count=${limit}`, `--format=${format}`, "--", path]);
    return output.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
      const [commit = "", parents = "", authorName = "", authorEmail = "", authoredAt = "", summary = ""] = record.split("\x1f");
      return { commit, parents: parents.split(" ").filter(Boolean), authorName, authorEmail, authoredAt, summary };
    });
  }

  async changesAt(commit: string): Promise<Array<{ status: string; path: string; previousPath?: string }>> {
    const fields = (await this.git(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-M", "-z", commit])).split("\0").filter(Boolean);
    const changes: Array<{ status: string; path: string; previousPath?: string }> = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++] ?? "";
      if (status.startsWith("R") || status.startsWith("C")) {
        const previousPath = fields[index++]; const nextPath = fields[index++];
        if (previousPath && nextPath) changes.push({ status, path: nextPath, previousPath });
      } else {
        const changedPath = fields[index++]; if (changedPath) changes.push({ status, path: changedPath });
      }
    }
    return changes;
  }

  async revList(revision: string, limit = 2000): Promise<string[]> {
    return (await this.git(["rev-list", `--max-count=${limit}`, revision])).split("\n").map((value) => value.trim()).filter(Boolean);
  }

  async commitsTouching(revision: string, paths: string[], limit = 2000): Promise<string[]> {
    if (!paths.length) return [];
    return (await this.git(["log", "--no-merges", `--max-count=${limit}`, "--format=%H", revision, "--", ...paths])).split("\n").map((value) => value.trim()).filter(Boolean);
  }

  async patchId(commit: string, reverse = false): Promise<string | undefined> {
    const patch = await this.git(["show", "--format=", "--no-ext-diff", "--binary", ...(reverse ? ["-R"] : []), commit]);
    return new Promise<string | undefined>((resolve, reject) => {
      const child = spawn("git", ["patch-id", "--stable"], { cwd: this.root, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject); child.once("close", (code) => {
        if (code !== 0) reject(new Error(stderr.trim() || `git patch-id exited ${code}`));
        else resolve(stdout.trim().split(/\s+/)[0] || undefined);
      });
      child.stdin.end(patch);
    });
  }

  async patchShape(commit: string): Promise<{ forward: string; reverse: string }> {
    const patch = await this.git(["show", "--format=", "--no-ext-diff", "--unified=0", "--no-renames", commit]);
    const files: Array<{ path: string; removed: string[]; added: string[] }> = []; let current: { path: string; removed: string[]; added: string[] } | undefined;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+++ ")) { current = { path: line.slice(4).replace(/^b\//, ""), removed: [], added: [] }; files.push(current); }
      else if (current && line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
      else if (current && line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
    }
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    return { forward: digest(files), reverse: digest(files.map((file) => ({ path: file.path, removed: file.added, added: file.removed }))) };
  }

  async tagsWithRevisions(): Promise<Array<{ tag: string; revision: string }>> {
    const tags = (await this.git(["tag", "--list"])).split("\n").map((tag) => tag.trim()).filter(Boolean);
    const result: Array<{ tag: string; revision: string }> = [];
    for (const tag of tags) { const revision = await this.resolveCommit(tag); if (revision) result.push({ tag, revision }); }
    return result;
  }

  async tagsContaining(commit: string): Promise<string[]> {
    return (await this.git(["tag", "--contains", commit])).split("\n").map((tag) => tag.trim()).filter(Boolean);
  }

  async contains(ancestor: string, descendant = "HEAD"): Promise<boolean> {
    try { await this.git(["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch { return false; }
  }
}
