#!/usr/bin/env node
/**
 * `sleeper` entry point.
 *
 * Three responsibilities, kept separate on purpose:
 *
 *  1. Build the Commander program and register commands.
 *  2. Resolve the global flags into a context before any action runs, so handlers
 *     receive a finished object rather than raw Commander options.
 *  3. Convert any thrown value into a typed error and a stable exit code.
 *
 * Exit codes are part of the public contract — an agent branches on them — so the
 * mapping from error kind to code lives in core/errors.ts and is applied exactly
 * once, here.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import { registerAddDropCommands } from './commands/adddrop.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerConfigCommands } from './commands/config.js';
import type { CommandDeps } from './commands/deps.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerDraftCommands } from './commands/drafts.js';
import { registerLeaguesCommands } from './commands/leagues.js';
import { registerLineupCommands } from './commands/lineup.js';
import { registerMatchupCommands } from './commands/matchups.js';
import { registerPlayersCommands } from './commands/players.js';
import { registerRosterCommands } from './commands/roster.js';
import { registerStatsCommands } from './commands/stats.js';
import { registerTradeCommands } from './commands/trade.js';
import { registerTransactionCommands } from './commands/transactions.js';
import { registerWaiverCommands } from './commands/waiver.js';
import { loadConfig } from './config/store.js';
import { SleeperClient } from './core/client.js';
import { EXIT, SleeperError, toSleeperError } from './core/errors.js';
import { buildContext, GLOBAL_OPTIONS, type GlobalFlags } from './output/context.js';
import { Emitter } from './output/emit.js';

const VERSION = '0.1.0';

export interface RunOptions {
  /** argv without the node and script entries. */
  argv: string[];
  /** Injected by tests to capture output instead of writing to the real streams. */
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function buildProgram(io: {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}): Command {
  const program = new Command();

  program
    .name('sleeper')
    .description(
      [
        'Manage Fantasy Football teams on Sleeper from the command line.',
        '',
        'Built for agents: every command supports --json, every mutation supports',
        '--dry-run and --explain, and exit codes are stable.',
      ].join('\n'),
    )
    .version(VERSION, '-v, --version', 'Print the version')
    .showHelpAfterError('(run `sleeper --help` for usage)')
    .enablePositionalOptions()
    // Without this Commander calls process.exit() itself on a usage error, so the
    // exit-code mapping in run() would never see it and every bad flag would exit 1
    // instead of the documented USAGE code.
    .exitOverride()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr,
    });

  for (const option of GLOBAL_OPTIONS) {
    program.option(option.flags, option.description);
  }

  return program;
}

/**
 * Copy the global flags onto every command in the tree.
 *
 * Commander resolves an option against the command it was declared on, so flags
 * registered only on the root are rejected on a subcommand. Rather than repeat the
 * list in every command group, it is applied to the finished tree. Already-present
 * flags are skipped, which keeps a command free to override a global if it ever needs
 * to.
 */
function applyGlobalOptions(program: Command, onCommand: (command: Command) => void): void {
  const visit = (command: Command): void => {
    const existing = new Set(
      command.options.map((option) => option.long ?? option.short ?? '').filter(Boolean),
    );
    for (const option of GLOBAL_OPTIONS) {
      const [flags] = option.flags.split(/[ ,|]+/);
      if (!flags || existing.has(`--${flags.replace(/^--/, '')}`)) continue;
      command.addOption(new Option(option.flags, option.description));
    }
    // A preAction hook registered on a command fires with that command as its
    // argument. Registering it on the root alone would only ever report the root, so
    // the leaf that actually carries the parsed flags is never seen.
    command.hook('preAction', (thisCommand) => {
      onCommand(thisCommand);
    });
    for (const child of command.commands) visit(child);
  };
  visit(program);
}

/** Assemble the dependency bundle and register every command group. */
function registerAll(program: Command, deps: CommandDeps): void {
  registerAuthCommands(program, deps);
  registerLeaguesCommands(program, deps);
  registerRosterCommands(program, deps);
  registerLineupCommands(program, deps);
  registerAddDropCommands(program, deps);
  registerTradeCommands(program, deps);
  registerWaiverCommands(program, deps);
  registerPlayersCommands(program, deps);
  registerMatchupCommands(program, deps);
  registerStatsCommands(program, deps);
  registerTransactionCommands(program, deps);
  registerDraftCommands(program, deps);
  registerConfigCommands(program, deps);
  registerDoctorCommand(program, deps);
}

export async function run(options: RunOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));

  const client = new SleeperClient();
  // The context is replaced by the preAction hook, but the emitter needs one up front
  // for errors raised before an action runs.
  let context = buildContext({}, loadConfig().output);
  let emitter = new Emitter(context);
  let commandPath = 'sleeper';

  const deps: CommandDeps = {
    client: () => client,
    emit: () => emitter,
    context: () => context,
    commandPath: () => commandPath,
  };

  const io = {
    stdout: (text: string) => stdout(text),
    stderr: (text: string) => stderr(text),
  };

  const program = buildProgram(io);

  registerAll(program, deps);
  applyGlobalOptions(program, (thisCommand) => {
    const merged = { ...thisCommand.parent?.opts(), ...thisCommand.opts() } as GlobalFlags;
    context = buildContext(merged, loadConfig().output);
    emitter = new Emitter(context);

    // Walk `parent` to build a readable command path such as `sleeper trade propose`.
    // Commander's chain runs root-first, so it is reversed.
    const names: string[] = [];
    for (let node: Command | null = thisCommand; node; node = node.parent) {
      if (node.name() && node.name() !== 'sleeper') names.push(node.name());
    }
    commandPath = ['sleeper', ...names.reverse()].join(' ');
  });

  try {
    await program.parseAsync(options.argv, { from: 'user' });
    return process.exitCode === undefined ? EXIT.OK : Number(process.exitCode);
  } catch (err) {
    // Commander signals its own exits through this error; those are already correct
    // and must not be re-wrapped.
    if (err instanceof CommanderError) {
      const code = err.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
      if (code === EXIT.OK) return EXIT.OK;
      // The preAction hook never ran, so `context` still holds defaults. Read the
      // flag straight from argv so an agent that always passes --json gets JSON even
      // for a malformed command line.
      if (context.json || options.argv.includes('--json')) {
        stdout(
          `${JSON.stringify({
            ok: false,
            command: commandPath,
            error: { code: 'usage', message: err.message, exit_code: EXIT.USAGE },
          })}\n`,
        );
      }
      return EXIT.USAGE;
    }

    const error = toSleeperError(err);
    if (error instanceof SleeperError && error.exitCode === EXIT.OK) return EXIT.OK;
    return emitter.fail(commandPath, error);
  }
}

/**
 * True when this module is the process entry point.
 *
 * The two sides have to be compared as file URLs, not as raw strings: `import.meta.url`
 * percent-encodes characters that `process.argv[1]` leaves literal, so a path
 * containing a space — as this project's own directory does — would never compare
 * equal and the CLI would silently do nothing when run through tsx.
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  run({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`sleeper: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = EXIT.ERROR;
    });
}
