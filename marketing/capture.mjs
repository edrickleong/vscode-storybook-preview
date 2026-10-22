#!/usr/bin/env node
// Captures the real extension for the demo video and README images.
//
// Installs the packaged .vsix into a throwaway VS Code profile (so what you see is exactly
// what ships), opens the sample project, drives each feature through the real UI with
// agent-browser over CDP, and saves Retina screenshots plus the on-screen rectangles of
// the UI being demonstrated (so the video can zoom to them) into public/shots/.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sample = path.join(root, 'sample');
const out = path.join(here, 'public', 'shots');
const APP = '/Applications/Visual Studio Code.app';
const CODE = process.env.VSCODE_PATH ?? `${APP}/Contents/MacOS/Code`;
const CODE_CLI = `${APP}/Contents/Resources/app/bin/code`;
const PORT = 9335;
const STORYBOOK = 'http://localhost:6106';
const SESSION = 'story-visualiser-capture';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vsix = fs.readdirSync(root).filter((f) => f.endsWith('.vsix')).sort().pop();
if (!vsix) throw new Error('No .vsix found — run `npm run package` in the repo root first.');
fs.mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------------------- CDP helpers

const ab = (...args) => execFileSync('agent-browser', ['--session', SESSION, '--cdp', String(PORT), ...args], { encoding: 'utf8', timeout: 30000 }).trim();
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const workbench = async () => (await targets()).find((t) => t.type === 'page' && t.url.includes('workbench.html'));

async function evaluate(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const value = await Promise.race([
    new Promise((resolve, reject) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === 1) (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result.result.value));
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    }),
    sleep(5000).then(() => undefined),
  ]);
  ws.close();
  return value;
}
const wb = async (expression) => evaluate(await workbench(), expression);

async function waitFor(what, fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function selectWorkbench() {
  const line = ab('tab').split('\n').find((l) => l.includes('workbench.html'));
  ab('tab', /\[(t\d+)\]/.exec(line)[1]);
}

async function storyShown(id, text) {
  const page = await waitFor(`story ${id}`, async () =>
    (await targets()).find((t) => (t.type === 'page' || t.type === 'iframe') && t.url.startsWith(STORYBOOK) && (t.url.includes(`id=${id}&`) || t.url.includes(`/story/${id}&`))),
  );
  await waitFor(`${id} to render`, async () => ((await evaluate(page, `document.querySelector('#storybook-root')?.innerText ?? ''`)) ?? '').includes(text));
  await sleep(600); // Let transitions settle before the shot.
}

async function quickOpen(file) {
  const base = path.basename(file);
  for (let attempt = 0; attempt < 3; attempt++) {
    selectWorkbench();
    ab('press', 'Escape');
    await wb(`document.querySelector('.editor-group-container.active .monaco-editor .native-edit-context, .editor-group-container.active .monaco-editor textarea')?.focus()`);
    ab('press', 'Meta+p');
    // Only type once quick open is really there, or the keys would land in the editor.
    const opened = await waitFor('quick open', () => wb(`document.activeElement?.closest?.('.quick-input-widget') ? true : false`), 3000).catch(() => false);
    if (!opened) continue;
    ab('keyboard', 'type', file);
    const ok = await waitFor('results', () => wb(`(document.querySelector('.quick-input-list .monaco-list-row.focused')?.innerText ?? '').includes(${JSON.stringify(base)})`), 5000).catch(() => false);
    if (!ok) continue;
    ab('press', 'Enter');
    if (await waitFor('editor', () => wb(`(document.querySelector('.editor-group-container.active .tab.active')?.getAttribute('aria-label') ?? '').includes(${JSON.stringify(base)})`), 5000).catch(() => false)) {
      await sleep(400);
      return;
    }
  }
  throw new Error(`could not open ${file}`);
}

/** Bounding rect (CSS px) of the element `finder` returns, for zooming in the video. */
const rectOf = (finder) => wb(`(() => { const el = (${finder})(); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

async function realClick(finder) {
  const r = await waitFor('click target', () => rectOf(finder));
  selectWorkbench();
  ab('mouse', 'move', String(Math.round(r.x + r.width / 2)), String(Math.round(r.y + r.height / 2)));
  ab('mouse', 'down');
  ab('mouse', 'up');
}

const manifest = { viewport: null, shots: {} };
async function shot(name, highlights = {}) {
  const dirty = await wb(`document.querySelectorAll('.tab.dirty').length`);
  if (dirty) throw new Error(`unexpected unsaved edits before ${name}`);
  selectWorkbench();
  await sleep(300);
  ab('screenshot', path.join(out, `${name}.png`));
  manifest.viewport ??= await wb(`({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })`);
  manifest.shots[name] = { file: `shots/${name}.png`, highlights };
  console.log(`  📸 ${name}`);
}

// ---------------------------------------------------------------------------- setup

const profile = fs.mkdtempSync('/tmp/sv-capture-');
let code;
let storybook;

async function ensureStorybook() {
  const isSample = () => fetch(`${STORYBOOK}/index.json`).then((r) => r.json()).then((i) => !!i?.entries?.['design-system-button--primary'], () => false);
  if (await isSample()) return;
  storybook = spawn('npx', ['storybook', 'dev', '-p', '6106', '--no-open', '--ci'], { cwd: sample, stdio: 'ignore', detached: true });
  await waitFor('sample Storybook', isSample, 120000);
}

function writeSettings(extra = {}) {
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.tips.enabled': false,
      'security.workspace.trust.enabled': false,
      'git.openRepositoryInParentFolders': 'never',
      'chat.disableAIFeatures': true,
      'editor.accessibilitySupport': 'off',
      'editor.minimap.enabled': false,
      'editor.fontSize': 14,
      'editor.lightbulb.enabled': 'off',
      'window.restoreWindows': 'none',
      'window.commandCenter': false,
      'extensions.ignoreRecommendations': true,
      'update.mode': 'none',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      ...extra,
    }, null, 2),
  );
}

async function launch() {
  console.log(`Installing ${vsix} into a clean profile…`);
  execFileSync(CODE_CLI, ['--extensions-dir', path.join(profile, 'extensions'), '--user-data-dir', profile, '--install-extension', path.join(root, vsix), '--force'], { stdio: 'ignore' });
  writeSettings();
  code = spawn(CODE, [
    `--remote-debugging-port=${PORT}`, '--user-data-dir', profile, '--extensions-dir', path.join(profile, 'extensions'),
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--skip-welcome', '--skip-release-notes', '--new-window', sample,
  ], { stdio: 'ignore', detached: true });
  await waitFor('workbench', async () => (await workbench()) !== undefined, 60000);
  await waitFor('explorer', () => wb(`!!document.querySelector('.explorer-folders-view')`), 30000);
  await sleep(3000);
  // Expand the component folders so the Explorer looks lived-in.
  selectWorkbench();
}

function cleanup() {
  try { execFileSync('pkill', ['-f', `user-data-dir ${profile}`]); } catch {}
  if (storybook) try { process.kill(-storybook.pid); } catch {}
}

// ---------------------------------------------------------------------------- scenes

const buttonFile = path.join(sample, 'src/components/Button/Button.tsx');
const originalButton = fs.readFileSync(buttonFile, 'utf8');
const lensFinder = (label) => `() => [...document.querySelectorAll('.editor-group-container.active .codelens-decoration a')].find(a => a.innerText.trim().endsWith(${JSON.stringify(label)}))`;
const lensRow = `() => document.querySelector('.editor-group-container.active .codelens-decoration')?.parentElement`;
const previewPane = `() => [...document.querySelectorAll('.editor-group-container')][1]`;
const storiesPane = `() => [...document.querySelectorAll('.pane')].find(p => p.querySelector('.pane-header')?.innerText.trim().toUpperCase().startsWith('STORIES'))`;
const statusItem = `() => [...document.querySelectorAll('.statusbar-item')].find(e => /Primary|Secondary|Danger Large|Default|With long content|Small|Large|Info/.test(e.innerText))`;
const sidebar = `() => document.querySelector('.part.sidebar')`;

try {
  await ensureStorybook();
  await launch();
  console.log('Capturing…');

  await quickOpen('src/components/Button/Button.tsx');
  await storyShown('design-system-button--primary', 'Click me');
  await shot('01-open-component', { preview: await rectOf(previewPane), status: await rectOf(statusItem) });

  await quickOpen('src/components/Card/Card.tsx');
  await storyShown('components-card--default', 'Card heading');
  await shot('02-switch-card', { preview: await rectOf(previewPane) });

  await quickOpen('src/components/Avatar/Avatar.tsx');
  await storyShown('people-avatar--small', 'EL');
  await shot('03-switch-avatar', { preview: await rectOf(previewPane) });

  await quickOpen('src/components/Button/Button.tsx');
  await storyShown('design-system-button--primary', 'Click me');
  await waitFor('lenses', () => wb(`document.querySelectorAll('.editor-group-container.active .codelens-decoration a').length >= 3`));
  await sleep(1200);
  await shot('04-codelens-before', { lens: await rectOf(lensRow), dangerLens: await rectOf(lensFinder('Danger Large')) });
  await realClick(lensFinder('Danger Large'));
  await storyShown('design-system-button--danger-large', 'Delete');
  await sleep(900);
  await shot('05-codelens-after', { lens: await rectOf(lensRow), preview: await rectOf(previewPane) });

  // Stories view: expand it and pick Secondary.
  await wb(`(() => { const h = [...document.querySelectorAll('.pane-header')].find(h => h.innerText.trim().toUpperCase().startsWith('STORIES')); if (h && h.getAttribute('aria-expanded') === 'false') h.click(); })()`);
  await waitFor('stories rows', () => wb(`(${storiesPane})()?.querySelectorAll('.monaco-list-row').length >= 3`));
  await realClick(`() => [...(${storiesPane})().querySelectorAll('.monaco-list-row')].find(r => r.innerText.includes('Secondary'))`);
  await storyShown('design-system-button--secondary', 'Click me');
  await shot('06-stories-view', { stories: await rectOf(storiesPane), preview: await rectOf(previewPane) });

  // Live edit → HMR.
  await quickOpen('src/components/Button/Button.tsx');
  fs.writeFileSync(buttonFile, originalButton.replace("secondary: { background: '#e5e7eb', color: '#111827' }", "secondary: { background: '#7c3aed', color: '#fff' }"));
  await sleep(2500);
  await shot('07-live-edit', { preview: await rectOf(previewPane) });
  fs.writeFileSync(buttonFile, originalButton);
  await sleep(1500);

  // Story view in the Primary Side Bar.
  writeSettings({ 'storyVisualiser.previewTarget': 'sidebar' });
  await wb(`[...document.querySelectorAll('.tabs-container .tab')].filter(t => (t.getAttribute('aria-label') ?? '').includes('localhost:6106')).forEach(t => t.querySelector('.tab-actions .action-label')?.click())`);
  await sleep(1500);
  await quickOpen('src/components/Card/Card.tsx');
  await waitFor('story view', async () => (await targets()).some((t) => t.type === 'iframe' && t.url.includes('id=components-card--')));
  await sleep(1500);
  await shot('08-story-view-sidebar', { sidebar: await rectOf(sidebar) });

  fs.writeFileSync(path.join(here, 'public', 'shots.json'), JSON.stringify(manifest, null, 2));
  console.log(`Done: ${Object.keys(manifest.shots).length} shots in ${path.relative(process.cwd(), out)}`);
} finally {
  fs.writeFileSync(buttonFile, originalButton);
  cleanup();
}
