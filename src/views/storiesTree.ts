import * as path from 'path';
import * as vscode from 'vscode';
import type { StoryRef } from '../core/resolve';
import type { StoryController } from '../controller';

export class StoryItem extends vscode.TreeItem {
  constructor(
    readonly story: StoryRef,
    readonly sourceFile: string,
    current: boolean,
  ) {
    super(story.name, vscode.TreeItemCollapsibleState.None);
    this.id = story.id;
    this.description = current ? 'previewing' : undefined;
    this.iconPath = new vscode.ThemeIcon(current ? 'eye' : 'circle-outline');
    this.tooltip = new vscode.MarkdownString(`**${story.title} › ${story.name}**\n\n\`${story.id}\`\n\n${path.basename(story.storiesFile)}`);
    this.contextValue = 'story';
    this.command = { command: 'storyVisualiser.showStoryById', title: 'Preview Story', arguments: [story.id, sourceFile] };
    this.accessibilityInformation = { label: `${story.title} ${story.name}${current ? ', previewing' : ''}` };
  }
}

class GroupItem extends vscode.TreeItem {
  constructor(readonly storiesFile: string, readonly stories: StoryItem[]) {
    super(path.basename(storiesFile), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `group:${storiesFile}`;
    this.resourceUri = vscode.Uri.file(storiesFile);
    this.iconPath = vscode.ThemeIcon.File;
  }
}

/** Explorer view listing the stories of the active component (an "outline" for stories). */
export class StoriesTreeProvider implements vscode.TreeDataProvider<StoryItem | GroupItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  readonly view: vscode.TreeView<StoryItem | GroupItem>;
  private readonly disposables: vscode.Disposable[] = [this.changeEmitter];

  constructor(private readonly controller: StoryController) {
    this.view = vscode.window.createTreeView('storyVisualiser.stories', { treeDataProvider: this, showCollapseAll: false });
    this.disposables.push(
      this.view,
      controller.onDidChange(() => {
        this.refreshDescription();
        this.changeEmitter.fire();
      }),
    );
    this.refreshDescription();
  }

  private refreshDescription(): void {
    const { resolution } = this.controller.state;
    this.view.description = resolution ? path.basename(resolution.file) : undefined;
  }

  getTreeItem(element: StoryItem | GroupItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: StoryItem | GroupItem): (StoryItem | GroupItem)[] {
    if (element instanceof GroupItem) return element.stories;
    if (element) return [];
    const { resolution, story } = this.controller.state;
    if (!resolution) return [];

    const items = resolution.stories.map((s) => new StoryItem(s, resolution.file, s.id === story?.id));
    const files = [...new Set(resolution.stories.map((s) => s.storiesFile))];
    if (files.length === 1) return items;
    return files.map((file) => new GroupItem(file, items.filter((item) => item.story.storiesFile === file)));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
