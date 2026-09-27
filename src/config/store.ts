/**
 * Persistent, non-secret preferences.
 *
 * Deliberately narrow: which league is selected, and a few output and cache
 * knobs. Anything sensitive lives in credentials.ts instead.
 *
 * Writes are atomic (temp file plus rename) so an interrupted write cannot leave a
 * truncated config that breaks every subsequent invocation.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE } from './paths.js';

export interface CliConfig {
  /** League to operate on when a command does not name one. */
  active_league_id: string | null;
  /** Sport code. Sleeper only supports NFL today but the shape is forward-compatible. */
  sport: string;
  /**
   * Season to list leagues for. `null` means "ask Sleeper", which is what most
   * users want; pinning it is useful for reviewing an archived season.
   */
  season: string | null;
  /** Preferred default output format. */
  output: 'table' | 'json';
  /** Hours before the cached player map is considered stale. */
  player_cache_ttl_hours: number;
  /** League to fall back to for read commands that do not require writes. */
  default_roster_id: number | null;
}

export const DEFAULT_CONFIG: CliConfig = {
  active_league_id: null,
  sport: 'nfl',
  season: null,
  output: 'table',
  // Sleeper asks callers not to fetch the player map more than once a day.
  player_cache_ttl_hours: 20,
  default_roster_id: null,
};

/** Read config, merging anything absent from disk over the defaults. */
export function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    throw new Error(
      `Config file at ${CONFIG_FILE} is not valid JSON. Fix it or run \`sleeper config reset\`. ` +
        `Underlying error: ${(err as Error).message}`,
      { cause: err },
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Config file at ${CONFIG_FILE} did not contain a JSON object.`);
  }

  const raw = parsed as Partial<CliConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // Guard against a hand-edited file putting the CLI into an invalid state.
    output: raw.output === 'json' ? 'json' : 'table',
    sport: typeof raw.sport === 'string' && raw.sport ? raw.sport : DEFAULT_CONFIG.sport,
    player_cache_ttl_hours:
      typeof raw.player_cache_ttl_hours === 'number' && raw.player_cache_ttl_hours > 0
        ? raw.player_cache_ttl_hours
        : DEFAULT_CONFIG.player_cache_ttl_hours,
    active_league_id:
      typeof raw.active_league_id === 'string' && raw.active_league_id
        ? raw.active_league_id
        : null,
    default_roster_id: typeof raw.default_roster_id === 'number' ? raw.default_roster_id : null,
  };
}

/** Persist config, creating the directory if needed. */
export function saveConfig(config: CliConfig): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });

  const temp = `${CONFIG_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, CONFIG_FILE);
}

/** Merge a partial update into the stored config. */
export function updateConfig(patch: Partial<CliConfig>): CliConfig {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}

/** Restore defaults by removing the config file. */
export function resetConfig(): void {
  rmSync(CONFIG_FILE, { force: true });
}

/** Ensure the config directory exists, for callers about to write credentials. */
export function ensureConfigDir(): string {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  return CONFIG_DIR;
}
