# Changelog

## 0.2.0

- **Story view**: preview stories in the Primary Side Bar (`"storyVisualiser.previewTarget": "sidebar"`), movable to the Secondary Side Bar or the Panel with **Move Story Preview…**. It reveals itself only the first time, then updates in the background. The old `"panel"` value still works.
- Preview toolbars use VS Code's own codicons, with previous and next story buttons.
- The integrated browser only reuses tabs the extension opened. Your own tabs, including your own Storybook tabs, are never navigated. New previews always open in the browser side group.
- CodeLens with story links above components, and a "Preview" link above each story export.
- **Stories** view in the Explorer, and next/previous story commands (`Ctrl+Alt+]` / `Ctrl+Alt+[`).
- Picking a story from the preview's dropdown never moves your cursor or focus. In a stories file, the cursor only switches the story when you move into a different `export`, so a small move no longer undoes your pick.
- The preview toolbar's refresh icon now matches its neighbours in size, and "Open story source" uses a code-file icon, with the file name in the tooltip.
- Fixed: a quick click right after opening a file could be overridden by the file's sync.
- Fixed: overlapping syncs could open two preview tabs.
- New icon.

## 0.1.0

- First release: open a component's story beside it automatically, keep it in sync as you switch files and move the cursor, with integrated browser, webview, Simple Browser and external targets.
