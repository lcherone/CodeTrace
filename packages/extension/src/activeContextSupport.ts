import {
  PROTOCOL_VERSION,
  type EditorContextUpdateRequest,
  type RevisionIdentity,
  type SourceRange,
  type TraceMode,
} from "@trace/contracts";

export type PublicEditorPosition = {
  repositoryPath: string;
  repositoryId: string;
  relativePath: string;
  revision: Omit<RevisionIdentity, "repositoryId">;
  range: SourceRange;
  symbolHint?: string;
};

export type EditorThemeKind = "light" | "dark" | "high-contrast";

export function editorContextRequest(
  clientId: string,
  position: PublicEditorPosition | undefined,
  mode: TraceMode = "impact",
  theme?: EditorThemeKind,
): EditorContextUpdateRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientId,
    context: position ? {
      mode,
      ...(theme ? { theme } : {}),
      selection: {
        repositoryPath: position.repositoryPath,
        relativePath: position.relativePath,
        revision: { repositoryId: position.repositoryId, ...position.revision },
        range: position.range,
        ...(position.symbolHint ? { symbolHint: position.symbolHint } : {}),
      },
    } : null,
  };
}

const PHP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*(?:::[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Reduces editor text to a bounded symbol identity; arbitrary/source text is never published. */
export function phpSymbolHint(selectedText: string, documentText: string): string | undefined {
  const selected = selectedText.trim().replace(/^\\/, "");
  if (!selected || selected.length > 512 || !PHP_IDENTIFIER.test(selected)) return undefined;
  for (const match of documentText.matchAll(/^\s*use\s+(?:(?:function|const)\s+)?([^;{}]+);/gmi)) {
    const clause = match[1]?.trim();
    if (!clause) continue;
    const aliased = clause.match(/^([A-Za-z_][A-Za-z0-9_\\]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    const imported = (aliased?.[1] ?? clause).replace(/^\\/, "");
    const alias = aliased?.[2] ?? imported.split("\\").at(-1);
    if (alias?.toLocaleLowerCase() === selected.toLocaleLowerCase() && PHP_IDENTIFIER.test(imported)) return imported;
  }
  return selected;
}

export function editorThemeKind(colorThemeKind: number): EditorThemeKind {
  if (colorThemeKind === 1) return "light";
  if (colorThemeKind === 3 || colorThemeKind === 4) return "high-contrast";
  return "dark";
}

type ContextTask<T> = { delayMs: number; build(signal: AbortSignal): Promise<T> };

/** Coalesces cursor/editor changes and aborts stale resolution or network work. */
export class ActiveContextPublisher<T> {
  private enabled = true;
  private connected = false;
  private latest: ContextTask<T> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private controller: AbortController | undefined;
  private disposed = false;

  constructor(
    private readonly publish: (value: T, signal: AbortSignal) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  update(delayMs: number, build: (signal: AbortSignal) => Promise<T>): void {
    this.latest = { delayMs: Math.max(0, delayMs), build };
    this.schedule();
  }

  /** Publishes an explicit command context before its consumer is opened. */
  async publishNow(build: (signal: AbortSignal) => Promise<T>): Promise<void> {
    const task = { delayMs: 0, build };
    this.latest = task;
    this.cancel();
    if (this.disposed) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const value = await task.build(controller.signal);
      if (!controller.signal.aborted) await this.publish(value, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) this.onError(error);
      throw error;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) this.schedule();
    else this.cancel();
  }

  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    if (connected) this.schedule();
    else this.cancel();
  }

  dispose(): void {
    this.disposed = true;
    this.latest = undefined;
    this.cancel();
  }

  private schedule(): void {
    this.cancel();
    if (this.disposed || !this.enabled || !this.connected || !this.latest) return;
    const task = this.latest;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const controller = new AbortController();
      this.controller = controller;
      void task.build(controller.signal)
        .then((value) => controller.signal.aborted ? undefined : this.publish(value, controller.signal))
        .catch((error) => {
          if (!controller.signal.aborted) this.onError(error);
        })
        .finally(() => {
          if (this.controller === controller) this.controller = undefined;
        });
    }, task.delayMs);
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }
}
