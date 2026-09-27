/**
 * `sleeper add` and `sleeper drop` — free-agent transactions.
 *
 * Both directions are the same mutation, `league_create_transaction`, so a swap is a
 * single call. The kmap value is the roster involved: the destination for an add, the
 * source for a drop.
 *
 * Dropping is the irreversible half, so every drop path names the players in its
 * confirmation prompt.
 */

import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { addDrop, addDropForRoster, buildAddDropOperation } from '../domain/adddrop.js';
import { buildContext } from '../output/context.js';
import { confirmAction } from '../output/safety.js';
import type { CommandDeps } from './deps.js';
import { buildNameMap, resolvePlayerTokens } from './shared.js';

interface AddDropOptions {
  league?: string;
  rosterId?: string;
  drop?: string[];
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/** Resolve, preview, confirm, and send one free-agent move. */
async function runMove(
  deps: CommandDeps,
  direction: 'add' | 'drop',
  players: string[],
  options: AddDropOptions,
): Promise<void> {
  const context = buildContext(options, deps.client().config.output);
  const emit = deps.emit();
  const client = deps.client();
  client.requireSession();

  const leagueId = await client.resolveLeagueId(options.league);
  const rosterId = await client.resolveRosterId(
    leagueId,
    options.rosterId ? Number(options.rosterId) : undefined,
  );

  const primary = await resolvePlayerTokens(client, players);
  const paired = options.drop?.length ? await resolvePlayerTokens(client, options.drop) : [];

  const add = direction === 'add' ? primary : [];
  const drop = direction === 'drop' ? primary : [...paired];

  if (add.length === 0 && drop.length === 0) {
    throw new UsageError(`Nothing to ${direction}`, 'Pass at least one player id or name.');
  }

  const input = addDropForRoster({
    leagueId,
    rosterId,
    ...(add.length > 0 ? { add } : {}),
    ...(drop.length > 0 ? { drop } : {}),
  });
  const operation = buildAddDropOperation(input);

  if (context.explain) {
    emit.emitJsonPayload(operation);
    return;
  }

  const names = await buildNameMap(client, [...add, ...drop]);
  const label = (ids: readonly string[]): string =>
    ids.length === 0 ? '—' : ids.map((id) => names.get(id) ?? id).join(', ');

  if (context.dryRun) {
    emit.emit({
      command: deps.commandPath(),
      data: { dry_run: true, league_id: leagueId, roster_id: rosterId, add, drop, operation },
      table: () =>
        [
          'Dry run — nothing was sent.',
          '',
          `  add  : ${label(add)}`,
          `  drop : ${label(drop)}`,
        ].join('\n'),
    });
    return;
  }

  const parts = [
    add.length > 0 ? `add ${label(add)}` : '',
    drop.length > 0 ? `drop ${label(drop)}` : '',
  ]
    .filter((part) => part.length > 0)
    .join(' and ');
  await confirmAction(parts, context);

  const result = await addDrop(client.graphql, input);

  emit.emit({
    command: deps.commandPath(),
    data: {
      transaction_id: result.transaction_id,
      status: result.status,
      league_id: leagueId,
      roster_id: rosterId,
      add,
      drop,
    },
    table: () =>
      [
        `${result.status === 'complete' ? 'Done' : 'Submitted'}: ${parts}.`,
        `  transaction : ${result.transaction_id}`,
        `  status      : ${result.status}`,
      ].join('\n'),
  });
}

export function registerAddDropCommands(program: Command, deps: CommandDeps): void {
  program
    .command('add <players...>')
    .description('Add players to your roster as a free agent')
    .option('-l, --league <id>', 'league to act in')
    .option('--roster-id <n>', 'roster to add to (defaults to yours)')
    .option('-d, --drop <players...>', 'players to drop in the same transaction')
    .addHelpText(
      'after',
      [
        '',
        'An add and a drop sent together become one transaction, so the roster is never',
        'sitting in an illegal state in between.',
        '',
        'Examples:',
        '  sleeper add 1309 --dry-run',
        '  sleeper add 1309 --drop 486 --yes',
        '  sleeper add "Bijan Robinson" --league 1234567890',
      ].join('\n'),
    )
    .action(async (players: string[], options: AddDropOptions) => {
      await runMove(deps, 'add', players, options);
    });

  program
    .command('drop <players...>')
    .description('Drop players from your roster')
    .option('-l, --league <id>', 'league to act in')
    .option('--roster-id <n>', 'roster to drop from (defaults to yours)')
    .addHelpText(
      'after',
      [
        '',
        'Dropping is not reversible: a dropped player can only be re-acquired through',
        'a waiver. Run with --dry-run first if unsure.',
        '',
        'Examples:',
        '  sleeper drop 486 --dry-run',
        '  sleeper drop 486 --yes',
      ].join('\n'),
    )
    .action(async (players: string[], options: AddDropOptions) => {
      await runMove(deps, 'drop', players, options);
    });
}
