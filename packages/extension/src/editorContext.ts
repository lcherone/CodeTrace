import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { phpSymbolHint, type PublicEditorPosition } from "./activeContextSupport";
import type { CompanionClient, CompanionRepository } from "./client";
import { repositoryRootForPath } from "./repositoryDiscovery";

const execFileAsync = promisify(execFile);
type RepositoryIdentity = { repositoryId: string; commit: string; generation: number };

export class EditorContextResolver {
  private readonly identities = new Map<string, RepositoryIdentity>();

  constructor(private readonly client: CompanionClient) {}

  clear(): void {
    this.identities.clear();
  }

  async resolve(editor: vscode.TextEditor | undefined, signal: AbortSignal): Promise<PublicEditorPosition | undefined> {
    if (!editor || !eligibleEditor(editor)) return undefined;
    const root = await repositoryRootForPath(editor.document.uri.fsPath, signal);
    if (!root || signal.aborted) return undefined;
    const identity = await this.repositoryIdentity(root, signal);
    if (!identity || signal.aborted) return undefined;
    const relativePath = relative(root, editor.document.uri.fsPath).replaceAll("\\", "/");
    if (relativePath === ".." || relativePath.startsWith("../")) return undefined;
    const selection = editor.selection.isEmpty
      ? editor.document.getWordRangeAtPosition(editor.selection.active) ?? editor.selection
      : editor.selection;
    const symbolHint = phpSymbolHint(editor.document.getText(selection), editor.document.getText());
    return {
      repositoryPath: root,
      repositoryId: identity.repositoryId,
      relativePath,
      revision: { commit: identity.commit, dirty: editor.document.isDirty },
      range: {
        startLine: selection.start.line + 1,
        startColumn: selection.start.character,
        endLine: selection.end.line + 1,
        endColumn: selection.end.character,
      },
      ...(symbolHint ? { symbolHint } : {}),
    };
  }

  private async repositoryIdentity(root: string, signal: AbortSignal): Promise<RepositoryIdentity | undefined> {
    const cached = this.identities.get(root);
    if (cached) return cached;
    const repositories = await this.client.repositories(signal);
    const repository = repositories.find((candidate) => candidate.root === root && candidate.activeGeneration !== undefined);
    if (!repository || signal.aborted) return undefined;
    const commit = await headCommit(root, signal);
    const identity = identityFromRepository(repository, commit);
    this.identities.set(root, identity);
    return identity;
  }
}

function eligibleEditor(editor: vscode.TextEditor): boolean {
  return editor.document.languageId === "php"
    && editor.document.uri.scheme === "file"
    && Boolean(vscode.workspace.getWorkspaceFolder(editor.document.uri));
}

function identityFromRepository(repository: CompanionRepository, commit: string): RepositoryIdentity {
  return { repositoryId: repository.id, commit, generation: repository.activeGeneration ?? 0 };
}

async function headCommit(root: string, signal: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    signal,
  });
  return stdout.trim();
}
