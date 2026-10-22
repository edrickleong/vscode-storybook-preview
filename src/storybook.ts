import type { StoryIndex } from './core/resolve';

interface CacheEntry {
  at: number;
  index: StoryIndex | undefined;
}

/** Fetches (and briefly caches) Storybook's `/index.json`. */
export class StorybookClient {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs = 2000) {}

  invalidate(): void {
    this.cache.clear();
  }

  async getIndex(baseUrl: string): Promise<StoryIndex | undefined> {
    const key = baseUrl.replace(/\/+$/, '');
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.index;

    let index: StoryIndex | undefined;
    try {
      const response = await fetch(`${key}/index.json`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const body = (await response.json()) as StoryIndex;
        if (body && typeof body.entries === 'object') index = body;
      }
    } catch {
      index = undefined;
    }
    this.cache.set(key, { at: Date.now(), index });
    return index;
  }

  async isRunning(baseUrl: string): Promise<boolean> {
    return (await this.getIndex(baseUrl)) !== undefined;
  }

  /** Polls until Storybook answers or the timeout elapses. */
  async waitUntilRunning(baseUrl: string, timeoutMs: number, token?: { isCancellationRequested: boolean }): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !token?.isCancellationRequested) {
      this.invalidate();
      if (await this.isRunning(baseUrl)) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }
}
