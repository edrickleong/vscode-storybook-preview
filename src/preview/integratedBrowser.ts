import * as vscode from 'vscode';
import { PreviewTarget, ShowRequest, restoreEditorFocus } from './targets';

export const INTEGRATED_BROWSER_OPEN = 'workbench.action.browser.open';

/**
 * Shows stories in VS Code's integrated browser (a real Chromium tab with DevTools).
 *
 * `workbench.action.browser.open` accepts `{ url, openToSide, reuseUrlFilter }`; the
 * filter makes VS Code navigate the existing Storybook tab instead of opening a new one.
 */
export class IntegratedBrowserTarget implements PreviewTarget {
  readonly id = 'integratedBrowser' as const;
  private tab: vscode.Tab | undefined;
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose = this.closeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [this.closeEmitter];

  constructor() {
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (this.tab && event.closed.includes(this.tab)) {
          this.tab = undefined;
          this.closeEmitter.fire();
        }
      }),
    );
  }

  static async isAvailable(): Promise<boolean> {
    return (await vscode.commands.getCommands(true)).includes(INTEGRATED_BROWSER_OPEN);
  }

  isOpen(): boolean {
    if (!this.tab) return false;
    const stillThere = vscode.window.tabGroups.all.some((group) => group.tabs.includes(this.tab!));
    if (!stillThere) this.tab = undefined;
    return stillThere;
  }

  async show(request: ShowRequest): Promise<void> {
    const open = this.isOpen();
    if (!open && !request.reveal) return;
    const editor = vscode.window.activeTextEditor;

    const tracker = this.trackBrowserTab();
    await vscode.commands.executeCommand(INTEGRATED_BROWSER_OPEN, {
      url: markPreviewUrl(request.url),
      // Side-opened browser tabs share VS Code's dedicated, locked "browser side group",
      // so a new tab (first open, or after the user navigated ours away) never lands on the code.
      openToSide: true,
      // Only ever reuse a tab we opened: the marker keeps the user's own browser tabs —
      // including their own Storybook tabs — untouched.
      reuseUrlFilter: previewReuseFilter(request.url),
    });
    this.tab = (await tracker.settle()) ?? this.tab;

    if (request.preserveFocus) {
      // A freshly created browser view takes focus a moment after the command resolves;
      // wait for that, then hand focus back once (unless the user has moved on).
      if (!open) await this.waitForBrowserFocus(700);
      if (!vscode.window.activeTextEditor) await restoreEditorFocus(editor);
    }
  }

  private async waitForBrowserFocus(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && vscode.window.tabGroups.activeTabGroup.activeTab !== this.tab) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Watches for the browser tab the open command uses: a newly opened one, or the
   * reused one (which VS Code activates in its group). Call `settle()` after the command.
   */
  private trackBrowserTab(): { settle(): Promise<vscode.Tab | undefined> } {
    let opened: vscode.Tab | undefined;
    const listener = vscode.window.tabGroups.onDidChangeTabs((event) => {
      opened ??= event.opened.find((t) => t.input === undefined);
    });
    return {
      settle: async () => {
        // Tab events can trail the command slightly.
        await new Promise((resolve) => setTimeout(resolve, 250));
        listener.dispose();
        // On reuse VS Code focuses the reused tab's group, so the focused group's tab is ours.
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        return opened ?? (active?.input === undefined ? active : undefined);
      },
    };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

export const PREVIEW_MARKER = 'storyVisualiser';

/** Adds a query marker identifying tabs opened by this extension. */
export function markPreviewUrl(url: string): string {
  const marked = new URL(url);
  marked.searchParams.set(PREVIEW_MARKER, 'preview');
  // Keep `?path=/story/…` readable (URLSearchParams would encode the slashes).
  return marked.toString().replace(/path=%2Fstory%2F/, 'path=/story/');
}

/** Glob filter matching our marked tabs in either view mode (canvas or full UI). */
export function previewReuseFilter(url: string): string {
  const { origin } = new URL(url);
  return `${origin}/{,iframe.html}?${PREVIEW_MARKER}=preview`;
}
