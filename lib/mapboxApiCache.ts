/**
 * Tiny bounded LRU for Mapbox JSON responses (server-side proxy).
 */

const DEFAULT_MAX = 256;

export class LruJsonCache<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly maxEntries = DEFAULT_MAX) {}

  get(key: string): T | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const first = this.map.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }
}
