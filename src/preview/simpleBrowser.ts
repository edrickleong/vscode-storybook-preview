import * as vscode from 'vscode';
import { PreviewTarget, ShowRequest } from './targets';

/** Shows stories in the built-in Simple Browser extension. */
export class SimpleBrowserTarget implements PreviewTarget {
  readonly id = 'simpleBrowser' as const;
  private open = false;
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose = this.closeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [this.closeEmitter];

  constructor() {
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (this.open && event.closed.some(isSimpleBrowserTab) && !this.findTab()) {
          this.open = false;
          this.closeEmitter.fire();
        }
      }),
    );
  }

  private findTab(): vscode.Tab | undefined {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs).find(isSimpleBrowserTab);
  }

  isOpen(): boolean {
    this.open = this.open && this.findTab() !== undefined;
    return this.open;
  }

  async show(request: ShowRequest): Promise<void> {
    const open = this.isOpen();
    if (!open && !request.reveal) return;
    await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(request.url), {
      viewColumn: open ? this.findTab()?.group.viewColumn ?? vscode.ViewColumn.Beside : vscode.ViewColumn.Beside,
      preserveFocus: request.preserveFocus,
    });
    this.open = true;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function isSimpleBrowserTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('simpleBrowser.view');
}
