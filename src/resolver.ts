import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FileSystem,
  StoryRef,
  findStorybookRoot,
  isCandidateComponent,
  isStoriesFile,
  samePath,
  storiesForComponentFromIndex,
  storiesForFileFromIndex,
  storiesFromSource,
  storiesFileTargetsComponent,
  storiesSpecifiersFromMain,
  storyFileCandidates,
  withLines,
} from './core/resolve';
import { StorybookClient } from './storybook';

export interface Resolution {
  kind: 'component' | 'stories';
  file: string;
  stories: StoryRef[];
  /** Where the stories came from: the live Storybook index, or parsed source. */
  source: 'index' | 'source';
  storybookRoot?: string;
}

export const nodeFs: FileSystem = {
  exists: (file) => fs.existsSync(file),
  isDirectory: (file) => {
    try {
      return fs.statSync(file).isDirectory();
    } catch {
      return false;
    }
  },
  readFile: (file) => {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, file));
    if (open) return open.getText();
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
};

export function storybookUrlFor(file?: string): string {
  const scope = file ? vscode.Uri.file(file) : undefined;
  return vscode.workspace.getConfiguration('storyVisualiser', scope).get<string>('storybookUrl', 'http://localhost:6006');
}

/** Maps component and stories files to the Storybook stories that render them. */
export class StoryResolver implements vscode.Disposable {
  private storiesFiles: Promise<string[]> | undefined;
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(private readonly client: StorybookClient) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{stories,story}.{ts,tsx,js,jsx,mjs,mdx,svelte,vue}');
    const reset = () => {
      this.storiesFiles = undefined;
      this.client.invalidate();
    };
    this.watcher.onDidCreate(reset);
    this.watcher.onDidDelete(reset);
    this.watcher.onDidChange(() => this.client.invalidate());
  }

  dispose(): void {
    this.watcher.dispose();
  }

  isRelevantFile(file: string): boolean {
    const extensions = vscode.workspace
      .getConfiguration('storyVisualiser')
      .get<string[]>('componentExtensions', ['.tsx', '.jsx', '.vue', '.svelte', '.ts', '.js']);
    return isStoriesFile(file) || isCandidateComponent(file, extensions);
  }

  async resolve(file: string): Promise<Resolution | undefined> {
    if (!this.isRelevantFile(file)) return undefined;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath;
    const root = findStorybookRoot(file, nodeFs, workspaceFolder ? path.dirname(workspaceFolder) : undefined);
    const index = await this.client.getIndex(storybookUrlFor(file));

    if (isStoriesFile(file)) {
      const stories = index && root ? storiesForFileFromIndex(index, root, file) : [];
      if (stories.length) return { kind: 'stories', file, stories: withLines(stories, nodeFs), source: 'index', storybookRoot: root };
      const fromSource = this.fromSource(file, root);
      return fromSource.length ? { kind: 'stories', file, stories: fromSource, source: 'source', storybookRoot: root } : undefined;
    }

    // 1. Storybook 9+ tells us exactly which component each story renders.
    if (index && root) {
      const stories = storiesForComponentFromIndex(index, root, file);
      if (stories.length) return { kind: 'component', file, stories: withLines(stories, nodeFs), source: 'index', storybookRoot: root };
    }

    // 2. Conventional sibling files, then 3. any stories file whose `component` imports this file.
    let storyFiles = storyFileCandidates(file).filter((candidate) => nodeFs.exists(candidate));
    if (!storyFiles.length) {
      storyFiles = (await this.allStoriesFiles()).filter((candidate) => storiesFileTargetsComponent(candidate, file, nodeFs));
    }
    if (!storyFiles.length) return undefined;

    const stories: StoryRef[] = [];
    let source: Resolution['source'] = 'source';
    for (const storiesFile of storyFiles) {
      const fromIndex = index && root ? storiesForFileFromIndex(index, root, storiesFile) : [];
      if (fromIndex.length) {
        source = 'index';
        stories.push(...withLines(fromIndex, nodeFs));
      } else {
        stories.push(...this.fromSource(storiesFile, root));
      }
    }
    return stories.length ? { kind: 'component', file, stories, source, storybookRoot: root } : undefined;
  }

  private fromSource(storiesFile: string, root: string | undefined): StoryRef[] {
    const source = nodeFs.readFile(storiesFile);
    if (source === undefined) return [];
    return storiesFromSource(storiesFile, source, root ? this.specifiers(root) : []);
  }

  private specifiers(root: string) {
    const configDir = path.join(root, '.storybook');
    for (const name of ['main.ts', 'main.js', 'main.mjs', 'main.cjs', 'main.mts', 'main.cts']) {
      const source = nodeFs.readFile(path.join(configDir, name));
      if (source) return storiesSpecifiersFromMain(source, configDir);
    }
    return [];
  }

  private allStoriesFiles(): Promise<string[]> {
    this.storiesFiles ??= Promise.resolve(
      vscode.workspace.findFiles('**/*.{stories,story}.{ts,tsx,js,jsx,mjs,svelte,vue}', '**/node_modules/**', 2000),
    ).then((uris) => uris.map((uri) => uri.fsPath));
    return this.storiesFiles;
  }
}
