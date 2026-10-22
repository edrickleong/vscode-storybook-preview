import * as path from 'path';
import * as vscode from 'vscode';
import { componentDeclarationLine } from '../core/csf';
import { samePath } from '../core/resolve';
import type { StoryController } from '../controller';
import type { StoryResolver } from '../resolver';

/**
 * Shows a row of story lenses above the component declaration
 * (`👁 Primary  ▷ Secondary  ▷ Danger Large`) and a "Preview" lens above each
 * story export in stories files. Clicking one previews that story.
 */
export class StoryCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [this.changeEmitter];
  private lastStoryId: string | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly resolver: StoryResolver,
    private readonly controller: StoryController,
    private readonly log?: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      controller.onDidChange(() => {
        const id = controller.state.story?.id;
        if (id !== this.lastStoryId) this.log?.trace(`CodeLens refresh: ${this.lastStoryId} → ${id}`);
        this.lastStoryId = id;
        // Debounced; plus a follow-up, as VS Code can drop a refresh that lands right after a lens request.
        clearTimeout(this.refreshTimer);
        clearTimeout(this.retryTimer);
        this.refreshTimer = setTimeout(() => this.changeEmitter.fire(), 50);
        this.retryTimer = setTimeout(() => this.changeEmitter.fire(), 750);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('storyVisualiser.codeLens')) this.changeEmitter.fire();
      }),
    );
  }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    if (document.uri.scheme !== 'file' || !vscode.workspace.getConfiguration('storyVisualiser').get('codeLens', true)) return [];
    const resolution = await this.resolver.resolve(document.uri.fsPath);
    if (!resolution || token.isCancellationRequested) return [];

    const state = this.controller.state;
    this.log?.trace(`CodeLens provide for ${path.basename(document.uri.fsPath)} (current ${state.story?.id})`);
    const currentId = state.file && samePath(state.file, document.uri.fsPath) ? state.story?.id : undefined;
    const file = document.uri.fsPath;

    if (resolution.kind === 'stories') {
      return resolution.stories
        .filter((story) => story.line !== undefined)
        .map((story) => {
          const range = new vscode.Range(story.line!, 0, story.line!, 0);
          const current = story.id === currentId;
          return new vscode.CodeLens(range, {
            title: current ? '$(eye) Previewing' : '$(play) Preview',
            tooltip: `Preview ${story.title} › ${story.name}`,
            command: 'storyVisualiser.showStoryById',
            arguments: [story.id, file],
          });
        });
    }

    const base = path.basename(file, path.extname(file));
    const names = [base === 'index' ? path.basename(path.dirname(file)) : base, ...resolution.stories.map((s) => s.title.split('/').pop()!.replace(/\s+/g, ''))];
    const line = componentDeclarationLine(document.getText(), names);
    const range = new vscode.Range(line, 0, line, 0);

    return resolution.stories.map(
      (story) =>
        new vscode.CodeLens(range, {
          title: `${story.id === currentId ? '$(eye)' : '$(play)'} ${story.name}`,
          tooltip: `${story.id === currentId ? 'Previewing' : 'Preview'} ${story.title} › ${story.name}`,
          command: 'storyVisualiser.showStoryById',
          arguments: [story.id, file],
        }),
    );
  }

  dispose(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.refreshTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}
