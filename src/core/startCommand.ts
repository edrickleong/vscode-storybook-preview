import * as fs from 'fs';
import * as path from 'path';

/** Picks the project's own Storybook script, falling back to `npx storybook dev`. */
export function detectStartCommand(root: string, baseUrl: string): string {
  const has = (name: string) => fs.existsSync(path.join(root, name));
  const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun run' : 'npm run';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const script =
      ('storybook' in scripts && 'storybook') ||
      Object.keys(scripts).find((name) => /storybook dev|start-storybook/.test(scripts[name]));
    if (script) return `${runner} ${script}`;
  } catch {
    // No package.json: fall through.
  }
  const port = new URL(baseUrl).port || '6006';
  return `npx storybook dev -p ${port} --no-open`;
}
