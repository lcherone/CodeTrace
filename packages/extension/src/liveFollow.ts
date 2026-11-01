export class LiveFollowScheduler {
  private timer: NodeJS.Timeout | undefined;

  schedule(delayMs: number, task: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      task();
    }, delayMs);
  }

  cancel(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.cancel();
  }
}

export function canFollowEditor(input: {
  enabled: boolean;
  panelVisible: boolean;
  languageId: string;
  scheme: string;
  inWorkspace: boolean;
}): boolean {
  return input.enabled
    && input.panelVisible
    && input.languageId === "php"
    && input.scheme === "file"
    && input.inWorkspace;
}
