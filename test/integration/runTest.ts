import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const INSTALLED_VSCODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  // Use a short user-data-dir: macOS limits IPC socket paths to 103 chars.
  const userDataDir = fs.mkdtempSync('/tmp/sv-it-');
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'User', 'settings.json'),
    JSON.stringify({ 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'chat.disableAIFeatures': true }),
  );

  await runTests({
    // Prefer the locally installed VS Code (it ships the integrated browser); otherwise download stable.
    vscodeExecutablePath: process.env.VSCODE_PATH ?? (fs.existsSync(INSTALLED_VSCODE) ? INSTALLED_VSCODE : undefined),
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, './suite'),
    launchArgs: [path.join(root, 'sample'), '--disable-extensions', '--user-data-dir', userDataDir, '--skip-welcome', '--skip-release-notes'],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
