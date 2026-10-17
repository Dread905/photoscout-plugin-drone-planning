import type { OpenAipKv } from '../src/server/openaip.js';

/** An in-memory stand-in for the plugin's SQLite cache. */
export function memoryKv(): OpenAipKv & { size(): number; keys(): string[] } {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    size: () => values.size,
    keys: () => [...values.keys()],
  };
}
