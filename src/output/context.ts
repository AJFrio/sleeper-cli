/**
 * Per-invocation context: the global flags every command reads.
 *
 * Commander gives each action its own options object, but almost every handler
 * needs the same handful. Threading a single context through keeps handlers from
 * re-deriving "am I in JSON mode" in a dozen slightly different ways.
 */

import type { OutputFormat } from './format.js';
import type { SafetyOptions } from './safety.js';

export interface GlobalFlags extends SafetyOptions {
  json: boolean;
  /** Force table output even when the config prefers JSON. */
  table: boolean;
  /** Suppress non-essential output. Errors still go to stderr. */
  quiet: boolean;
  /** Print resolved config, paths and session state without contacting Sleeper. */
  debug: boolean;
  /** Emit the GraphQL document and variables for the request, without sending it. */
  explain: boolean;
}

/** Flags every command inherits. */
export const GLOBAL_OPTIONS = [
  { flags: '--json', description: 'Emit machine-readable JSON on stdout' },
  { flags: '--table', description: 'Force human-readable table output' },
  { flags: '--yes, -y', description: 'Confirm a state-changing action without prompting' },
  { flags: '--dry-run', description: 'Show what would change without changing it' },
  { flags: '--quiet, -q', description: 'Suppress non-essential output' },
  { flags: '--debug', description: 'Print resolved config, paths and session state' },
  { flags: '--explain', description: 'Print the GraphQL document and variables, then exit' },
] as const;

/** Build a context from Commander's parsed options, applying config defaults. */
export function buildContext(
  options: Partial<GlobalFlags>,
  configuredOutput: OutputFormat,
): GlobalContext {
  const json = options.json === true || (options.table !== true && configuredOutput === 'json');

  return {
    json,
    table: options.table === true,
    format: json ? 'json' : 'table',
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    assumeYes: false,
    quiet: options.quiet === true,
    debug: options.debug === true,
    explain: options.explain === true,
  };
}

export interface GlobalContext extends GlobalFlags {
  format: OutputFormat;
}
