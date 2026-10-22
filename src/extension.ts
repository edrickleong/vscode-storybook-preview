import * as vscode from 'vscode';
import { ControllerState, StoryController } from './controller';
import { StoryResolver } from './resolver';
import { StoryViewTarget } from './preview/storyView';
import { setMediaRoot } from './preview/webview';
import { StorybookClient } from './storybook';
import { StoryCodeLensProvider } from './views/codeLens';
import { StoriesTreeProvider, StoryItem } from './views/storiesTree';

export interface StoryVisualiserApi {
  readonly state: ControllerState;
  readonly controller: StoryController;
  readonly resolver: StoryResolver;
  readonly storiesView: StoriesTreeProvider;
}

export function activate(context: vscode.ExtensionContext): StoryVisualiserApi {
  setMediaRoot(vscode.Uri.joinPath(context.extensionUri, 'media'));
  const log = vscode.window.createOutputChannel('Story Visualiser', { log: true });
  const client = new StorybookClient();
  const resolver = new StoryResolver(client);
  const storyView = new StoryViewTarget();
  const controller = new StoryController(resolver, client, log, storyView);
  const codeLens = new StoryCodeLensProvider(resolver, controller, log);
  const storiesView = new StoriesTreeProvider(controller);
  const storyOf = (item?: StoryItem) => item?.story;

  context.subscriptions.push(
    log,
    resolver,
    controller,
    vscode.commands.registerCommand('storyVisualiser.showStory', (uri?: vscode.Uri) => controller.showStory(uri)),
    vscode.commands.registerCommand('storyVisualiser.pickStory', () => controller.pickStory()),
    codeLens,
    storiesView,
    vscode.window.registerWebviewViewProvider(StoryViewTarget.viewId, storyView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('storyVisualiser.useStoryView', () => controller.useStoryView()),
    vscode.commands.registerCommand('storyVisualiser.moveStoryView', () => controller.moveStoryView()),
    vscode.languages.registerCodeLensProvider(
      ['typescriptreact', 'javascriptreact', 'typescript', 'javascript', 'vue', 'svelte'].map((language) => ({ language, scheme: 'file' })),
      codeLens,
    ),
    vscode.commands.registerCommand('storyVisualiser.showStoryById', (id: string, file?: string) => controller.showStoryById(id, file)),
    vscode.commands.registerCommand('storyVisualiser.nextStory', () => controller.stepStory(1)),
    vscode.commands.registerCommand('storyVisualiser.previousStory', () => controller.stepStory(-1)),
    vscode.commands.registerCommand('storyVisualiser.toggleViewMode', () => controller.toggleViewMode()),
    vscode.commands.registerCommand('storyVisualiser.openStoryFile', (item?: StoryItem) => controller.openStoryFile(storyOf(item) ?? controller.state.story)),
    vscode.commands.registerCommand('storyVisualiser.openInExternalBrowser', (item?: StoryItem) =>
      controller.openInExternalBrowser(storyOf(item) ?? controller.state.story),
    ),
    vscode.commands.registerCommand('storyVisualiser.toggleAutoSync', () => controller.toggleAutoSync()),
    vscode.commands.registerCommand('storyVisualiser.startStorybook', () => controller.startStorybook()),
    vscode.commands.registerCommand('storyVisualiser.refreshIndex', () => controller.refreshIndex()),
  );

  return {
    get state() {
      return controller.state;
    },
    controller,
    resolver,
    storiesView,
  };
}

export function deactivate(): void {}
