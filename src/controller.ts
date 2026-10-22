import * as path from 'path';
import * as vscode from 'vscode';
import { storyAtLine } from './core/csf';
import { detectStartCommand } from './core/startCommand';
import { StoryRef, findStorybookRoot, isStoriesFile, samePath, storyUrl } from './core/resolve';
import { IntegratedBrowserTarget } from './preview/integratedBrowser';
import { StoryViewTarget } from './preview/storyView';
import { SimpleBrowserTarget } from './preview/simpleBrowser';
import { PreviewTarget } from './preview/targets';
import { WebviewTarget } from './preview/webview';
import { Resolution, StoryResolver, nodeFs, storybookUrlFor } from './resolver';
import { StorybookClient } from './storybook';

type TargetSetting = 'auto' | 'integratedBrowser' | 'webview' | 'sidebar' | 'panel' | 'simpleBrowser' | 'external';

export interface ControllerState {
  file?: string;
  resolution?: Resolution;
  story?: StoryRef;
  /** URL most recently sent to the preview. */
  shownUrl?: string;
  targetId?: string;
  previewOpen: boolean;
  storybookRunning?: boolean;
  autoSync: boolean;
}

const config = () => vscode.workspace.getConfiguration('storyVisualiser');

/** Coordinates editors, story resolution and the preview surface. */
export class StoryController implements vscode.Disposable {
  private target: PreviewTarget | undefined;
  private targetDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
  private readonly lastStoryByFile = new Map<string, string>();
  private readonly log: vscode.LogOutputChannel;

  private current: { file?: string; resolution?: Resolution; story?: StoryRef } = {};
  private shownUrl: string | undefined;
  /** The file whose preview the user closed; auto-sync won't reopen until they switch files. */
  private suppressedFile: string | undefined;
  private offlineNotified = false;
  private storybookRunning: boolean | undefined;
  private sequence = 0;
  private selectionTimer: NodeJS.Timeout | undefined;
  /** The story export the cursor was last in (stories files only). */
  private cursorStoryId: string | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever the active file, its stories or the selected story change. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly resolver: StoryResolver,
    private readonly client: StorybookClient,
    log: vscode.LogOutputChannel,
    private readonly storyView: StoryViewTarget,
  ) {
    this.log = log;
    this.disposables.push(
      this.statusBar,
      this.changeEmitter,
      vscode.window.onDidChangeActiveTextEditor((editor) => void this.sync(editor, { explicit: false })),
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChanged(event)),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        // Closing the component itself lifts the "preview dismissed" suppression.
        const suppressed = this.suppressedFile;
        if (suppressed && !vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && samePath(t.input.uri.fsPath, suppressed)))) {
          this.suppressedFile = undefined;
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.current.file && /\.(stories|story)\./.test(doc.fileName)) {
          this.client.invalidate();
          void this.sync(vscode.window.activeTextEditor, { explicit: false });
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('storyVisualiser.previewTarget')) this.resetTarget();
        if (event.affectsConfiguration('storyVisualiser')) {
          this.client.invalidate();
          this.shownUrl = undefined;
          void this.sync(vscode.window.activeTextEditor, { explicit: false });
        }
      }),
    );
    void this.sync(vscode.window.activeTextEditor, { explicit: false });
  }

  get state(): ControllerState {
    return {
      ...this.current,
      shownUrl: this.shownUrl,
      targetId: this.target?.id,
      previewOpen: this.target?.isOpen() ?? false,
      storybookRunning: this.storybookRunning,
      autoSync: config().get('autoSync', true),
    };
  }

  /** The current preview surface (exposed for tests). */
  get preview(): PreviewTarget | undefined {
    return this.target;
  }

  /** Forget remembered story choices and dismissals. */
  resetMemory(): void {
    this.lastStoryByFile.clear();
    this.suppressedFile = undefined;
    this.current = {};
  }

  // ---------------------------------------------------------------------------
  // Commands

  async showStory(uri?: vscode.Uri): Promise<void> {
    if (uri && uri.toString() !== vscode.window.activeTextEditor?.document.uri.toString()) {
      await vscode.window.showTextDocument(uri, { preview: false });
    }
    this.suppressedFile = undefined;
    await this.sync(vscode.window.activeTextEditor, { explicit: true });
  }

  /**
   * Preview a specific story (from CodeLens, the Stories view or the webview picker).
   * `file` is the component/stories file the request came from, if not the active one.
   */
  async showStoryById(id: string, file?: string): Promise<void> {
    // An explicit choice wins over any editor sync still resolving.
    ++this.sequence;
    if (file && !samePath(file, this.current.file ?? '')) {
      const resolution = await this.resolver.resolve(file);
      if (!resolution) return;
      this.current = { file, resolution, story: resolution.stories.find((s) => s.id === id) };
    }
    this.suppressedFile = undefined;
    await this.selectStory(id, { explicit: true });
  }

  /** Move to the next (+1) or previous (-1) story of the current file, wrapping around. */
  async stepStory(delta: 1 | -1): Promise<void> {
    const { resolution, story } = this.current;
    if (!resolution?.stories.length) return;
    const index = resolution.stories.findIndex((s) => s.id === story?.id);
    const next = resolution.stories[(index + delta + resolution.stories.length) % resolution.stories.length];
    await this.showStoryById(next.id);
  }

  /** Switch previews to the Story view (from its "Preview stories here" button). */
  async useStoryView(): Promise<void> {
    await config().update('previewTarget', 'sidebar', vscode.ConfigurationTarget.Global);
    await this.showStory();
  }

  /** Move the Story view between the Primary/Secondary Side Bar and the Panel (VS Code's own picker). */
  async moveStoryView(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.moveFocusedView', StoryViewTarget.viewId);
  }

  async toggleViewMode(): Promise<void> {
    const next = config().get('viewMode', 'canvas') === 'canvas' ? 'storybook' : 'canvas';
    await config().update('viewMode', next, vscode.ConfigurationTarget.Global);
    void vscode.window.setStatusBarMessage(next === 'storybook' ? 'Showing the full Storybook UI' : 'Showing the story canvas only', 2500);
  }

  async pickStory(): Promise<void> {
    const { resolution, story } = this.current;
    if (!resolution) {
      void vscode.window.showInformationMessage('No stories found for the active file.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      resolution.stories.map((s) => ({
        label: s.name,
        description: s.title,
        detail: path.relative(path.dirname(resolution.file), s.storiesFile) || path.basename(s.storiesFile),
        picked: s.id === story?.id,
        story: s,
      })),
      { placeHolder: 'Select a story to preview' },
    );
    if (picked) await this.selectStory(picked.story.id, { explicit: true });
  }

  async openStoryFile(story: StoryRef | undefined = this.current.story): Promise<void> {
    if (!story) return;
    const position = new vscode.Position(story.line ?? 0, 0);
    const editor = vscode.window.visibleTextEditors.find((e) => samePath(e.document.uri.fsPath, this.current.file ?? ''));
    await vscode.window.showTextDocument(vscode.Uri.file(story.storiesFile), {
      viewColumn: editor?.viewColumn ?? vscode.ViewColumn.One,
      selection: new vscode.Range(position, position),
      preview: false,
    });
  }

  async openInExternalBrowser(story: StoryRef | undefined = this.current.story): Promise<void> {
    if (!story) return;
    const url = storyUrl(storybookUrlFor(story.storiesFile), story.id, 'storybook');
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async toggleAutoSync(): Promise<void> {
    const next = !config().get('autoSync', true);
    await config().update('autoSync', next, vscode.ConfigurationTarget.Global);
    void vscode.window.setStatusBarMessage(`Story auto-sync ${next ? 'on' : 'off'}`, 2500);
  }

  async refreshIndex(): Promise<void> {
    this.client.invalidate();
    this.shownUrl = undefined;
    await this.sync(vscode.window.activeTextEditor, { explicit: false });
  }

  async startStorybook(): Promise<void> {
    const file = this.current.file ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    const root = (file && findStorybookRoot(file, nodeFs)) ?? (await findAnyStorybookRoot());
    if (!root) {
      void vscode.window.showErrorMessage('Could not find a .storybook folder in this workspace.');
      return;
    }
    const baseUrl = storybookUrlFor(file ?? root);
    const command = config().get<string>('startCommand')?.trim() || detectStartCommand(root, baseUrl);
    const existing = vscode.window.terminals.find((t) => t.name === 'Storybook');
    const terminal = existing ?? vscode.window.createTerminal({ name: 'Storybook', cwd: root, iconPath: new vscode.ThemeIcon('book') });
    terminal.show(true);
    terminal.sendText(command);
    this.log.info(`Starting Storybook in ${root}: ${command}`);

    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting Storybook (${command})…`, cancellable: true },
      (_progress, token) => this.client.waitUntilRunning(baseUrl, 180_000, token),
    );
    if (started) {
      this.offlineNotified = false;
      await this.sync(vscode.window.activeTextEditor, { explicit: true });
    } else {
      void vscode.window.showWarningMessage(`Storybook did not respond at ${baseUrl}. Check the Storybook terminal.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Sync

  private async selectStory(id: string, options: { explicit: boolean }): Promise<void> {
    const { resolution } = this.current;
    const story = resolution?.stories.find((s) => s.id === id);
    if (!resolution || !story) return;
    this.remember(resolution, story);
    this.current.story = story;
    this.updateStatusBar();
    await this.present(resolution, story, options);
  }

  private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    const file = event.textEditor.document.uri.fsPath;
    if (event.textEditor !== vscode.window.activeTextEditor || !isStoriesFile(file)) return;
    clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      const { resolution } = this.current;
      // The stories file may still be resolving: re-sync so the cursor position is honoured.
      if (resolution?.kind !== 'stories' || !samePath(file, resolution.file)) {
        void this.sync(event.textEditor, { explicit: false });
        return;
      }
      // Only react when the cursor moves into a *different* export, so a story picked
      // elsewhere (dropdown, CodeLens, Stories view) isn't undone by a small cursor move.
      const story = this.storyForCursor(resolution, event.textEditor);
      if (story?.id === this.cursorStoryId) return;
      this.cursorStoryId = story?.id;
      if (story && story.id !== this.current.story?.id) void this.selectStory(story.id, { explicit: false });
    }, 200);
  }

  private storyForCursor(resolution: Resolution, editor: vscode.TextEditor | undefined): StoryRef | undefined {
    if (!editor || resolution.kind !== 'stories') return undefined;
    const withLines = resolution.stories.filter((s) => s.line !== undefined).map((s) => ({ exportName: s.exportName, line: s.line! }));
    const match = storyAtLine(withLines, editor.selection.active.line);
    return match && resolution.stories.find((s) => s.exportName === match.exportName);
  }

  /** Remember the choice for both the file being edited and the stories file it lives in. */
  private remember(resolution: Resolution, story: StoryRef): void {
    this.lastStoryByFile.set(resolution.file, story.id);
    this.lastStoryByFile.set(story.storiesFile, story.id);
  }

  private chooseStory(resolution: Resolution, editor: vscode.TextEditor): StoryRef {
    const remembered = [resolution.file, ...resolution.stories.map((s) => s.storiesFile)]
      .map((key) => this.lastStoryByFile.get(key))
      .find((id) => id !== undefined && resolution.stories.some((s) => s.id === id));
    return (
      this.storyForCursor(resolution, editor) ??
      resolution.stories.find((s) => s.id === remembered) ??
      // Keep showing the same story when hopping between a component and its stories file.
      resolution.stories.find((s) => s.id === this.current.story?.id) ??
      resolution.stories[0]
    );
  }

  async sync(editor: vscode.TextEditor | undefined, options: { explicit: boolean }): Promise<void> {
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const file = editor.document.uri.fsPath;
    if (!this.resolver.isRelevantFile(file)) return;
    const seq = ++this.sequence;

    const resolution = await this.resolver.resolve(file);
    if (seq !== this.sequence) return; // A newer editor change superseded this one.
    await vscode.commands.executeCommand('setContext', 'storyVisualiser.activeHasStory', !!resolution);

    if (!resolution) {
      this.current = { file };
      this.updateStatusBar();
      if (options.explicit) {
        void vscode.window.showInformationMessage(`No story found for ${path.basename(file)}.`);
      }
      this.target?.showMessage?.(`No story found for ${path.basename(file)}.`);
      return;
    }

    const story = this.chooseStory(resolution, editor);
    this.cursorStoryId = this.storyForCursor(resolution, editor)?.id;
    if (this.storyForCursor(resolution, editor)) this.remember(resolution, story);
    if (this.current.file && !samePath(this.current.file, file) && this.suppressedFile && !samePath(this.suppressedFile, file)) {
      this.suppressedFile = undefined;
    }
    this.current = { file, resolution, story };
    this.updateStatusBar();
    await this.present(resolution, story, options);
  }

  private presentChain: Promise<void> = Promise.resolve();

  /** Previews are applied one at a time so overlapping syncs can't open two tabs. */
  private present(resolution: Resolution, story: StoryRef, options: { explicit: boolean }): Promise<void> {
    const run = this.presentChain.then(() => {
      // Superseded by a newer selection while waiting.
      if (this.current.story?.id !== story.id || this.current.resolution !== resolution) return;
      // Auto-sync only follows files that are still on screen.
      const visible = vscode.window.visibleTextEditors.some((e) => samePath(e.document.uri.fsPath, resolution.file));
      if (!options.explicit && !visible) return;
      return this.presentNow(resolution, story, options);
    });
    this.presentChain = run.catch((error) => this.log.error(error));
    return run;
  }

  private async presentNow(resolution: Resolution, story: StoryRef, options: { explicit: boolean }): Promise<void> {
    const autoSync = config().get('autoSync', true);
    if (!options.explicit && !autoSync) return;

    const baseUrl = storybookUrlFor(story.storiesFile);
    this.storybookRunning = await this.client.isRunning(baseUrl);
    this.updateStatusBar();
    if (!this.storybookRunning) {
      this.target?.showMessage?.(`Storybook isn't running at ${baseUrl}.`, [{ label: 'Start Storybook', command: 'storyVisualiser.startStorybook' }]);
      if (options.explicit || !this.offlineNotified) {
        this.offlineNotified = true;
        // Not awaited: previews are queued, and the prompt may sit unanswered.
        void vscode.window
          .showWarningMessage(
            `Storybook isn't running at ${baseUrl}. Start it to preview ${story.title} › ${story.name}?`,
            'Start Storybook',
            'Settings',
          )
          .then((choice) => {
            if (choice === 'Start Storybook') return this.startStorybook();
            if (choice === 'Settings') return vscode.commands.executeCommand('workbench.action.openSettings', 'storyVisualiser');
          });
      }
      return;
    }

    const target = await this.getTarget();
    const viewMode = config().get<'canvas' | 'storybook'>('viewMode', 'canvas');
    const url = storyUrl(baseUrl, story.id, viewMode);

    if (!target) {
      // External browser: only open on explicit request, never on every editor switch.
      if (options.explicit) await vscode.env.openExternal(vscode.Uri.parse(url));
      this.shownUrl = url;
      return;
    }

    const open = target.isOpen();
    if (open && url === this.shownUrl && !options.explicit) return;
    const suppressed = this.suppressedFile !== undefined && samePath(this.suppressedFile, resolution.file);
    const reveal = options.explicit || (!open && !suppressed);
    if (!open && !reveal) return;

    this.log.info(`Showing ${story.id} (${target.id}) for ${resolution.file}`);
    await target.show({ url, story, stories: resolution.stories, reveal, preserveFocus: true, explicit: options.explicit });
    this.shownUrl = url;
    this.updateStatusBar();
  }

  // ---------------------------------------------------------------------------
  // Preview target lifecycle

  private async getTarget(): Promise<PreviewTarget | undefined> {
    if (this.target) return this.target;
    const setting = config().get<TargetSetting>('previewTarget', 'auto');
    let target: PreviewTarget | undefined;
    if (setting === 'external') return undefined;
    if (setting === 'webview') target = new WebviewTarget();
    else if (setting === 'sidebar' || setting === 'panel') {
      // 'panel' is the 0.1 name for the same view (it used to live in the bottom panel).
      target = this.storyView;
      this.storyView.active = true;
    }
    else if (setting === 'simpleBrowser') target = new SimpleBrowserTarget();
    else if (await IntegratedBrowserTarget.isAvailable()) target = new IntegratedBrowserTarget();
    else {
      if (setting === 'integratedBrowser') {
        void vscode.window.showWarningMessage('The integrated browser is not available in this version of VS Code; using a webview instead.');
      }
      target = new WebviewTarget();
    }

    this.target = target;
    this.targetDisposables = [
      target,
      target.onDidClose(() => {
        this.shownUrl = undefined;
        // Only treat it as "not for this component" if the user closed just the preview.
        const file = this.current.file;
        const stillEditing = file && vscode.window.visibleTextEditors.some((e) => samePath(e.document.uri.fsPath, file));
        this.suppressedFile = stillEditing ? file : undefined;
        this.updateStatusBar();
      }),
    ];
    if (target.onDidSelectStory) this.targetDisposables.push(target.onDidSelectStory((id) => void this.selectStory(id, { explicit: false })));
    if (target.onDidRequestCommand) this.targetDisposables.push(target.onDidRequestCommand((command) => void vscode.commands.executeCommand(command)));
    return target;
  }

  private resetTarget(): void {
    this.targetDisposables.forEach((d) => d.dispose());
    this.targetDisposables = [];
    this.target = undefined;
    this.shownUrl = undefined;
  }

  private updateStatusBar(): void {
    this.changeEmitter.fire();
    const { resolution, story } = this.current;
    if (!resolution || !story) {
      this.statusBar.hide();
      return;
    }
    const autoSync = config().get('autoSync', true);
    if (this.storybookRunning === false) {
      this.statusBar.text = '$(debug-disconnect) Storybook offline';
      this.statusBar.tooltip = 'Storybook is not running. Click to start it.';
      this.statusBar.command = 'storyVisualiser.startStorybook';
    } else {
      this.statusBar.text = `${autoSync ? '$(sync)' : '$(book)'} ${story.name}`;
      const tooltip = new vscode.MarkdownString(
        `**${story.title} › ${story.name}**\n\n${resolution.stories.length} stor${resolution.stories.length === 1 ? 'y' : 'ies'} · ` +
          `auto-sync ${autoSync ? 'on' : 'off'} · from ${resolution.source === 'index' ? 'Storybook index' : 'source'}\n\n` +
          `[Pick story](command:storyVisualiser.pickStory) · [Toggle auto-sync](command:storyVisualiser.toggleAutoSync)`,
      );
      tooltip.isTrusted = true;
      this.statusBar.tooltip = tooltip;
      this.statusBar.command = 'storyVisualiser.pickStory';
    }
    this.statusBar.show();
  }

  dispose(): void {
    clearTimeout(this.selectionTimer);
    this.resetTarget();
    this.disposables.forEach((d) => d.dispose());
  }
}

async function findAnyStorybookRoot(): Promise<string | undefined> {
  const [main] = await vscode.workspace.findFiles('**/.storybook/main.{ts,js,mjs,cjs,mts,cts}', '**/node_modules/**', 1);
  return main ? path.dirname(path.dirname(main.fsPath)) : undefined;
}
