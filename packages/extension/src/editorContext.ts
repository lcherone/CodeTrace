import type { Selection } from "@trace/contracts";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export async function createSelection(editor: vscode.TextEditor): Promise<Selection> {
  if (editor.document.languageId !== "php") throw new Error("Trace currently supports PHP documents.");
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder || editor.document.uri.scheme !== "file") throw new Error("Open the PHP file inside a local workspace folder before tracing.");
  // `git -C` requires a directory. The active document URI is a file path,
  // which only surfaced in a real Extension Development Host because unit
  // fixtures call the lower-level client directly.
  const repositoryPath = await git(dirname(editor.document.uri.fsPath), ["rev-parse", "--show-toplevel"]);
  const commit = await git(repositoryPath, ["rev-parse", "HEAD"]);
  const branchOutput = await git(repositoryPath, ["branch", "--show-current"]);
  const dirtyOutput = await git(repositoryPath, ["status", "--porcelain", "--", editor.document.uri.fsPath]);
  const selection = editor.selection.isEmpty
    ? editor.document.getWordRangeAtPosition(editor.selection.active) ?? new vscode.Range(editor.selection.active, editor.selection.active)
    : editor.selection;
  const normalizedRoot = await realpath(repositoryPath);
  const normalizedFile = await realpath(editor.document.uri.fsPath);
  const relativePath = relative(normalizedRoot, normalizedFile).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || relativePath === "..") throw new Error("The active file is outside the containing Git repository.");
  return {
    repositoryPath: normalizedRoot,
    relativePath,
    revision: {
      repositoryId: normalizedRoot,
      commit,
      ...(branchOutput ? { branch: branchOutput } : {}),
      dirty: Boolean(dirtyOutput) || editor.document.isDirty,
    },
    range: {
      startLine: selection.start.line + 1,
      startColumn: selection.start.character,
      endLine: selection.end.line + 1,
      endColumn: selection.end.character,
    },
    selectedText: editor.document.getText(selection),
    ...(editor.document.isDirty ? { documentText: editor.document.getText(), documentVersion: editor.document.version } : {}),
  };
}

async function git(cwdOrPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwdOrPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

export class OverlayInvalidator implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly emitter = new vscode.EventEmitter<vscode.TextDocument>();
  readonly onDidInvalidate = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(delayMs = 250) {
    this.subscription = vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document.languageId !== "php") return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.emitter.fire(document), delayMs);
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
