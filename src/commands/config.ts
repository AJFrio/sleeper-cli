/**
 * `sleeper config` — reading and changing stored preferences.
 *
 * Values are validated per key rather than accepted blindly, because a typo in a
 * config file surfaces much later as a confusing failure in an unrelated command.
 */

import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { describePaths } from '../config/paths.js';
import {
  type CliConfig,
  DEFAULT_CONFIG,
  loadConfig,
  resetConfig,
  updateConfig,
} from '../config/store.js';
import { UsageError } from '../core/errors.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { formatBytes } from '../output/format.js';
import { confirmAction } from '../output/safety.js';
import type { CommandDeps } from './deps.js';

type ConfigKey = keyof CliConfig;

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as ConfigKey[];

interface ConfigOptions {
  yes?: boolean;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
}

/** Coerce and validate one config value. Returns the value to store. */
function coerceValue(key: ConfigKey, raw: string): CliConfig[ConfigKey] {
  switch (key) {
    case 'active_league_id': {
      if (!/^\d+$/.test(raw)) {
        throw new UsageError(
          `Invalid league id: ${raw}`,
          'League ids are numeric, e.g. 1234567890.',
        );
      }
      return raw;
    }
    case 'sport': {
      const sport = raw.toLowerCase();
      if (sport !== 'nfl') {
        throw new UsageError(`Unsupported sport: ${raw}`, "Sleeper currently supports 'nfl' only.");
      }
      return sport;
    }
    case 'season': {
      if (raw === 'null' || raw === '') return null;
      if (!/^\d{4}$/.test(raw)) {
        throw new UsageError(
          `Invalid season: ${raw}`,
          'Use a four-digit year, or "null" to ask Sleeper.',
        );
      }
      return raw;
    }
    case 'output': {
      if (raw !== 'table' && raw !== 'json') {
        throw new UsageError(`Invalid output format: ${raw}`, "Use 'table' or 'json'.");
      }
      return raw;
    }
    case 'player_cache_ttl_hours': {
      const hours = Number(raw);
      if (!Number.isFinite(hours) || hours <= 0) {
        throw new UsageError(`Invalid TTL: ${raw}`, 'Use a positive number of hours.');
      }
      return hours;
    }
    case 'default_roster_id': {
      if (raw === 'null' || raw === '') return null;
      const id = Number(raw);
      if (!Number.isInteger(id) || id < 1) {
        throw new UsageError(
          `Invalid roster id: ${raw}`,
          'Roster ids are positive integers, or "null".',
        );
      }
      return id;
    }
    default:
      throw new UsageError(`Unknown config key: ${String(key)}`);
  }
}

/** Keys that can be returned to their default with `unset`. */
const NULLABLE_KEYS: ConfigKey[] = ['active_league_id', 'season', 'default_roster_id'];

function assertKnownKey(key: string): asserts key is ConfigKey {
  if (!CONFIG_KEYS.includes(key as ConfigKey)) {
    throw new UsageError(`Unknown config key: ${key}`, `Valid keys: ${CONFIG_KEYS.join(', ')}`);
  }
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function registerConfigCommands(program: Command, deps: CommandDeps): void {
  const config = program.command('config').description('Inspect and change stored preferences');

  config
    .command('show')
    .description('Print the effective configuration')
    .action((options: ConfigOptions) => {
      buildContext(options, deps.client().config.output);
      const current = loadConfig();
      deps.emit().emit({
        command: deps.commandPath(),
        data: current,
        table: () =>
          [
            ...CONFIG_KEYS.map((key) => `  ${key.padEnd(24)} ${renderValue(current[key])}`),
            '',
            '  Override the output format per command with --json or --table.',
          ].join('\n'),
      });
    });

  config
    .command('get <key>')
    .description('Print one configuration value')
    .action((key: string, options: ConfigOptions) => {
      buildContext(options, deps.client().config.output);
      assertKnownKey(key);
      const value = loadConfig()[key];
      deps.emit().emit({
        command: deps.commandPath(),
        data: { key, value },
        table: () => renderValue(value),
      });
    });

  config
    .command('set <key> <value>')
    .description('Change one configuration value')
    .action((key: string, value: string, options: ConfigOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      assertKnownKey(key);
      const coerced = coerceValue(key, value);

      if (context.explain) {
        emit.emitJsonPayload({ key, value: coerced, current: loadConfig()[key] });
        return;
      }

      const updated = updateConfig({ [key]: coerced } as Partial<CliConfig>);
      deps.client().setConfig(updated);

      emit.emit({
        command: deps.commandPath(),
        data: { key, value: updated[key], previous: loadConfig()[key] },
        table: () => `${key} = ${renderValue(updated[key])}`,
      });
    });

  config
    .command('unset <key>')
    .description(`Reset one configuration key to null (${NULLABLE_KEYS.join(', ')})`)
    .action((key: string, options: ConfigOptions) => {
      buildContext(options, deps.client().config.output);
      assertKnownKey(key);
      if (!NULLABLE_KEYS.includes(key)) {
        throw new UsageError(
          `${key} has no null value`,
          `Only these keys can be unset: ${NULLABLE_KEYS.join(', ')}`,
        );
      }
      const updated = updateConfig({ [key]: null } as Partial<CliConfig>);
      deps.client().setConfig(updated);
      deps.emit().emit({
        command: deps.commandPath(),
        data: { key, value: null },
        table: () => `${key} = null`,
      });
    });

  config
    .command('paths')
    .description('Show where config, credentials and caches live on disk')
    .action((options: ConfigOptions) => {
      buildContext(options, deps.client().config.output);
      const paths = describePaths();
      const rows = Object.entries(paths).map(([name, path]) => ({
        name,
        path,
        exists: existsSync(path),
      }));

      deps.emit().emit({
        command: deps.commandPath(),
        data: paths,
        table: () => ({
          columns: [
            column('setting', (row: (typeof rows)[number]) => row.name),
            column('exists', (row: (typeof rows)[number]) => (row.exists ? 'yes' : 'no')),
            column('path', (row: (typeof rows)[number]) => row.path, { maxWidth: 70 }),
          ],
          rows,
          emptyMessage: 'No paths resolved.',
        }),
      });
    });

  config
    .command('reset')
    .description('Delete the config file and restore defaults')
    .action(async (options: ConfigOptions) => {
      const context = buildContext(options, deps.client().config.output);
      await confirmAction('delete the stored configuration and restore defaults', context);
      resetConfig();
      deps.client().setConfig({ ...DEFAULT_CONFIG });
      deps.emit().emit({
        command: deps.commandPath(),
        data: { reset: true },
        table: () => 'Configuration reset to defaults.',
      });
    });

  // Surfaced here rather than in its own module because it is purely about state.
  config
    .command('disk')
    .description('Report how much space the player cache uses')
    .action((options: ConfigOptions) => {
      buildContext(options, deps.client().config.output);
      const cache = deps.client().players;
      const size = cache.sizeBytes();
      deps.emit().emit({
        command: deps.commandPath(),
        data: { path: cache.path, size_bytes: size, age_ms: cache.ageMs(), warm: cache.has() },
        table: () =>
          [
            `  path   ${cache.path}`,
            `  size   ${formatBytes(size)}`,
            `  status ${cache.has() ? 'warm' : 'cold or stale'}`,
          ].join('\n'),
      });
    });
}
