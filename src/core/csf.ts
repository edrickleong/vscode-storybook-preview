/**
 * Lightweight, dependency-free parsing of Component Story Format (CSF) files.
 *
 * This is used as a fallback when Storybook's index.json is unavailable, and to
 * map a cursor position in a stories file to the story export under it.
 */

export interface ParsedStoryExport {
  exportName: string;
  /** Zero-based line of the `export const X` declaration. */
  line: number;
}

export interface ParsedStoriesFile {
  title?: string;
  /** Explicit `id` on the default export (overrides the title-derived prefix). */
  metaId?: string;
  stories: ParsedStoryExport[];
  /** Relative module specifiers imported by the file. */
  relativeImports: string[];
  /** The identifier used as `component:` in the default export, if any. */
  componentIdentifier?: string;
  /** Module specifier that `componentIdentifier` is imported from. */
  componentImport?: string;
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/.source;

/** Mirrors Storybook's `sanitize` from `storybook/internal/csf`. */
export function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/** Mirrors lodash-style `startCase`, which Storybook uses for export → story name. */
export function storyNameFromExport(exportName: string): string {
  return exportName
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-\s]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function toStoryId(titleOrMetaId: string, exportName: string): string {
  return `${sanitize(titleOrMetaId)}--${sanitize(storyNameFromExport(exportName))}`;
}

/** Returns the text of the `{ … }` block starting at `openIndex`, or undefined. */
function extractBraces(source: string, openIndex: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(openIndex, i + 1);
  }
  return undefined;
}

function findMetaObject(source: string): string | undefined {
  const inline = /export\s+default\s*\{/.exec(source);
  if (inline) return extractBraces(source, inline.index + inline[0].length - 1);

  const byName = new RegExp(`export\\s+default\\s+(${IDENTIFIER})`).exec(source);
  if (!byName) return undefined;
  const decl = new RegExp(`(?:const|let|var)\\s+${byName[1]}\\b[^=]*=\\s*(?:[\\w$.]+\\s*\\(\\s*)?\\{`).exec(source);
  if (!decl) return undefined;
  return extractBraces(source, decl.index + decl[0].length - 1);
}

function stringProperty(objectText: string, key: string): string | undefined {
  // Only look at top-level-ish properties: good enough for `title` and `id`.
  const match = new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(objectText);
  return match?.[2];
}

export function parseStoriesFile(source: string): ParsedStoriesFile {
  const meta = findMetaObject(source);
  const title = meta ? stringProperty(meta, 'title') : undefined;
  const metaId = meta ? stringProperty(meta, 'id') : undefined;

  const stories: ParsedStoryExport[] = [];
  const exportRe = new RegExp(`^\\s*export\\s+(?:const|let|var|function)\\s+(${IDENTIFIER})`, 'gm');
  for (let match = exportRe.exec(source); match; match = exportRe.exec(source)) {
    const exportName = match[1];
    if (exportName.startsWith('__')) continue;
    const line = source.slice(0, match.index + match[0].indexOf('export')).split('\n').length - 1;
    stories.push({ exportName, line });
  }

  const relativeImports: string[] = [];
  const importRe = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/?[^'"]*)['"]|import\(\s*['"](\.{1,2}\/?[^'"]*)['"]\s*\)/g;
  for (let match = importRe.exec(source); match; match = importRe.exec(source)) {
    relativeImports.push(match[1] ?? match[2]);
  }

  const componentIdentifier = meta
    ? new RegExp(`(?:^|[,{\\s])component\\s*:\\s*(${IDENTIFIER})`).exec(meta)?.[1]
    : undefined;
  const componentImport = componentIdentifier ? importSourceOf(source, componentIdentifier) : undefined;

  return { title, metaId, stories, relativeImports, componentIdentifier, componentImport };
}

/** Finds the module an identifier is imported from (default, named or aliased). */
export function importSourceOf(source: string, identifier: string): string | undefined {
  const importRe = /import\s+(?:type\s+)?([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g;
  for (let match = importRe.exec(source); match; match = importRe.exec(source)) {
    const clause = match[1];
    const names = clause
      .replace(/[{}]/g, ',')
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/).pop()!.replace(/^\*\s+as\s+/, '').trim())
      .filter(Boolean);
    if (names.includes(identifier)) return match[2];
  }
  return undefined;
}

/** The story export whose declaration is at or above `line` (closest one wins). */
export function storyAtLine(stories: ParsedStoryExport[], line: number): ParsedStoryExport | undefined {
  let best: ParsedStoryExport | undefined;
  for (const story of stories) {
    if (story.line <= line && (!best || story.line > best.line)) best = story;
  }
  return best;
}

/**
 * Zero-based line where a component is declared, used to anchor CodeLens.
 * Prefers an exported declaration named like one of `names`, then any exported
 * PascalCase declaration or default export, then the top of the file.
 */
export function componentDeclarationLine(source: string, names: string[]): number {
  const lines = source.split('\n');
  const declaration = new RegExp(
    `^\\s*export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var)\\s+(${IDENTIFIER})`,
  );
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  let fallback: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const match = declaration.exec(lines[i]);
    if (match) {
      if (wanted.has(match[1].toLowerCase())) return i;
      if (fallback === undefined && /^[A-Z]/.test(match[1])) fallback = i;
    } else if (fallback === undefined && /^\s*export\s+default\b/.test(lines[i])) {
      fallback = i;
    }
  }
  if (fallback !== undefined) return fallback;
  // Vue/Svelte single-file components: anchor on the <script> or <template> tag.
  const sfc = lines.findIndex((line) => /^\s*<(script|template)\b/.test(line));
  return sfc >= 0 ? sfc : 0;
}
