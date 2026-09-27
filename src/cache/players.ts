/**
 * On-disk cache for Sleeper's player index.
 *
 * The full player map is roughly 5MB of JSON and Sleeper asks callers to fetch it
 * at most once a day. Roster and transaction payloads reference players only by
 * numeric id, so without this cache every command would pull 5MB just to print a
 * name.
 *
 * The cache is a plain JSON file under the cache directory. It is deliberately not
 * treated as authoritative: a stale entry is always better than a failed command,
 * and `--refresh` exists for when freshness actually matters.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { CACHE_DIR, PLAYER_CACHE_FILE } from '../config/paths.js';
import type { Player } from '../core/types.js';

interface CacheEnvelope {
  /** Epoch milliseconds when the payload was fetched. */
  fetched_at: number;
  sport: string;
  /** `true` when fetched with `active=true`; such an entry cannot serve a full query. */
  active_only: boolean;
  players: Record<string, Player>;
}

/** Sensible default lifetime, matching Sleeper's own once-a-day guidance. */
export const DEFAULT_TTL_HOURS = 20;

export interface PlayerCacheOptions {
  filePath?: string;
  ttlHours?: number;
  /** Injected for tests so TTL behaviour is deterministic. */
  now?: () => number;
}

export class PlayerCache {
  readonly #filePath: string;
  readonly #ttlMs: number;
  readonly #now: () => number;
  /** In-process memo, so one invocation does not re-read the file per lookup. */
  #memo: Record<string, Player> | null = null;

  constructor(options: PlayerCacheOptions = {}) {
    const hours =
      typeof options.ttlHours === 'number' && options.ttlHours > 0
        ? options.ttlHours
        : DEFAULT_TTL_HOURS;
    this.#filePath = options.filePath ?? PLAYER_CACHE_FILE;
    this.#ttlMs = hours * 3_600_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Read the cache, honouring its filter and the configured TTL.
   *
   * Returns undefined when there is nothing usable, which tells the caller to fetch
   * fresh rather than to fail.
   */
  read(sport = 'nfl'): Record<string, Player> | undefined {
    if (this.#memo) return this.#memo;
    if (!existsSync(this.#filePath)) return undefined;

    let envelope: CacheEnvelope;
    try {
      envelope = JSON.parse(readFileSync(this.#filePath, 'utf8')) as CacheEnvelope;
    } catch {
      // A truncated or corrupt cache is not worth surfacing; just refetch.
      return undefined;
    }

    if (envelope.sport !== sport) return undefined;
    if (typeof envelope.fetched_at !== 'number') return undefined;
    if (!envelope.players || typeof envelope.players !== 'object') return undefined;
    if (this.#now() - envelope.fetched_at > this.#ttlMs) return undefined;

    this.#memo = envelope.players;
    return this.#memo;
  }

  /** True when a usable cache entry exists. */
  has(sport = 'nfl'): boolean {
    return this.read(sport) !== undefined;
  }

  /** Age of the current entry in milliseconds, or undefined when absent or unreadable. */
  ageMs(): number | undefined {
    if (!existsSync(this.#filePath)) return undefined;
    try {
      const envelope = JSON.parse(readFileSync(this.#filePath, 'utf8')) as CacheEnvelope;
      return typeof envelope.fetched_at === 'number'
        ? this.#now() - envelope.fetched_at
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Persist a freshly fetched player map.
   *
   * Written to a temp file and renamed, so an interrupted write cannot leave a
   * half-written 5MB file that fails to parse on every later run.
   */
  write(players: Record<string, Player>, sport = 'nfl', activeOnly = false): void {
    const envelope: CacheEnvelope = {
      fetched_at: this.#now(),
      sport,
      active_only: activeOnly,
      players,
    };

    mkdirSync(dirname(this.#filePath), { recursive: true });
    const temp = `${this.#filePath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(envelope));
    renameSync(temp, this.#filePath);

    this.#memo = players;
  }

  /** Drop the cache file and the in-process memo. */
  clear(): void {
    this.#memo = null;
    rmSync(this.#filePath, { force: true });
  }

  /** Size of the cache file in bytes, or undefined when absent. */
  sizeBytes(): number | undefined {
    if (!existsSync(this.#filePath)) return undefined;
    return statSync(this.#filePath).size;
  }

  get path(): string {
    return this.#filePath;
  }

  get cacheDir(): string {
    return CACHE_DIR;
  }
}
