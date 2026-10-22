import * as vscode from 'vscode';
import type { StoryRef } from '../core/resolve';

export interface ShowRequest {
  url: string;
  story: StoryRef;
  /** All stories available for the current file (for pickers). */
  stories: StoryRef[];
  /** Open the preview if it isn't already open. */
  reveal: boolean;
  /** Keep keyboard focus in the text editor. */
  preserveFocus: boolean;
  /** The user asked for this story (Show Story, CodeLens, Stories view…) rather than auto-sync. */
  explicit: boolean;
}

export interface PreviewTarget extends vscode.Disposable {
  readonly id: 'integratedBrowser' | 'webview' | 'sidebar' | 'simpleBrowser' | 'external';
  /** Whether a preview is currently showing (and can be navigated in place). */
  isOpen(): boolean;
  show(request: ShowRequest): Promise<void>;
  /** Show a message instead of a story (e.g. "no story" / "Storybook offline"). */
  showMessage?(message: string, actions?: { label: string; command: string }[]): void;
  readonly onDidClose: vscode.Event<void>;
  /** The user picked a different story from inside the preview. */
  readonly onDidSelectStory?: vscode.Event<string>;
  readonly onDidRequestCommand?: vscode.Event<string>;
}

/** Re-focus the editor a preview command may have stolen focus from. */
export async function restoreEditorFocus(editor: vscode.TextEditor | undefined): Promise<void> {
  if (!editor || editor.document.isClosed) return;
  await vscode.window.showTextDocument(editor.document, {
    viewColumn: editor.viewColumn,
    preserveFocus: false,
    selection: editor.selection,
  });
}
