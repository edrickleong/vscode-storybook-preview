import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import type { StoryVisualiserApi } from '../../../src/extension';

const sample = path.resolve(__dirname, '../../../../sample');
const file = (rel: string) => path.join(sample, rel);
const BUTTON = file('src/components/Button/Button.tsx');
const BUTTON_STORIES = file('src/components/Button/Button.stories.tsx');
const CARD = file('src/components/Card/Card.tsx');
const BADGE = file('src/components/Badge/index.tsx');
const AVATAR = file('src/components/Avatar/Avatar.tsx');
const DIVIDER = file('src/components/Divider.tsx');

let api: StoryVisualiserApi;
/** The sample's own Storybook port (6006 is left free for your real projects). */
const SB = 'http://localhost:6106';

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. State: ${JSON.stringify(summary())}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function summary() {
  const s = api?.state;
  return s && { file: s.file && path.basename(s.file), story: s.story?.id, shownUrl: s.shownUrl, target: s.targetId, open: s.previewOpen, running: s.storybookRunning };
}

/** Integrated browser tabs have no typed input in the extension API. */
function browserTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input === undefined);
}

async function open(fsPath: string, line?: number): Promise<vscode.TextEditor> {
  const selection = line === undefined ? undefined : new vscode.Range(line, 0, line, 0);
  return vscode.window.showTextDocument(vscode.Uri.file(fsPath), { viewColumn: vscode.ViewColumn.One, preview: false, selection });
}

async function configure(values: Record<string, unknown>): Promise<void> {
  const config = vscode.workspace.getConfiguration('storyVisualiser');
  for (const [key, value] of Object.entries(values)) {
    // storybookUrl is set in sample/.vscode/settings.json, so override it at that level.
    const target = key === 'storybookUrl' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update(key, key === 'storybookUrl' && value === undefined ? SB : value, target);
  }
  await sleep(300);
}

async function closeAll(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closeAllGroups');
  await sleep(300);
}

const shownId = () => /id=([^&]+)/.exec(api.state.shownUrl ?? '')?.[1];

describe('Component Story Visualiser', function () {
  this.timeout(60000);

  before(async () => {
    const ext = vscode.extensions.getExtension<StoryVisualiserApi>('edrickleong.component-story-visualiser');
    assert.ok(ext, 'extension is installed');
    api = await ext.activate();
    const index = await fetch(`${SB}/index.json`).then((r) => r.json() as Promise<{ entries: object }>, () => undefined);
    assert.ok(index && 'design-system-button--primary' in index.entries, `the sample Storybook must be running on ${SB} (npm run storybook in sample/)`);
  });

  afterEach(async () => {
    await configure({ previewTarget: undefined, autoSync: undefined, storybookUrl: undefined, viewMode: undefined, codeLens: undefined });
    await closeAll();
    api.controller.resetMemory();
  });

  describe('resolution', () => {
    it('resolves components to stories via the Storybook index', async () => {
      const button = await api.resolver.resolve(BUTTON);
      assert.strictEqual(button?.source, 'index');
      assert.deepStrictEqual(button?.stories.map((s) => s.id), [
        'design-system-button--primary',
        'design-system-button--secondary',
        'design-system-button--danger-large',
      ]);
      assert.strictEqual((await api.resolver.resolve(BADGE))?.stories[0].id, 'design-system-badge--info');
      assert.strictEqual((await api.resolver.resolve(AVATAR))?.stories[0].id, 'people-avatar--small');
      assert.strictEqual(await api.resolver.resolve(DIVIDER), undefined);
    });

    it('falls back to parsing source when Storybook is not running', async () => {
      await configure({ storybookUrl: 'http://localhost:6999', autoSync: false });
      const card = await api.resolver.resolve(CARD);
      assert.strictEqual(card?.source, 'source');
      assert.deepStrictEqual(card?.stories.map((s) => s.id), ['components-card--default', 'components-card--long-content']);
      const avatar = await api.resolver.resolve(AVATAR);
      assert.strictEqual(avatar?.source, 'source', 'found via the import in src/stories/UserAvatar.stories.tsx');
      assert.deepStrictEqual(avatar?.stories.map((s) => s.id), ['people-avatar--small', 'people-avatar--large']);
    });
  });

  describe('integrated browser (auto sync)', () => {
    it('opens the story beside the component automatically and keeps focus in the editor', async () => {
      await open(BUTTON);
      await waitFor('preview to open', () => api.state.previewOpen && shownId() === 'design-system-button--primary');
      assert.strictEqual(api.state.targetId, 'integratedBrowser');
      assert.strictEqual(api.state.shownUrl, `${SB}/iframe.html?id=design-system-button--primary&viewMode=story`);

      const tabs = browserTabs();
      assert.strictEqual(tabs.length, 1, 'exactly one browser tab');
      assert.notStrictEqual(tabs[0].group.viewColumn, vscode.ViewColumn.One, 'browser opens beside the editor');
      await waitFor('focus back in editor', () => vscode.window.activeTextEditor?.document.uri.fsPath === BUTTON);
    });

    it('swaps the story in the same tab when switching components', async () => {
      await open(BUTTON);
      await waitFor('button story', () => shownId() === 'design-system-button--primary');
      await open(CARD);
      await waitFor('card story', () => shownId() === 'components-card--default');
      await open(BADGE);
      await waitFor('badge story', () => shownId() === 'design-system-badge--info');
      await open(AVATAR);
      await waitFor('avatar story', () => shownId() === 'people-avatar--small');
      await sleep(500);
      assert.strictEqual(browserTabs().length, 1, 'the same browser tab is reused');
    });

    it('keeps the preview on the last story for files without one', async () => {
      await open(CARD);
      await waitFor('card story', () => shownId() === 'components-card--default');
      await open(DIVIDER);
      await sleep(800);
      assert.strictEqual(shownId(), 'components-card--default');
      const hasStory = await vscode.commands.executeCommand('getContext', 'storyVisualiser.activeHasStory').then(
        (v) => v,
        () => undefined,
      );
      if (hasStory !== undefined) assert.strictEqual(hasStory, false);
    });

    it('follows the cursor between stories in a stories file', async () => {
      const editor = await open(BUTTON_STORIES);
      await waitFor('first story', () => api.state.story?.exportName === 'Primary');
      const text = editor.document.getText().split('\n');
      const line = text.findIndex((l) => l.includes('export const DangerLarge'));
      editor.selection = new vscode.Selection(line + 0, 5, line + 0, 5);
      await waitFor('danger story', () => shownId() === 'design-system-button--danger-large');
      // Remembered when returning to the component.
      await open(CARD);
      await waitFor('card', () => shownId() === 'components-card--default');
      await open(BUTTON);
      await waitFor('remembered danger story', () => shownId() === 'design-system-button--danger-large');
    });

    it('does not reopen after the user closes it until they switch component', async () => {
      await open(BUTTON);
      await waitFor('preview', () => api.state.previewOpen);
      const tab = browserTabs()[0];
      await vscode.window.tabGroups.close(tab);
      await waitFor('closed', () => !api.state.previewOpen);

      await open(BUTTON);
      await sleep(1000);
      assert.strictEqual(api.state.previewOpen, false, 'not reopened for the same component');

      await open(CARD);
      await waitFor('reopened for a different component', () => api.state.previewOpen && shownId() === 'components-card--default');
    });

    it('Show Story command opens the preview when auto sync is off', async () => {
      await configure({ autoSync: false });
      await open(BUTTON);
      await sleep(800);
      assert.strictEqual(api.state.previewOpen, false);
      await vscode.commands.executeCommand('storyVisualiser.showStory');
      await waitFor('preview', () => api.state.previewOpen && shownId() === 'design-system-button--primary');
      // Without auto sync, switching files leaves the preview alone.
      await open(CARD);
      await sleep(800);
      assert.strictEqual(shownId(), 'design-system-button--primary');
    });

    it('can show the full Storybook UI', async () => {
      await configure({ viewMode: 'storybook' });
      await open(CARD);
      await waitFor('manager url', () => api.state.shownUrl === `${SB}/?path=/story/components-card--default`);
    });
  });

  describe('coexisting with your own integrated browser tabs', () => {
    let server: http.Server;
    const APP = 'http://localhost:3999/';
    const openBrowser = (url: string, extra: object = {}) => vscode.commands.executeCommand('workbench.action.browser.open', { url, ...extra });
    const labels = () => browserTabs().map((t) => t.label);

    before(async () => {
      server = http.createServer((_req, res) => res.end('<!doctype html><title>My App</title><h1>My app under test</h1>'));
      await new Promise<void>((resolve) => server.listen(3999, resolve));
    });
    after(() => server.close());

    it('never navigates your own tabs, even your own Storybook tab', async () => {
      await open(BUTTON);
      await openBrowser(APP); // Your app, in the active group (VS Code's default placement).
      await openBrowser(`${SB}/iframe.html?id=design-system-badge--success&viewMode=story`);
      await waitFor('your tabs to load', () => labels().includes('My App') && labels().some((l) => l.includes('badge--success')), 15000);

      await open(BUTTON);
      await waitFor('button story', () => api.state.previewOpen && shownId() === 'design-system-button--primary');
      await open(CARD);
      await waitFor('card story', () => shownId() === 'components-card--default');
      await waitFor('our tab title', () => labels().some((l) => l.includes('components-card--default')), 15000);
      await sleep(500);

      assert.strictEqual(browserTabs().length, 3, `tabs: ${labels()}`);
      assert.ok(labels().includes('My App'), 'your app tab untouched');
      assert.ok(labels().some((l) => l.includes('badge--success')), 'your Storybook tab untouched');
      const ours = browserTabs().find((t) => t.label.includes('components-card--default'))!;
      const yours = browserTabs().find((t) => t.label === 'My App')!;
      assert.notStrictEqual(ours.group, yours.group, 'the preview lives in its own side group');
      assert.strictEqual(ours.group.viewColumn, vscode.ViewColumn.Two);
    });

    it('opens a fresh preview beside the code if you navigate the preview tab elsewhere', async () => {
      await open(BUTTON);
      await waitFor('button story', () => api.state.previewOpen && shownId() === 'design-system-button--primary');
      const previewGroup = browserTabs()[0].group;
      // You use the preview tab to go look at something else.
      await openBrowser(`${APP}?away`, { reuseUrlFilter: `${SB}/**` });
      await waitFor('navigated away', () => labels().includes('My App'), 15000);

      await open(CARD);

      await waitFor('card story', () => shownId() === 'components-card--default');
      await waitFor('new preview tab', () => browserTabs().length === 2);
      assert.ok(labels().includes('My App'), 'your navigated tab is left alone');
      assert.ok(browserTabs().every((t) => t.group === previewGroup), 'the new preview joins the browser side group, not the code group');
      assert.strictEqual(vscode.window.tabGroups.all.find((g) => g.viewColumn === vscode.ViewColumn.One)?.tabs.some((t) => t.input === undefined), false);
    });

    it('reuses the same tab when switching between canvas and full Storybook UI', async () => {
      await open(CARD);
      await waitFor('card canvas', () => shownId() === 'components-card--default');
      await vscode.commands.executeCommand('storyVisualiser.toggleViewMode');
      await waitFor('manager url', () => api.state.shownUrl?.includes('?path=/story/components-card--default'));
      await open(BUTTON);
      await waitFor('button in manager', () => api.state.shownUrl?.includes('?path=/story/design-system-button--primary'));
      await sleep(500);
      assert.strictEqual(browserTabs().length, 1, `tabs: ${labels()}`);
    });
  });

  describe('picking a story in the preview', () => {
    /** What the preview's dropdown does (webview and Story view). */
    const pickInPreview = (id: string) => (api.controller as unknown as { selectStory(id: string, o: { explicit: boolean }): Promise<void> }).selectStory(id, { explicit: false });

    it('never moves your cursor or focus, even with the stories file open', async () => {
      const editor = await open(BUTTON_STORIES, 0);
      const primaryLine = editor.document.getText().split('\n').findIndex((l) => l.includes('export const Primary'));
      editor.selection = new vscode.Selection(primaryLine, 3, primaryLine, 3);
      await waitFor('primary', () => shownId() === 'design-system-button--primary');

      await pickInPreview('design-system-button--danger-large');
      await waitFor('danger shown', () => shownId() === 'design-system-button--danger-large');
      await sleep(500);
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, BUTTON_STORIES, 'still in the same editor');
      assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, primaryLine, 'cursor did not jump to the picked story');
    });

    it('a small cursor move inside the same export does not undo your pick', async () => {
      const editor = await open(BUTTON_STORIES, 0);
      const primaryLine = editor.document.getText().split('\n').findIndex((l) => l.includes('export const Primary'));
      editor.selection = new vscode.Selection(primaryLine, 3, primaryLine, 3);
      await waitFor('primary', () => shownId() === 'design-system-button--primary');
      await pickInPreview('design-system-button--secondary');
      await waitFor('secondary shown', () => shownId() === 'design-system-button--secondary');

      editor.selection = new vscode.Selection(primaryLine, 8, primaryLine, 8); // Still inside Primary.
      await sleep(700);
      assert.strictEqual(shownId(), 'design-system-button--secondary');

      // Moving into a different export does follow the cursor again.
      const dangerLine = editor.document.getText().split('\n').findIndex((l) => l.includes('export const DangerLarge'));
      editor.selection = new vscode.Selection(dangerLine, 0, dangerLine, 0);
      await waitFor('danger follows cursor', () => shownId() === 'design-system-button--danger-large');
    });
  });

  describe('browsing stories without opening the stories file', () => {
    const lensTitles = async (fsPath: string) => {
      const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', vscode.Uri.file(fsPath), 100)) ?? [];
      return lenses.filter((l) => l.command?.command === 'storyVisualiser.showStoryById');
    };

    it('shows one CodeLens per story above the component, marking the current one', async () => {
      const editor = await open(BUTTON);
      await waitFor('button story', () => shownId() === 'design-system-button--primary');
      let lenses: vscode.CodeLens[] = [];
      await waitFor('lenses', () => {
        void lensTitles(BUTTON).then((l) => (lenses = l));
        return lenses.length === 3;
      });
      assert.deepStrictEqual(lenses.map((l) => l.command!.title), ['$(eye) Primary', '$(play) Secondary', '$(play) Danger Large']);
      const line = editor.document.getText().split('\n').findIndex((l) => l.startsWith('export function Button'));
      assert.ok(lenses.every((l) => l.range.start.line === line), 'anchored on the component declaration');

      const secondary = lenses[1].command!;
      await vscode.commands.executeCommand(secondary.command, ...(secondary.arguments ?? []));
      await waitFor('secondary story', () => shownId() === 'design-system-button--secondary');
      await waitFor('lens highlight to move', async () => (await lensTitles(BUTTON))[1]?.command?.title === '$(eye) Secondary');
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, BUTTON, 'still editing the component');
    });

    it('shows a Preview CodeLens above each export in a stories file', async () => {
      await open(BUTTON_STORIES, 0);
      await waitFor('stories file story', () => api.state.story?.exportName === 'Primary');
      const lenses = await lensTitles(BUTTON_STORIES);
      assert.deepStrictEqual(lenses.map((l) => l.command!.title), ['$(eye) Previewing', '$(play) Preview', '$(play) Preview']);
      assert.deepStrictEqual(lenses.map((l) => l.command!.arguments![0]), [
        'design-system-button--primary',
        'design-system-button--secondary',
        'design-system-button--danger-large',
      ]);
    });

    it('can turn CodeLens off', async () => {
      await configure({ codeLens: false });
      await open(CARD);
      assert.strictEqual((await lensTitles(CARD)).length, 0);
      await configure({ codeLens: undefined });
    });

    it('lists stories in the Stories view and previews on click', async () => {
      await open(CARD);
      await waitFor('card story', () => shownId() === 'components-card--default');
      const items = () => api.storiesView.getChildren() as vscode.TreeItem[];
      await waitFor('tree items', () => items().length === 2);
      assert.deepStrictEqual(items().map((i) => i.label), ['Default', 'With long content']);
      assert.deepStrictEqual(items().map((i) => i.description), ['previewing', undefined]);
      assert.strictEqual(api.storiesView.view.description, 'Card.tsx');

      const command = items()[1].command!;
      await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
      await waitFor('long content story', () => shownId() === 'components-card--long-content');
      await waitFor('tree highlight', () => items()[1].description === 'previewing');

      await open(AVATAR);
      await waitFor('avatar tree', () => items().map((i) => i.label).join() === 'Small,Large');
    });

    it('steps through stories with next / previous, wrapping around', async () => {
      await open(BUTTON);
      await waitFor('primary', () => shownId() === 'design-system-button--primary');
      await vscode.commands.executeCommand('storyVisualiser.nextStory');
      await waitFor('secondary', () => shownId() === 'design-system-button--secondary');
      await vscode.commands.executeCommand('storyVisualiser.nextStory');
      await waitFor('danger', () => shownId() === 'design-system-button--danger-large');
      await vscode.commands.executeCommand('storyVisualiser.nextStory');
      await waitFor('wrap to primary', () => shownId() === 'design-system-button--primary');
      await vscode.commands.executeCommand('storyVisualiser.previousStory');
      await waitFor('wrap back to danger', () => shownId() === 'design-system-button--danger-large');
    });

    it('toggles the full Storybook UI (with its own story sidebar) in the browser', async () => {
      await open(CARD);
      await waitFor('card canvas', () => api.state.shownUrl?.includes('iframe.html?id=components-card--default'));
      await vscode.commands.executeCommand('storyVisualiser.toggleViewMode');
      await waitFor('manager url', () => api.state.shownUrl === `${SB}/?path=/story/components-card--default`);
      await vscode.commands.executeCommand('storyVisualiser.toggleViewMode');
      await waitFor('back to canvas', () => api.state.shownUrl?.includes('iframe.html'));
    });
  });

  describe('webview target', () => {
    it('shows the story in a webview panel with a story picker and syncs', async () => {
      await configure({ previewTarget: 'webview' });
      await open(BUTTON);
      await waitFor('webview', () => api.state.previewOpen && api.state.targetId === 'webview');
      const webviewTabs = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('storyVisualiser.preview'));
      assert.strictEqual(webviewTabs.length, 1);
      const state = (api.controller.preview as unknown as { state: { stories: { id: string }[]; storyId: string } }).state;
      assert.strictEqual(state.storyId, 'design-system-button--primary');
      assert.strictEqual(state.stories.length, 3);

      await open(CARD);
      await waitFor('card in webview', () => shownId() === 'components-card--default');
    });
  });

  describe('Story view (Primary Side Bar by default)', () => {
    const viewState = () => (api.controller.preview as unknown as { state?: { type: string; storyId?: string; stories?: unknown[] } } | undefined)?.state;
    const viewVisible = () => (api.controller.preview as unknown as { visible?: boolean } | undefined)?.visible === true;

    it('reveals itself in the Primary Side Bar the first time, without adding editor groups', async () => {
      await configure({ previewTarget: 'sidebar' });
      await open(BUTTON);
      await waitFor('story view', () => api.state.targetId === 'sidebar' && viewVisible() && viewState()?.storyId === 'design-system-button--primary');
      assert.strictEqual(viewState()?.stories?.length, 3);
      assert.strictEqual(vscode.window.tabGroups.all.length, 1, 'no extra editor group');
      assert.strictEqual(browserTabs().length, 0, 'no browser tab');
      await waitFor('focus stays in editor', () => vscode.window.activeTextEditor?.document.uri.fsPath === BUTTON);
    });

    it('keeps updating while hidden, but never steals the side bar back on file switches', async () => {
      await configure({ previewTarget: 'sidebar' });
      await open(BUTTON);
      await waitFor('story view', () => viewVisible() && viewState()?.storyId === 'design-system-button--primary');

      await vscode.commands.executeCommand('workbench.view.explorer'); // You go back to the Explorer.
      await waitFor('explorer shown', () => !viewVisible());
      await open(CARD);
      await waitFor('updated in the background', () => viewState()?.storyId === 'components-card--default');
      await sleep(600);
      assert.strictEqual(viewVisible(), false, 'auto-sync did not pull the Story view back over the Explorer');

      // Asking for a story explicitly brings it back.
      await vscode.commands.executeCommand('storyVisualiser.showStoryById', 'components-card--long-content', CARD);
      await waitFor('revealed on request', () => viewVisible() && viewState()?.storyId === 'components-card--long-content');
    });

    it('still accepts the old "panel" setting value', async () => {
      await configure({ previewTarget: 'panel' });
      await open(BADGE);
      await waitFor('story view via legacy value', () => api.state.targetId === 'sidebar' && viewState()?.storyId === 'design-system-badge--info');
    });

    it('can be moved with VS Code\'s own view picker', async () => {
      await configure({ previewTarget: 'sidebar' });
      await open(BUTTON);
      await vscode.commands.executeCommand('storyVisualiser.showStory');
      await waitFor('story view', () => viewVisible());
      // Opens VS Code's native "Move View" quick pick for the Story view; dismiss it.
      const pending = vscode.commands.executeCommand('storyVisualiser.moveStoryView');
      await sleep(500);
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await pending;
    });
  });

  describe('Storybook offline', () => {
    it('does not open a broken preview and reports Storybook as offline', async () => {
      await configure({ storybookUrl: 'http://localhost:6999' });
      await open(CARD);
      await waitFor('offline detection', () => api.state.storybookRunning === false);
      assert.strictEqual(api.state.previewOpen, false);
    });
  });
});
