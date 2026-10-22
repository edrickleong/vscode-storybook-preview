import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { componentDeclarationLine, parseStoriesFile, sanitize, storyAtLine, storyNameFromExport, toStoryId } from '../../src/core/csf';
import {
  FileSystem,
  StoryIndex,
  autoTitle,
  findStorybookRoot,
  isCandidateComponent,
  isStoriesFile,
  resolveImport,
  storiesForComponentFromIndex,
  storiesForFileFromIndex,
  storiesFileTargetsComponent,
  storiesFromSource,
  storiesSpecifiersFromMain,
  storyFileCandidates,
  storyUrl,
  withLines,
} from '../../src/core/resolve';
import { detectStartCommand } from '../../src/core/startCommand';

const sample = path.resolve(__dirname, '../../../sample');
const nodeFs: FileSystem = {
  exists: (f) => fs.existsSync(f),
  isDirectory: (f) => fs.existsSync(f) && fs.statSync(f).isDirectory(),
  readFile: (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined),
};
const specifiers = () => storiesSpecifiersFromMain(fs.readFileSync(path.join(sample, '.storybook/main.ts'), 'utf8'), path.join(sample, '.storybook'));

/** Snapshot of Storybook 10's index.json for the sample project. */
const index: StoryIndex = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../test/fixtures/index.json'), 'utf8'));

describe('csf', () => {
  it('sanitizes like Storybook', () => {
    assert.strictEqual(sanitize('Design System/Button'), 'design-system-button');
    assert.strictEqual(sanitize('  Hello, World!  '), 'hello-world');
  });

  it('derives story names from export names', () => {
    assert.strictEqual(storyNameFromExport('DangerLarge'), 'Danger Large');
    assert.strictEqual(storyNameFromExport('primary'), 'Primary');
    assert.strictEqual(storyNameFromExport('WithURLParams'), 'With URL Params');
    assert.strictEqual(storyNameFromExport('with_underscores'), 'With Underscores');
  });

  it('builds story ids', () => {
    assert.strictEqual(toStoryId('Design System/Button', 'DangerLarge'), 'design-system-button--danger-large');
  });

  it('parses a meta variable, exports and component import', () => {
    const parsed = parseStoriesFile(fs.readFileSync(path.join(sample, 'src/components/Button/Button.stories.tsx'), 'utf8'));
    assert.strictEqual(parsed.title, 'Design System/Button');
    assert.deepStrictEqual(parsed.stories.map((s) => s.exportName), ['Primary', 'Secondary', 'DangerLarge']);
    assert.strictEqual(parsed.componentIdentifier, 'Button');
    assert.strictEqual(parsed.componentImport, './Button');
    assert.ok(parsed.stories[0].line > 0);
  });

  it('parses an inline default export', () => {
    const parsed = parseStoriesFile(`import { Badge } from '.';\nexport default { title: "A/B", component: Badge };\nexport const One = {};\nexport const __namedExportsOrder = [];`);
    assert.strictEqual(parsed.title, 'A/B');
    assert.strictEqual(parsed.componentImport, '.');
    assert.deepStrictEqual(parsed.stories.map((s) => s.exportName), ['One']);
  });

  it('handles aliased imports, meta id and missing title', () => {
    const parsed = parseStoriesFile(`import { Button as Btn } from '../Button';\nconst meta = { id: 'custom-id', component: Btn };\nexport default meta;\nexport const X = {};`);
    assert.strictEqual(parsed.title, undefined);
    assert.strictEqual(parsed.metaId, 'custom-id');
    assert.strictEqual(parsed.componentImport, '../Button');
  });

  it('finds the story under the cursor', () => {
    const stories = [{ exportName: 'A', line: 5 }, { exportName: 'B', line: 10 }];
    assert.strictEqual(storyAtLine(stories, 2), undefined);
    assert.strictEqual(storyAtLine(stories, 7)?.exportName, 'A');
    assert.strictEqual(storyAtLine(stories, 12)?.exportName, 'B');
  });
});

describe('componentDeclarationLine', () => {
  it('anchors on the export named like the component', () => {
    const src = `import x from 'y';\nexport const helper = 1;\nexport interface ButtonProps {}\nexport function Button() {}\n`;
    assert.strictEqual(componentDeclarationLine(src, ['Button']), 3);
  });
  it('falls back to the first PascalCase export or default export', () => {
    assert.strictEqual(componentDeclarationLine(`const a = 1;\nexport const Thing = () => null;`, ['Other']), 1);
    assert.strictEqual(componentDeclarationLine(`const a = 1;\n\nexport default function () {}`, ['Other']), 2);
    assert.strictEqual(componentDeclarationLine(`export default async function Page() {}`, ['page']), 0);
  });
  it('anchors single-file components on their script block', () => {
    assert.strictEqual(componentDeclarationLine(`<!-- c -->\n<script setup lang="ts">\nconst a = 1\n</script>`, ['X']), 1);
  });
  it('works on the sample Button', () => {
    const src = fs.readFileSync(path.join(sample, 'src/components/Button/Button.tsx'), 'utf8');
    assert.match(src.split('\n')[componentDeclarationLine(src, ['Button'])], /export function Button/);
  });
});

describe('file classification', () => {
  const exts = ['.tsx', '.jsx', '.vue', '.svelte', '.ts', '.js'];
  it('recognises stories files', () => {
    assert.ok(isStoriesFile('/a/Button.stories.tsx'));
    assert.ok(isStoriesFile('/a/Button.story.js'));
    assert.ok(!isStoriesFile('/a/Button.tsx'));
  });
  it('recognises candidate components', () => {
    assert.ok(isCandidateComponent('/a/Button.tsx', exts));
    assert.ok(isCandidateComponent('/a/Button.vue', exts));
    assert.ok(!isCandidateComponent('/a/Button.test.tsx', exts));
    assert.ok(!isCandidateComponent('/a/Button.stories.tsx', exts));
    assert.ok(!isCandidateComponent('/a/types.d.ts', exts));
    assert.ok(!isCandidateComponent('/a/node_modules/x/Button.tsx', exts));
    assert.ok(!isCandidateComponent('/a/data.json', exts));
  });
});

describe('resolution against the sample project', () => {
  const button = path.join(sample, 'src/components/Button/Button.tsx');
  const badge = path.join(sample, 'src/components/Badge/index.tsx');
  const avatar = path.join(sample, 'src/components/Avatar/Avatar.tsx');
  const card = path.join(sample, 'src/components/Card/Card.tsx');

  it('finds the storybook root', () => {
    assert.strictEqual(findStorybookRoot(button, nodeFs), sample);
  });

  it('finds sibling stories files, including for index files', () => {
    assert.ok(storyFileCandidates(button).includes(path.join(sample, 'src/components/Button/Button.stories.tsx')));
    assert.ok(storyFileCandidates(badge).includes(path.join(sample, 'src/components/Badge/Badge.stories.tsx')));
  });

  it('resolves relative imports like a bundler', () => {
    const stories = path.join(sample, 'src/stories/UserAvatar.stories.tsx');
    assert.strictEqual(resolveImport(stories, '../components/Avatar/Avatar', nodeFs), avatar);
    assert.strictEqual(resolveImport(path.join(sample, 'src/components/Badge/Badge.stories.tsx'), '.', nodeFs), badge);
    assert.strictEqual(resolveImport(stories, '../components/Avatar/Avatar.js', nodeFs), avatar);
  });

  it('detects the component a stories file targets', () => {
    const stories = path.join(sample, 'src/stories/UserAvatar.stories.tsx');
    assert.ok(storiesFileTargetsComponent(stories, avatar, nodeFs));
    assert.ok(!storiesFileTargetsComponent(stories, button, nodeFs));
  });

  it('reads the stories globs from main.ts', () => {
    assert.deepStrictEqual(specifiers(), [{ directory: path.join(sample, 'src'), titlePrefix: '' }]);
    assert.deepStrictEqual(
      storiesSpecifiersFromMain(`export default { stories: [{ directory: '../lib', titlePrefix: 'Lib' }, '../app/**/*.mdx'],\n}`, '/p/.storybook'),
      [{ directory: '/p/lib', titlePrefix: 'Lib' }, { directory: '/p/app', titlePrefix: '' }],
    );
  });

  it('computes auto titles like Storybook', () => {
    assert.strictEqual(autoTitle(path.join(sample, 'src/components/Card/Card.stories.tsx'), specifiers()), 'components/Card');
  });

  it('source-derived ids match the live Storybook index for every story', () => {
    const files = [...new Set(Object.values(index.entries).map((e) => path.resolve(sample, e.importPath)))];
    for (const file of files) {
      const fromSource = storiesFromSource(file, fs.readFileSync(file, 'utf8'), specifiers()).map((s) => s.id).sort();
      const fromIndex = storiesForFileFromIndex(index, sample, file).map((s) => s.id).sort();
      assert.deepStrictEqual(fromSource, fromIndex, file);
    }
  });

  it('maps components to stories using componentPath', () => {
    assert.deepStrictEqual(storiesForComponentFromIndex(index, sample, button).map((s) => s.id), [
      'design-system-button--primary',
      'design-system-button--secondary',
      'design-system-button--danger-large',
    ]);
    assert.deepStrictEqual(storiesForComponentFromIndex(index, sample, avatar).map((s) => s.id), ['people-avatar--small', 'people-avatar--large']);
    assert.deepStrictEqual(storiesForComponentFromIndex(index, sample, card).map((s) => s.name), ['Default', 'With long content']);
  });

  it('adds line numbers to index stories', () => {
    const stories = withLines(storiesForComponentFromIndex(index, sample, button), nodeFs);
    const source = fs.readFileSync(path.join(sample, 'src/components/Button/Button.stories.tsx'), 'utf8').split('\n');
    for (const story of stories) assert.match(source[story.line!], new RegExp(`export const ${story.exportName}\\b`));
  });
});

describe('urls and start command', () => {
  it('builds canvas and full-UI urls', () => {
    assert.strictEqual(storyUrl('http://localhost:6006/', 'a--b', 'canvas'), 'http://localhost:6006/iframe.html?id=a--b&viewMode=story');
    assert.strictEqual(storyUrl('http://localhost:6006', 'a--b', 'storybook'), 'http://localhost:6006/?path=/story/a--b');
  });

  it('detects the start command from package.json and lockfiles', () => {
    assert.strictEqual(detectStartCommand(sample, 'http://localhost:6006'), 'npm run storybook');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { sb: 'storybook dev -p 7007' } }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    assert.strictEqual(detectStartCommand(dir, 'http://localhost:7007'), 'pnpm sb');
    fs.rmSync(path.join(dir, 'package.json'));
    assert.strictEqual(detectStartCommand(dir, 'http://localhost:7007'), 'npx storybook dev -p 7007 --no-open');
  });
});
