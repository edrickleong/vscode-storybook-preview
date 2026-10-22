import * as vscode from 'vscode';
import { PreviewTarget, ShowRequest } from './targets';

let mediaRoot: vscode.Uri | undefined;

/** Where the bundled codicon font lives (`media/codicons`, copied from @vscode/codicons at build). */
export function setMediaRoot(root: vscode.Uri): void {
  mediaRoot = root;
}

export function webviewOptions(): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: mediaRoot ? [mediaRoot] : [] };
}

export type Inbound =
  | { type: 'selectStory'; id: string }
  | { type: 'command'; command: string }
  | { type: 'ready' };

/**
 * A webview panel that frames Storybook, with a toolbar for switching between the
 * current component's stories. Picking a story here syncs back to the editor.
 */
export class WebviewTarget implements PreviewTarget {
  readonly id = 'webview' as const;
  static readonly viewType = 'storyVisualiser.preview';

  private panel: vscode.WebviewPanel | undefined;
  private lastState: object | undefined;
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly selectEmitter = new vscode.EventEmitter<string>();
  private readonly commandEmitter = new vscode.EventEmitter<string>();
  readonly onDidClose = this.closeEmitter.event;
  readonly onDidSelectStory = this.selectEmitter.event;
  readonly onDidRequestCommand = this.commandEmitter.event;

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  async show(request: ShowRequest): Promise<void> {
    if (!this.panel && !request.reveal) return;
    const message = await storyMessage(request);
    this.ensurePanel(request.preserveFocus, new URL(message.url).origin);
    this.post(message);
  }

  showMessage(message: string, actions: { label: string; command: string }[] = []): void {
    if (!this.panel) return;
    this.post({ type: 'message', message, actions });
  }

  /** For tests: the last state sent to the webview. */
  get state(): object | undefined {
    return this.lastState;
  }

  private post(message: object): void {
    this.lastState = message;
    void this.panel?.webview.postMessage(message);
  }

  private ensurePanel(preserveFocus: boolean, frameOrigin: string): void {
    if (this.panel) {
      if (!this.panel.visible) this.panel.reveal(undefined, preserveFocus);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      WebviewTarget.viewType,
      'Story',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { ...webviewOptions(), retainContextWhenHidden: true },
    );
    this.panel.iconPath = new vscode.ThemeIcon('book');
    this.panel.webview.html = renderPreviewHtml(this.panel.webview, frameOrigin);
    this.panel.webview.onDidReceiveMessage((message: Inbound) => {
      if (message.type === 'selectStory') this.selectEmitter.fire(message.id);
      else if (message.type === 'command') this.commandEmitter.fire(message.command);
      else if (message.type === 'ready' && this.lastState) void this.panel?.webview.postMessage(this.lastState);
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.lastState = undefined;
      this.closeEmitter.fire();
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.closeEmitter.dispose();
    this.selectEmitter.dispose();
    this.commandEmitter.dispose();
  }
}

/** The message that points a preview webview at a story. */
export async function storyMessage(request: ShowRequest) {
  // asExternalUri makes localhost reachable from remote/Codespaces webviews.
  const url = (await vscode.env.asExternalUri(vscode.Uri.parse(request.url))).toString(true);
  return {
    type: 'story' as const,
    url,
    storyId: request.story.id,
    title: request.story.title,
    sourceName: request.story.storiesFile.split(/[\\/]/).pop(),
    stories: request.stories.map((s) => ({ id: s.id, name: s.name })),
  };
}

export function renderPreviewHtml(webview: vscode.Webview, frameOrigin: string): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const codicons = mediaRoot ? webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicons', 'codicon.css')).toString() : '';
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${frameOrigin} http: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${codicons}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  header { display: flex; gap: 4px; align-items: center; height: 35px; padding: 0 8px; box-sizing: border-box; border-bottom: 1px solid var(--vscode-panel-border, transparent); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  header .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
  select { height: 24px; min-width: 0; max-width: 45%; padding: 0 4px; border-radius: 2px; font: inherit; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); }
  select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  /* Mirrors VS Code's own toolbar action items: 22px targets with 16px codicons. */
  .action { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; }
  .action:hover { background: var(--vscode-toolbar-hoverBackground); }
  .action:active { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }
  .action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .action .codicon { font-size: 16px; }
  .action .icon { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.1; stroke-linecap: round; stroke-linejoin: round; }
  /* In a narrow side bar the view title already says where you are; give the picker the room. */
  @media (max-width: 420px) { header .title { display: none; } select { flex: 1; max-width: none; } }
  main { flex: 1; position: relative; background: #fff; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  #message { position: absolute; inset: 0; display: none; flex-direction: column; gap: 12px; align-items: center; justify-content: center; text-align: center; padding: 24px; background: var(--vscode-editor-background); }
  #message.visible { display: flex; }
  #message button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 6px 12px; }
</style>
</head>
<body>
  <header>
    <span class="title" id="title">Story</span>
    <button class="action" id="previous" title="Previous story" aria-label="Previous story"><span class="codicon codicon-chevron-left"></span></button>
    <select id="stories" aria-label="Story" title="Switch story"></select>
    <button class="action" id="next" title="Next story" aria-label="Next story"><span class="codicon codicon-chevron-right"></span></button>
    <button class="action" id="reload" title="Reload story" aria-label="Reload story">
      <!-- Drawn to match its neighbours' optical size; codicon's refresh glyph renders noticeably smaller. -->
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M14.3 8.6A6.35 6.35 0 1 1 12.4 3.5"/><path d="M13.4 0.8v3.5H9.9"/></svg>
    </button>
    <button class="action" id="source" title="Open story source" aria-label="Open story source"><span class="codicon codicon-file-code"></span></button>
    <button class="action" id="external" title="Open in external browser" aria-label="Open in external browser"><span class="codicon codicon-link-external"></span></button>
  </header>
  <main>
    <iframe id="frame" title="Story preview"></iframe>
    <div id="message" role="status"><p id="messageText"></p><div id="actions"></div></div>
  </main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('frame');
  const select = document.getElementById('stories');
  const title = document.getElementById('title');
  const message = document.getElementById('message');

  select.addEventListener('change', () => vscode.postMessage({ type: 'selectStory', id: select.value }));
  document.getElementById('previous').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'storyVisualiser.previousStory' }));
  document.getElementById('next').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'storyVisualiser.nextStory' }));
  document.getElementById('reload').addEventListener('click', () => { const src = frame.src; frame.src = 'about:blank'; frame.src = src; });
  document.getElementById('source').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'storyVisualiser.openStoryFile' }));
  document.getElementById('external').addEventListener('click', () => vscode.postMessage({ type: 'command', command: 'storyVisualiser.openInExternalBrowser' }));

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data.type === 'story') {
      message.classList.remove('visible');
      title.textContent = data.title;
      select.title = data.title;
      const source = document.getElementById('source');
      source.title = 'Open story source (' + data.sourceName + ')';
      source.setAttribute('aria-label', source.title);
      select.replaceChildren(...data.stories.map((s) => new Option(s.name, s.id, false, s.id === data.storyId)));
      if (frame.dataset.url !== data.url) { frame.dataset.url = data.url; frame.src = data.url; }
      vscode.setState(data);
    } else if (data.type === 'message') {
      document.getElementById('messageText').textContent = data.message;
      const actions = document.getElementById('actions');
      actions.replaceChildren(...data.actions.map((a) => {
        const b = document.createElement('button');
        b.textContent = a.label;
        b.addEventListener('click', () => vscode.postMessage({ type: 'command', command: a.command }));
        return b;
      }));
      message.classList.add('visible');
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
