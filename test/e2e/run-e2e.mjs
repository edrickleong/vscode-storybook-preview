#!/usr/bin/env node
// End-to-end test: launches real VS Code with a Chrome DevTools Protocol port, drives the UI
// with agent-browser (keyboard + clicks + screenshots) and inspects the integrated browser's
// own CDP target to confirm the right story actually rendered.
//
// Requires: VS Code with the integrated browser, agent-browser on PATH, sample deps installed.
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sample = path.join(root, 'sample');
const artifacts = path.join(root, 'test-artifacts');
const CODE = process.env.VSCODE_PATH ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const PORT = Number(process.env.CDP_PORT ?? 9333);
// The sample's own port, so it never collides with a Storybook you run on 6006.
const STORYBOOK = 'http://localhost:6106';
const SESSION = 'story-visualiser-e2e';

fs.mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let step = 0;

// ---------------------------------------------------------------------------- helpers

function ab(...args) {
  return execFileSync('agent-browser', ['--session', SESSION, '--cdp', String(PORT), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  return res.json();
}

/** Minimal CDP Runtime.evaluate against a target's websocket. */
function evaluate(target, expression, timeoutMs = 5000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`CDP evaluate timed out on ${target.url}`)), timeoutMs);
  });
  return Promise.race([evaluateUnbounded(target, expression), timeout]).finally(() => clearTimeout(timer));
}

async function evaluateUnbounded(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const result = await new Promise((resolve, reject) => {
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== 1) return;
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result.result.value);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  return result;
}

async function waitFor(what, fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

// Browser tabs are titled by the page (Storybook uses the story id), so find them by URL tooltip/label shape.
const CLOSE_BROWSER_TAB = `(() => { const tab = [...document.querySelectorAll('.tabs-container .tab')].find(t => (t.getAttribute('aria-label') ?? '').includes('localhost:6106')); tab?.querySelector('.tab-actions .action-label')?.click(); return tab?.getAttribute('aria-label'); })()`;
const storyTargets = async () => (await targets()).filter((t) => t.type === 'page' && t.url.startsWith(STORYBOOK));
const workbench = async () => (await targets()).find((t) => t.type === 'page' && t.url.includes('workbench.html'));

/** Waits until the (single) integrated browser tab shows `storyId` and its root contains `text`. */
async function expectStory(storyId, text) {
  const target = await waitFor(`integrated browser to show ${storyId}`, async () => {
    const pages = await storyTargets();
    return pages.find((t) => t.url.includes(`id=${storyId}&`));
  });
  const rendered = await waitFor(`${storyId} to render "${text}"`, async () => {
    const html = await evaluate(target, `document.querySelector('#storybook-root')?.innerText ?? ''`);
    return html.includes(text) && html;
  });
  const count = (await storyTargets()).length;
  if (count !== 1) throw new Error(`expected exactly one Storybook browser tab, found ${count}`);
  return { target, rendered };
}

async function quickOpen(relativePath, line) {
  const base = path.basename(relativePath);
  for (let attempt = 0; attempt < 3; attempt++) {
    selectWorkbenchTab();
    ab('press', 'Escape');
    // Return focus to the editor area so stray keys can't drive the Explorer tree.
    await workbenchEval(`document.querySelector('.editor-group-container.active .monaco-editor textarea, .editor-group-container.active .monaco-editor .native-edit-context')?.focus()`);
    ab('press', 'Meta+p');
    const opened = await waitFor('quick open', () => workbenchEval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) input')`), 3000).catch(() => false);
    if (!opened) continue;
    ab('keyboard', 'type', relativePath);
    // Wait for the result list to catch up with the filter before accepting.
    const matched = await waitFor('quick open results', () =>
      workbenchEval(`(document.querySelector('.quick-input-list .monaco-list-row.focused')?.innerText ?? '').replace(/\\s+/g, ' ').includes(${JSON.stringify(base)})`), 5000).catch(() => false);
    if (!matched) continue;
    if (line) {
      ab('keyboard', 'type', `:${line}`);
      await sleep(500);
    }
    ab('press', 'Enter');
    const ok = await waitFor(`${base} to be the active editor`, () =>
      workbenchEval(`(document.querySelector('.editor-group-container.active .tab.active')?.getAttribute('aria-label') ?? '').includes(${JSON.stringify(base)})`), 5000).catch(() => false);
    if (!ok) continue;
    return;
  }
  throw new Error(`could not open ${relativePath} via quick open`);
}

/** Point agent-browser at the VS Code workbench (not the integrated browser's page). */
function selectWorkbenchTab() {
  const list = ab('tab');
  const line = list.split('\n').find((l) => l.includes('workbench.html'));
  const label = /\[(t\d+)\]/.exec(line ?? '')?.[1];
  if (!label) throw new Error(`workbench tab not found in:\n${list}`);
  ab('tab', label);
}

/** Real mouse click (through CDP input events) on the element `finder` returns in the workbench. */
async function realClick(what, finder) {
  const rect = await waitFor(what, () =>
    workbenchEval(`(() => { const el = (${finder})(); if (!el) return false; el.scrollIntoView?.({ block: 'nearest' }); const r = el.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : false; })()`),
  );
  selectWorkbenchTab();
  ab('mouse', 'move', String(Math.round(rect.x)), String(Math.round(rect.y)));
  ab('mouse', 'down');
  ab('mouse', 'up');
}

async function statusBarStory() {
  return workbenchEval(`[...document.querySelectorAll('.statusbar-item')].map(e => e.innerText.trim()).find(t => /^\\S*\\s*(Primary|Secondary|Danger Large|Default|With long content|Small|Large|Info|Success)$/.test(t)) ?? ''`);
}

async function workbenchEval(expression) {
  return evaluate(await workbench(), expression);
}

function screenshot(name) {
  const file = path.join(artifacts, `${String(++step).padStart(2, '0')}-${name}.png`);
  selectWorkbenchTab();
  ab('screenshot', file);
  return file;
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: error.message });
    console.log(`  ✘ ${name}\n      ${error.message}`);
    try {
      screenshot(`FAILED-${name.replace(/\W+/g, '-')}`);
    } catch {}
  }
}

function writeSettings(dir, extra = {}) {
  fs.mkdirSync(path.join(dir, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'User', 'settings.json'),
    JSON.stringify(
      {
        'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false,
        'git.openRepositoryInParentFolders': 'never',
        'chat.disableAIFeatures': true,
        'window.restoreWindows': 'none',
        'workbench.tips.enabled': false,
        'extensions.ignoreRecommendations': true,
        // agent-browser reads the accessibility tree, which makes VS Code offer screen-reader mode;
        // that notification would pause the integrated browser.
        'editor.accessibilitySupport': 'off',
        ...extra,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------- setup

let storybook;
// Stands in for "the app you're testing" in your own integrated browser tab.
const APP_PORT = 3999;
const appServer = http.createServer((_req, res) => res.end('<!doctype html><title>My App</title><h1>My app under test</h1>'));
appServer.listen(APP_PORT);
let code;
const userDataDir = fs.mkdtempSync('/tmp/sv-e2e-');

async function ensureStorybook() {
  const isSample = () =>
    fetch(`${STORYBOOK}/index.json`).then((r) => r.json(), () => undefined).then((i) => !!i?.entries?.['design-system-button--primary'], () => false);
  if (await isSample()) return;
  console.log('Starting sample Storybook…');
  storybook = spawn('npx', ['storybook', 'dev', '-p', '6106', '--no-open', '--ci'], { cwd: sample, stdio: 'ignore', detached: true });
  await waitFor('Storybook to start', isSample, 120000);
}

async function launchVSCode() {
  const inUse = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
  if (inUse) throw new Error(`port ${PORT} is already in use — close the other debug instance or set CDP_PORT`);
  writeSettings(userDataDir);
  code = spawn(
    CODE,
    [
      `--remote-debugging-port=${PORT}`,
      '--user-data-dir', userDataDir,
      '--extensions-dir', path.join(userDataDir, 'extensions'),
      `--extensionDevelopmentPath=${root}`,
      '--log', 'edrickleong.component-story-visualiser:trace',
      // The test window is usually behind other windows; stop Chromium throttling its timers
      // (otherwise editor features like CodeLens refresh can lag by tens of seconds).
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--skip-welcome', '--skip-release-notes', '--new-window',
      sample,
    ],
    { stdio: 'ignore', detached: true },
  );
  await waitFor('VS Code workbench', async () => (await workbench()) !== undefined, 60000);
  // Wait for the explorer to render so keyboard input lands in the workbench.
  await waitFor('workbench ready', () => workbenchEval(`!!document.querySelector('.explorer-folders-view, .monaco-workbench .part.sidebar')`), 30000);
  await sleep(3000);
  selectWorkbenchTab();
}

function cleanup() {
  // VS Code forks helpers that outlive the launcher; kill everything using our profile.
  try {
    execFileSync('pkill', ['-f', `user-data-dir ${userDataDir}`]);
  } catch {}
  appServer.close();
  for (const child of [code, storybook]) {
    if (!child) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
}

// ---------------------------------------------------------------------------- scenarios

const buttonFile = path.join(sample, 'src/components/Button/Button.tsx');
const originalButton = fs.readFileSync(buttonFile, 'utf8');

try {
  await ensureStorybook();
  await launchVSCode();
  console.log('\nComponent Story Visualiser — end-to-end\n');

  await check('opening a component auto-opens its story beside it', async () => {
    await quickOpen('src/components/Button/Button.tsx');
    const { rendered } = await expectStory('design-system-button--primary', 'Click me');
    const groups = await workbenchEval(`document.querySelectorAll('.editor-group-container').length`);
    if (groups < 2) throw new Error(`expected the preview in a second editor group, found ${groups} group(s)`);
    const active = await workbenchEval(`document.querySelector('.editor-group-container.active .tab.active')?.getAttribute('aria-label') ?? ''`);
    if (!active.includes('Button.tsx')) throw new Error(`focus should stay on Button.tsx, active tab is "${active}"`);
    screenshot('button-primary');
    return `rendered "${rendered.trim()}", focus kept in editor`;
  });

  await check('editor title shows the "Show Story" button for components', async () => {
    const label = await waitFor('Show Story action', () =>
      workbenchEval(`[...document.querySelectorAll('.editor-actions .action-label')].map(a => a.getAttribute('aria-label')).find(l => l && l.startsWith('Show Story'))`),
    );
    return `found action "${label}"`;
  });

  await check('status bar shows the current story', async () => {
    const text = await waitFor('status bar item', () =>
      workbenchEval(`[...document.querySelectorAll('.statusbar-item')].map(e => e.innerText.trim()).find(t => t.includes('Primary'))`),
    );
    return `"${text}"`;
  });

  await check('switching to another component swaps the story in the same tab', async () => {
    await quickOpen('src/components/Card/Card.tsx');
    await expectStory('components-card--default', 'Card heading');
    await quickOpen('src/components/Badge/index.tsx');
    await expectStory('design-system-badge--info', 'New');
    screenshot('badge-info');
    return 'Card → Badge, one browser tab';
  });

  await check('components whose story lives elsewhere are found (Avatar → src/stories)', async () => {
    await quickOpen('src/components/Avatar/Avatar.tsx');
    await expectStory('people-avatar--small', 'EL');
  });

  await check('moving the cursor in a stories file switches story', async () => {
    const line = fs.readFileSync(path.join(sample, 'src/components/Button/Button.stories.tsx'), 'utf8').split('\n').findIndex((l) => l.includes('export const DangerLarge')) + 1;
    await quickOpen('src/components/Button/Button.stories.tsx', line);
    await expectStory('design-system-button--danger-large', 'Delete');
    screenshot('stories-file-cursor');
    return `cursor on line ${line} → DangerLarge`;
  });

  await check('editing the component hot-reloads the preview without navigation', async () => {
    const { target } = await expectStory('design-system-button--danger-large', 'Delete');
    await evaluate(target, `window.__svMarker = 'still-here'`);
    fs.writeFileSync(buttonFile, originalButton.replace('{label}', '{label} ✓'));
    await waitFor('HMR update', () => evaluate(target, `document.querySelector('#storybook-root')?.innerText.includes('Delete ✓')`));
    const marker = await evaluate(target, `window.__svMarker`);
    if (marker !== 'still-here') throw new Error('page reloaded instead of hot-updating');
    screenshot('hmr-update');
    fs.writeFileSync(buttonFile, originalButton);
    await waitFor('HMR revert', () => evaluate(target, `!document.querySelector('#storybook-root')?.innerText.includes('✓')`));
    return 'label updated live via Storybook HMR';
  });

  await check('a component without a story leaves the preview alone', async () => {
    await quickOpen('src/components/Divider.tsx');
    await sleep(1500);
    const pages = await storyTargets();
    if (pages.length !== 1 || !pages[0].url.includes('danger-large')) throw new Error(`preview changed: ${pages.map((p) => p.url)}`);
    const hasAction = await workbenchEval(`[...document.querySelectorAll('.editor-actions .action-label')].some(a => (a.getAttribute('aria-label') ?? '').startsWith('Show Story'))`);
    if (hasAction) throw new Error('Show Story button should be hidden for files without stories');
  });

  await check('CodeLens above the component lists its stories; clicking one previews it', async () => {
    await quickOpen('src/components/Button/Button.tsx');
    const lenses = await waitFor('story CodeLenses', () =>
      workbenchEval(`(() => { const t = [...document.querySelectorAll('.editor-group-container.active .codelens-decoration a')].map(a => a.innerText.trim()); return t.length >= 3 && t; })()`),
    );
    // Let the lenses settle (they re-render as the preview syncs), then click like a user would.
    let shown = false;
    for (let attempt = 0; attempt < 3 && !shown; attempt++) {
      await sleep(1000);
      await realClick('Secondary CodeLens', `() => [...document.querySelectorAll('.editor-group-container.active .codelens-decoration a')].find(a => a.innerText.trim().endsWith('Secondary'))`);
      shown = await waitFor('secondary', async () => (await storyTargets()).some((t) => t.url.includes('id=design-system-button--secondary&')), 4000).catch(() => false);
    }
    await expectStory('design-system-button--secondary', 'Click me');
    const after = await waitFor('lens highlight', () =>
      workbenchEval(`(() => { const a = [...document.querySelectorAll('.editor-group-container.active .codelens-decoration a')].find(a => a.innerText.includes('Secondary')); return a && a.querySelector('.codicon-eye') ? a.innerText.trim() : false; })()`),
    );
    const active = await workbenchEval(`document.querySelector('.editor-group-container.active .tab.active')?.getAttribute('aria-label') ?? ''`);
    if (!active.includes('Button.tsx')) throw new Error(`editor focus moved to "${active}"`);
    screenshot('codelens');
    return `lenses [${lenses.join(' | ')}]; clicked Secondary → eye on "${after}"`;
  });

  await check('Stories view in the Explorer lists stories; clicking one previews it', async () => {
    // Make sure the Stories pane is expanded.
    await workbenchEval(`(() => { const h = [...document.querySelectorAll('.pane-header')].find(h => h.innerText.trim().toUpperCase().startsWith('STORIES')); if (h && h.getAttribute('aria-expanded') === 'false') h.click(); return !!h; })()`);
    const rows = await waitFor('Stories view rows', () =>
      workbenchEval(`(() => { const pane = [...document.querySelectorAll('.pane')].find(p => p.querySelector('.pane-header')?.innerText.trim().toUpperCase().startsWith('STORIES')); const r = pane && [...pane.querySelectorAll('.monaco-list-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()); return r && r.length === 3 && r; })()`),
    );
    await realClick('Danger Large row', `() => { const pane = [...document.querySelectorAll('.pane')].find(p => p.querySelector('.pane-header')?.innerText.trim().toUpperCase().startsWith('STORIES')); return pane && [...pane.querySelectorAll('.monaco-list-row')].find(r => r.innerText.includes('Danger Large')); }`);
    await expectStory('design-system-button--danger-large', 'Delete');
    await waitFor('row marked previewing', () =>
      workbenchEval(`[...document.querySelectorAll('.pane .monaco-list-row')].some(r => r.innerText.includes('Danger Large') && r.innerText.includes('previewing'))`),
    );
    screenshot('stories-view');
    return `rows [${rows.join(' | ')}] → Danger Large`;
  });

  await check('Ctrl+Alt+] / Ctrl+Alt+[ step through the component\'s stories', async () => {
    await quickOpen('src/components/Button/Button.tsx');
    ab('press', 'Control+Alt+BracketRight');
    await expectStory('design-system-button--primary', 'Click me'); // wraps from Danger Large
    ab('press', 'Control+Alt+BracketRight');
    await expectStory('design-system-button--secondary', 'Click me');
    ab('press', 'Control+Alt+BracketLeft');
    await expectStory('design-system-button--primary', 'Click me');
    return `status bar "${await statusBarStory()}"`;
  });

  await check('using the preview tab to test your app: it is left alone and a new preview opens beside the code', async () => {
    await quickOpen('src/components/Card/Card.tsx');
    await expectStory('components-card--default', 'Card heading');
    // Type your app's URL into the preview tab's own address bar, as you would to test something.
    selectWorkbenchTab();
    await workbenchEval(`(() => { const el = document.querySelector('.browser-url-display'); el.focus(); document.getSelection().selectAllChildren(el); return document.activeElement === el; })()`);
    ab('keyboard', 'type', `http://localhost:${APP_PORT}/`);
    ab('press', 'Enter');
    const app = await waitFor('your app to load in that tab', async () => (await targets()).find((t) => t.type === 'page' && t.url.startsWith(`http://localhost:${APP_PORT}`)), 15000);
    selectWorkbenchTab();

    // Keep working on components.
    await quickOpen('src/components/Button/Button.tsx');
    await expectStory('design-system-button--primary', 'Click me');
    await quickOpen('src/components/Badge/index.tsx');
    await expectStory('design-system-badge--info', 'New');
    const appNow = (await targets()).find((t) => t.id === app.id);
    if (!appNow?.url.startsWith(`http://localhost:${APP_PORT}`)) throw new Error(`your app tab was navigated: ${appNow?.url}`);
    const groups = await workbenchEval(`[...document.querySelectorAll('.editor-group-container')].map(g => [...g.querySelectorAll('.tab')].map(t => t.getAttribute('aria-label')).join(', '))`);
    if (groups.length !== 2 || !groups[1].includes('My App') || /My App|localhost:6106/.test(groups[0])) throw new Error(`unexpected groups: ${JSON.stringify(groups)}`);
    screenshot('your-app-tab-coexists');
    // Tidy up: close your app tab so later checks start clean.
    await workbenchEval(`[...document.querySelectorAll('.tabs-container .tab')].find(t => (t.getAttribute('aria-label') ?? '').startsWith('My App'))?.querySelector('.tab-actions .action-label')?.click()`);
    return groups.map((g, i) => `[group ${i + 1}] ${g}`).join('  ');
  });

  await check('closing the preview, then clicking "Show Story" reopens it', async () => {
    await quickOpen('src/components/Card/Card.tsx');
    await expectStory('components-card--default', 'Card heading');
    // Close the Storybook tab via its close button.
    await workbenchEval(`${CLOSE_BROWSER_TAB}`);
    await waitFor('preview to close', async () => (await storyTargets()).length === 0);
    await quickOpen('src/components/Card/Card.tsx');
    await sleep(1200);
    if ((await storyTargets()).length !== 0) throw new Error('preview reopened for the same component after being dismissed');
    await workbenchEval(`[...document.querySelectorAll('.editor-actions .action-label')].find(a => (a.getAttribute('aria-label') ?? '').startsWith('Show Story'))?.click()`);
    await expectStory('components-card--default', 'Card heading');
    screenshot('reopened-via-button');
    return 'dismissal respected; title button reopened it';
  });

  await check('webview mode: story picker in the panel syncs back to the editor', async () => {
    writeSettings(userDataDir, { 'storyVisualiser.previewTarget': 'webview' });
    await workbenchEval(`${CLOSE_BROWSER_TAB}`);
    await sleep(1500);
    await quickOpen('src/components/Button/Button.tsx');
    // The webview panel frames Storybook; its iframe appears as its own CDP target.
    const frame = await waitFor('webview story frame', async () =>
      (await targets()).find((t) => t.type === 'iframe' && t.url.startsWith(`${STORYBOOK}/iframe.html`)),
    );
    const webview = await waitFor('webview document', async () => (await targets()).find((t) => t.type === 'iframe' && t.url.startsWith('vscode-webview://')));
    const pick = `(() => { const doc = document.querySelector('#active-frame')?.contentDocument ?? document; const s = doc.querySelector('#stories'); if (!s) return 'no-select'; s.value = 'design-system-button--secondary'; s.dispatchEvent(new Event('change')); return [...s.options].map(o => o.text).join(','); })()`;
    const options = await evaluate(webview, pick);
    if (!options.includes('Secondary')) throw new Error(`picker options: ${options} (frame ${frame.url})`);
    await waitFor('webview to show Secondary', async () =>
      (await targets()).some((t) => t.type === 'iframe' && t.url.includes('id=design-system-button--secondary')),
    );
    const statusBar = await waitFor('status bar to follow the picker', () =>
      workbenchEval(`[...document.querySelectorAll('.statusbar-item')].map(e => e.innerText.trim()).find(t => t.includes('Secondary'))`),
    );
    screenshot('webview-picker');
    return `options [${options}] → status bar "${statusBar}"`;
  });

  await check('Story view mode: preview in the Primary Side Bar, picker syncs back', async () => {
    writeSettings(userDataDir, { 'storyVisualiser.previewTarget': 'sidebar' });
    await workbenchEval(`[...document.querySelectorAll('.tabs-container .tab')].filter(t => (t.getAttribute('aria-label') ?? '').startsWith('Story')).forEach(t => t.querySelector('.tab-actions .action-label')?.click())`);
    await sleep(1500);
    await quickOpen('src/components/Card/Card.tsx');
    await waitFor('panel story frame', async () => (await targets()).some((t) => t.type === 'iframe' && t.url.includes('id=components-card--default')), 20000);
    const groups = await workbenchEval(`document.querySelectorAll('.editor-group-container').length`);
    const sidebarTitle = await workbenchEval(`document.querySelector('.part.sidebar .composite.title h2, .part.sidebar .title-label h2')?.innerText ?? ''`);
    // Pick another story from the panel's own drop-down; it must not move you in the code.
    const cursorBefore = await workbenchEval(`[...document.querySelectorAll('.statusbar-item')].map(e => e.innerText.trim()).find(t => /^Ln \\d+, Col \\d+/.test(t))`);
    const editorBefore = await workbenchEval(`document.querySelector('.editor-group-container.active .tab.active')?.getAttribute('aria-label')`);
    let options;
    for (const t of (await targets()).filter((t) => t.type === 'iframe' && t.url.startsWith('vscode-webview://'))) {
      options = await evaluate(t, `(() => { const doc = document.querySelector('#active-frame')?.contentDocument ?? document; const s = doc.querySelector('#stories'); if (!s || ![...s.options].some(o => o.value === 'components-card--long-content')) return ''; s.value = 'components-card--long-content'; s.dispatchEvent(new Event('change')); return [...s.options].map(o => o.text).join(','); })()`).catch(() => '');
      if (options) break;
    }
    if (!options) throw new Error('panel picker not found');
    await waitFor('panel to show the picked story', async () => (await targets()).some((t) => t.type === 'iframe' && t.url.includes('id=components-card--long-content')));
    const statusBar = await waitFor('status bar to follow', () => workbenchEval(`[...document.querySelectorAll('.statusbar-item')].map(e => e.innerText.trim()).find(t => t.includes('With long content'))`));
    await sleep(600);
    const cursorAfter = await workbenchEval(`[...document.querySelectorAll('.statusbar-item')].map(e => e.innerText.trim()).find(t => /^Ln \\d+, Col \\d+/.test(t))`);
    const editorAfter = await workbenchEval(`document.querySelector('.editor-group-container.active .tab.active')?.getAttribute('aria-label')`);
    if (cursorAfter !== cursorBefore || editorAfter !== editorBefore) throw new Error(`picking a story moved you: ${editorBefore} ${cursorBefore} → ${editorAfter} ${cursorAfter}`);
    screenshot('story-view-sidebar');
    return `${groups} editor group(s), side bar shows "${sidebarTitle}"; picker [${options}] → "${statusBar}"`;
  });
} catch (error) {
  console.error(error);
  results.push({ name: 'setup', ok: false, detail: error.message });
} finally {
  fs.writeFileSync(buttonFile, originalButton);
  fs.writeFileSync(path.join(artifacts, 'e2e-results.json'), JSON.stringify(results, null, 2));
  try {
    const log = execFileSync('find', [path.join(userDataDir, 'logs'), '-name', '*Story Visualiser*'], { encoding: 'utf8' }).split('\n')[0];
    if (log) fs.copyFileSync(log, path.join(artifacts, 'extension.log'));
  } catch {}
  cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots in ${path.relative(process.cwd(), artifacts)}/`);
process.exit(failed.length ? 1 : 0);
