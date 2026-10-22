import * as path from 'path';
import { parseStoriesFile, sanitize, storyNameFromExport, toStoryId } from './csf';

/** A story entry, either from Storybook's index.json or parsed from source. */
export interface StoryRef {
  id: string;
  /** Display name, e.g. "Danger Large". */
  name: string;
  title: string;
  exportName: string;
  /** Absolute path of the stories file. */
  storiesFile: string;
  /** Zero-based line of the export, when known. */
  line?: number;
}

/** Subset of Storybook's `/index.json` (v4/v5) that we rely on. */
export interface StoryIndex {
  v: number;
  entries: Record<string, StoryIndexEntry>;
}

export interface StoryIndexEntry {
  id: string;
  type: 'story' | 'docs';
  name: string;
  title: string;
  importPath: string;
  componentPath?: string;
  exportName?: string;
  tags?: string[];
}

export interface FileSystem {
  exists(file: string): boolean;
  isDirectory(file: string): boolean;
  readFile(file: string): string | undefined;
}

export const STORIES_FILE_RE = /\.(stories|story)\.(tsx|ts|jsx|js|mjs|cjs|mdx|svelte|vue)$/i;
const STORY_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.svelte', '.vue'];
const MODULE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.vue', '.svelte'];
const NON_COMPONENT_RE = /\.(test|spec|d|stories|story|styles?|css|module|config|mock|mocks|fixture|fixtures)\.[^.]+$/i;

export function isStoriesFile(file: string): boolean {
  return STORIES_FILE_RE.test(file);
}

export function isCandidateComponent(file: string, extensions: string[]): boolean {
  const ext = path.extname(file).toLowerCase();
  if (!extensions.map((e) => e.toLowerCase()).includes(ext)) return false;
  if (NON_COMPONENT_RE.test(path.basename(file))) return false;
  return !file.split(/[\\/]/).includes('node_modules');
}

/** Normalises a path for comparison (forward slashes, case-insensitive on macOS/Windows). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/');
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
  return caseInsensitive ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** Walks up from `file` to the directory containing `.storybook`. */
export function findStorybookRoot(file: string, fs: FileSystem, stopAt?: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.isDirectory(path.join(dir, '.storybook'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || (stopAt && samePath(dir, stopAt))) return undefined;
    dir = parent;
  }
}

/** Conventional stories locations for a component, most likely first. */
export function storyFileCandidates(componentFile: string): string[] {
  const dir = path.dirname(componentFile);
  const base = path.basename(componentFile, path.extname(componentFile));
  const names = base === 'index' ? [path.basename(dir), 'index'] : [base];
  const dirs = [dir, path.join(dir, '__stories__'), path.join(dir, 'stories'), path.join(dir, '..', 'stories')];

  const candidates: string[] = [];
  for (const d of dirs) {
    for (const name of names) {
      for (const kind of ['stories', 'story']) {
        for (const ext of STORY_EXTENSIONS) candidates.push(path.join(d, `${name}.${kind}${ext}`));
      }
    }
  }
  return candidates;
}

/** Resolves a relative import specifier to an existing file, like a bundler would. */
export function resolveImport(fromFile: string, specifier: string, fs: FileSystem): string | undefined {
  const target = path.resolve(path.dirname(fromFile), specifier);
  const attempts = [
    target,
    ...MODULE_EXTENSIONS.map((ext) => target + ext),
    ...MODULE_EXTENSIONS.map((ext) => path.join(target, `index${ext}`)),
  ];
  // Handle TS-style `./Button.js` imports that point at `Button.tsx`.
  const ext = path.extname(target);
  if (ext) {
    const stem = target.slice(0, -ext.length);
    attempts.push(...MODULE_EXTENSIONS.map((e) => stem + e));
  }
  return attempts.find((p) => fs.exists(p) && !fs.isDirectory(p));
}

export interface StoriesSpecifier {
  /** Absolute directory the glob is rooted at. */
  directory: string;
  titlePrefix: string;
}

/** Extracts the static directory part of each `stories` glob in `.storybook/main.*`. */
export function storiesSpecifiersFromMain(mainSource: string, configDir: string): StoriesSpecifier[] {
  const specifiers: StoriesSpecifier[] = [];
  const block = /stories\s*:\s*\[([\s\S]*?)\]\s*,?\s*\n/.exec(mainSource)?.[1] ?? '';

  const objectRe = /\{([^{}]*)\}/g;
  for (let m = objectRe.exec(block); m; m = objectRe.exec(block)) {
    const directory = /directory\s*:\s*['"`]([^'"`]+)['"`]/.exec(m[1])?.[1];
    const titlePrefix = /titlePrefix\s*:\s*['"`]([^'"`]*)['"`]/.exec(m[1])?.[1] ?? '';
    if (directory) specifiers.push({ directory: path.resolve(configDir, directory), titlePrefix });
  }

  const withoutObjects = block.replace(objectRe, '');
  const stringRe = /['"`]([^'"`]+)['"`]/g;
  for (let m = stringRe.exec(withoutObjects); m; m = stringRe.exec(withoutObjects)) {
    const glob = m[1];
    const staticPart = glob.split('/').filter((_, i, parts) => !parts.slice(0, i + 1).some((p) => /[*{}()[\]!?@+]/.test(p)));
    specifiers.push({ directory: path.resolve(configDir, staticPart.join('/') || '.'), titlePrefix: '' });
  }
  return specifiers;
}

/** Approximates Storybook's auto-title for a stories file without an explicit title. */
export function autoTitle(storiesFile: string, specifiers: StoriesSpecifier[]): string | undefined {
  const specifier = specifiers
    .filter((s) => {
      const rel = path.relative(s.directory, storiesFile);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    })
    .sort((a, b) => b.directory.length - a.directory.length)[0];
  if (!specifier) return undefined;

  const parts = path.relative(specifier.directory, storiesFile).split(/[\\/]+/);
  parts[parts.length - 1] = parts[parts.length - 1].replace(/(\.(stories|story))?\.[^.]+$/i, '');
  if (parts.length > 1 && parts[parts.length - 1] === 'index') parts.pop();
  if (parts.length > 1 && parts[parts.length - 1].toLowerCase() === parts[parts.length - 2].toLowerCase()) parts.pop();

  return [specifier.titlePrefix, ...parts].filter(Boolean).join('/');
}

/** Stories for a stories file, taken from source (no running Storybook needed). */
export function storiesFromSource(
  storiesFile: string,
  source: string,
  specifiers: StoriesSpecifier[],
): StoryRef[] {
  const parsed = parseStoriesFile(source);
  const title = parsed.title ?? autoTitle(storiesFile, specifiers);
  if (!title && !parsed.metaId) return [];
  return parsed.stories.map((story) => ({
    id: toStoryId(parsed.metaId ?? title!, story.exportName),
    name: storyNameFromExport(story.exportName),
    title: title ?? parsed.metaId!,
    exportName: story.exportName,
    storiesFile,
    line: story.line,
  }));
}

function fromIndexEntry(entry: StoryIndexEntry, root: string): StoryRef {
  return {
    id: entry.id,
    name: entry.name,
    title: entry.title,
    exportName: entry.exportName ?? entry.id.split('--')[1] ?? entry.name,
    storiesFile: path.resolve(root, entry.importPath),
  };
}

function storyEntries(index: StoryIndex): StoryIndexEntry[] {
  return Object.values(index.entries).filter((e) => e.type === 'story');
}

/** Stories whose `component` resolves to `componentFile` (Storybook 9+ populates componentPath). */
export function storiesForComponentFromIndex(index: StoryIndex, root: string, componentFile: string): StoryRef[] {
  return storyEntries(index)
    .filter((e) => e.componentPath && samePath(path.resolve(root, e.componentPath), componentFile))
    .map((e) => fromIndexEntry(e, root));
}

export function storiesForFileFromIndex(index: StoryIndex, root: string, storiesFile: string): StoryRef[] {
  return storyEntries(index)
    .filter((e) => samePath(path.resolve(root, e.importPath), storiesFile))
    .map((e) => fromIndexEntry(e, root));
}

/** Adds source line numbers to stories (index.json doesn't carry them). */
export function withLines(stories: StoryRef[], fs: FileSystem): StoryRef[] {
  const cache = new Map<string, ReturnType<typeof parseStoriesFile> | undefined>();
  return stories.map((story) => {
    if (story.line !== undefined) return story;
    if (!cache.has(story.storiesFile)) {
      const source = fs.readFile(story.storiesFile);
      cache.set(story.storiesFile, source === undefined ? undefined : parseStoriesFile(source));
    }
    const line = cache.get(story.storiesFile)?.stories.find((s) => s.exportName === story.exportName)?.line;
    return { ...story, line };
  });
}

/** Is `componentFile` the `component` of the stories file's default export? */
export function storiesFileTargetsComponent(storiesFile: string, componentFile: string, fs: FileSystem): boolean {
  const source = fs.readFile(storiesFile);
  if (!source) return false;
  const spec = parseStoriesFile(source).componentImport;
  if (!spec || !spec.startsWith('.')) return false;
  const resolved = resolveImport(storiesFile, spec, fs);
  return resolved !== undefined && samePath(resolved, componentFile);
}

export function storyUrl(
  baseUrl: string,
  storyId: string,
  viewMode: 'canvas' | 'storybook',
): string {
  const base = baseUrl.replace(/\/+$/, '');
  return viewMode === 'canvas'
    ? `${base}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`
    : `${base}/?path=/story/${encodeURIComponent(storyId)}`;
}

export { sanitize };
