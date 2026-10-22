import * as vscode from 'vscode';
import { PreviewTarget, ShowRequest, restoreEditorFocus } from './targets';
import { Inbound, renderPreviewHtml, storyMessage, webviewOptions } from './webview';

/**
 * Shows stories in a webview *view*: its own container in the Primary Side Bar by default,
 * movable to the Secondary Side Bar or the Panel ("Move Story Preview…"). It stays out of
 * the editor groups entirely. Same toolbar and story picker as the webview editor target.
 *
 * Because the view shares its location with other views (e.g. the Explorer), auto-sync
 * only reveals it the first time; after that it updates in place, and hiding it is not a
 * dismissal. Explicit requests (Show Story, CodeLens, …) always reveal it.
 */
export class StoryViewTarget implements PreviewTarget, vscode.WebviewViewProvider {
  readonly id = 'sidebar' as const;
  static readonly viewId = 'storyVisualiser.storyView';

  private view: vscode.WebviewView | undefined;
  private resolved: Promise<vscode.WebviewView>;
  private resolveView!: (view: vscode.WebviewView) => void;
  private lastState: object | undefined;
  /** Whether this surface is the configured preview target (vs. merely registered). */
  active = false;
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly selectEmitter = new vscode.EventEmitter<string>();
  private readonly commandEmitter = new vscode.EventEmitter<string>();
  readonly onDidClose = this.closeEmitter.event;
  readonly onDidSelectStory = this.selectEmitter.event;
  readonly onDidRequestCommand = this.commandEmitter.event;

  constructor() {
    this.resolved = new Promise((resolve) => (this.resolveView = resolve));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions();
    view.webview.html = renderPreviewHtml(view.webview, 'http://localhost:6006');
    view.webview.onDidReceiveMessage((message: Inbound) => {
      if (message.type === 'selectStory') this.selectEmitter.fire(message.id);
      else if (message.type === 'command') this.commandEmitter.fire(message.command);
      else if (message.type === 'ready') this.replay();
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.replay();
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.resolved = new Promise((resolve) => (this.resolveView = resolve));
      if (this.active) this.closeEmitter.fire();
    });
    this.resolveView(view);
  }

  private replay(): void {
    const state = this.lastState ?? (this.active ? undefined : inactiveMessage);
    if (state) void this.view?.webview.postMessage(state);
  }

  /** Open once created, even while hidden: it keeps updating in the background. */
  isOpen(): boolean {
    return this.view !== undefined;
  }

  /** Whether the view is currently on screen. */
  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  async show(request: ShowRequest): Promise<void> {
    const message = await storyMessage(request);
    if (!this.view) {
      if (!request.reveal) {
        this.lastState = message; // Shown when the user opens the view.
        return;
      }
      const editor = vscode.window.activeTextEditor;
      // Not created yet: focusing the view creates and reveals it.
      await vscode.commands.executeCommand(`${StoryViewTarget.viewId}.focus`);
      await this.resolved;
      if (request.preserveFocus) await restoreEditorFocus(editor);
    } else if (!this.view.visible && request.explicit) {
      this.view.show(request.preserveFocus);
    }
    this.post(message);
  }

  showMessage(message: string, actions: { label: string; command: string }[] = []): void {
    this.post({ type: 'message', message, actions });
  }

  /** For tests: the last state sent to the view. */
  get state(): object | undefined {
    return this.lastState;
  }

  private post(message: object): void {
    this.lastState = message;
    void this.view?.webview.postMessage(message);
  }

  /** Called when another target takes over; the view itself stays registered. */
  dispose(): void {
    this.active = false;
    this.lastState = undefined;
    this.replay();
  }
}

const inactiveMessage = {
  type: 'message',
  message: 'Stories are currently previewing elsewhere.',
  actions: [{ label: 'Preview stories here', command: 'storyVisualiser.useStoryView' }],
};
