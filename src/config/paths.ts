/**
 * Filesystem locations for config, credentials and the player cache.
 *
 * Follows the XDG Base Directory spec so the CLI behaves predictably on Linux,
 * and falls back to the platform convention elsewhere. Every path can be
 * overridden with an environment variable, which is what makes the CLI testable
 * and usable in CI without touching the developer's real state.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Env var that relocates the whole state directory. Highest precedence. */
const STATE_DIR_ENV = 'SLEEPER_CLI_HOME';

function stateDir(): string {
  const override = process.env[STATE_DIR_ENV];
  if (override) return resolve(override);

  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) return join(resolve(xdgConfig), 'sleeper-cli');

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return join(appData, 'sleeper-cli');
  }

  return join(homedir(), '.config', 'sleeper-cli');
}

function cacheDir(): string {
  const override = process.env.SLEEPER_CLI_CACHE_DIR;
  if (override) return resolve(override);

  const xdgCache = process.env.XDG_CACHE_HOME;
  if (xdgCache) return join(resolve(xdgCache), 'sleeper-cli');

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, 'sleeper-cli');
  }

  return join(homedir(), '.cache', 'sleeper-cli');
}

/** Directory holding config and credentials. */
export const CONFIG_DIR = stateDir();

/** Non-secret preferences: selected league, output preferences, cache TTL. */
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** Secrets: the session token and, optionally, the login identifier. */
export const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json');

/** Directory for derived caches such as the player map. */
export const CACHE_DIR = cacheDir();

/** Cached copy of Sleeper's player map. Large, so it is cached rather than refetched. */
export const PLAYER_CACHE_FILE = join(CACHE_DIR, 'players.json');

/**
 * Report the resolved paths, for `sleeper config paths`.
 *
 * Useful when a user's state is in an unexpected place, and the first thing to ask
 * for in a bug report.
 */
export function describePaths(): {
  config_dir: string;
  config_file: string;
  credentials_file: string;
  cache_dir: string;
  player_cache_file: string;
} {
  return {
    config_dir: CONFIG_DIR,
    config_file: CONFIG_FILE,
    credentials_file: CREDENTIALS_FILE,
    cache_dir: CACHE_DIR,
    player_cache_file: PLAYER_CACHE_FILE,
  };
}
