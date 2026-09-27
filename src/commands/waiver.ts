/**
 * `sleeper waiver` — submitting, editing, and withdrawing waiver claims.
 *
 * A claim is queued rather than applied, and a FAAB bid is unrecoverable once the
 * claim resolves. So the bid is stated explicitly in the confirmation prompt, and
 * every mutation here is gated.
 *
 * The FAAB priority key is `waiver_bid` in a kmap, and the kmap's two halves are
 * omitted entirely when empty, because Sleeper rejects empty arrays on them.
 */

import type { Command } from 'commander';
import type { SleeperClient } from '../core/client.js';
import { UsageError } from '../core/errors.js';
import { toRosterMap } from '../core/kmap.js';
import {
  getTransactionsWithPending,
  type SideView,
  viewForRoster,
  waiverPriority,
} from '../domain/transactions.js';
import {
  buildCancelWaiverOperation,
  buildSubmitWaiverOperation,
  buildUpdateWaiverOperation,
  cancelWaiver,
  submitWaiver,
  suggestedBid,
  updateWaiver,
} from '../domain/waivers.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { formatTimestamp } from '../output/format.js';
import { confirmAction } from '../output/safety.js';
import type { CommandDeps } from './deps.js';
import { buildNameMap, loadTeams, resolvePlayerTokens, teamLabel } from './shared.js';

interface WaiverOptions {
  league?: string;
  rosterId?: string;
  drop?: string[];
  bid?: string;
  note?: string;
  leg?: string;
  limit?: string;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/** Pending waiver claims on a roster. */
async function loadClaims(
  deps: CommandDeps,
  leagueId: string,
  rosterId: number,
  limit: number,
): Promise<{
  claims: {
    transaction_id: string;
    status: string;
    leg: number | null;
    created: number;
    side: SideView;
  }[];
  limitations: string[];
}> {
  const client = deps.client();
  const week = await client
    .state()
    .then((s) => s.week)
    .catch(() => 1);
  const { transactions, limitations } = await getTransactionsWithPending(
    client.graphql,
    client.rest,
    {
      leagueId,
      type: 'waiver',
      week,
      limit,
    },
  );

  const claims = transactions
    .filter((tx) => tx.status === 'proposed' || tx.status === 'pending')
    .filter((tx) => (tx.roster_ids ?? []).includes(rosterId))
    .map((tx) => ({
      transaction_id: tx.transaction_id,
      status: tx.status,
      leg: tx.leg,
      created: tx.created,
      side: viewForRoster(tx, rosterId),
    }))
    .sort((a, b) => b.created - a.created);

  return { claims, limitations };
}

export function registerWaiverCommands(program: Command, deps: CommandDeps): void {
  const waiver = program.command('waiver').description('Submit and manage waiver claims');

  // ------------------------------------------------------------------- add
  waiver
    .command('add <players...>')
    .description('Submit a waiver claim')
    .option('-l, --league <id>', 'league to act in')
    .option('--roster-id <n>', 'roster to claim onto (defaults to yours)')
    .option('-d, --drop <players...>', 'players to drop to make room')
    .option('-b, --bid <amount>', 'FAAB priority bid')
    .option('-n, --note <text>', 'reason shown to the league')
    .addHelpText(
      'after',
      [
        '',
        'A bid cannot be raised once the claim resolves, so check it with --dry-run.',
        'In a non-league that uses a waiver priority, --bid is not needed.',
        '',
        'Examples:',
        '  sleeper waiver add 1309 --bid 5 --dry-run',
        '  sleeper waiver add "Bijan Robinson" --drop 486 --yes',
      ].join('\n'),
    )
    .action(async (players: string[], options: WaiverOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      client.requireSession();

      const leagueId = await client.resolveLeagueId(options.league);
      const rosterId = await client.resolveRosterId(
        leagueId,
        options.rosterId ? Number(options.rosterId) : undefined,
      );

      const adds = await resolvePlayerTokens(client, players);
      const drops = options.drop?.length ? await resolvePlayerTokens(client, options.drop) : [];

      const input = {
        leagueId,
        adds: toRosterMap(adds, rosterId),
        drops: toRosterMap(drops, rosterId),
        ...(options.bid ? { bid: Number(options.bid) } : {}),
        ...(options.note ? { note: options.note } : {}),
      };
      const operation = buildSubmitWaiverOperation(input);

      if (context.explain) {
        emit.emitJsonPayload(operation);
        return;
      }

      const names = await buildNameMap(client, [...adds, ...drops]);
      const label = (ids: readonly string[]): string =>
        ids.length === 0 ? '—' : ids.map((id) => names.get(id) ?? id).join(', ');
      const bidText = options.bid
        ? `${options.bid} FAAB`
        : 'no priority (this league uses waiver order)';

      if (context.dryRun) {
        emit.emit({
          command: deps.commandPath(),
          data: { dry_run: true, league_id: leagueId, roster_id: rosterId, adds, drops, operation },
          table: () =>
            [
              'Dry run — nothing was sent.',
              '',
              `  claim  : ${label(adds)}`,
              `  drop   : ${label(drops)}`,
              `  bid    : ${bidText}`,
              ...(options.note ? [`  note   : ${options.note}`] : []),
            ].join('\n'),
        });
        return;
      }

      await confirmAction(
        `submit a waiver claim for ${label(adds)} with a bid of ${bidText}` +
          (drops.length > 0 ? `, dropping ${label(drops)}` : ''),
        context,
      );

      const result = await submitWaiver(client.graphql, input);
      emit.emit({
        command: deps.commandPath(),
        data: {
          transaction_id: result.transaction_id,
          status: result.status,
          leg: result.leg,
          league_id: leagueId,
          roster_id: rosterId,
          adds,
          drops,
          bid: options.bid ? Number(options.bid) : null,
        },
        table: () =>
          [
            `Waiver claim submitted: ${label(adds)} (bid ${bidText}).`,
            `  transaction : ${result.transaction_id}`,
            `  status      : ${result.status}`,
          ].join('\n'),
      });
    });

  // ------------------------------------------------------------------ edit
  waiver
    .command('edit <transactionId>')
    .description('Change the bid or note on a pending claim')
    .option('-l, --league <id>', 'league the claim belongs to')
    .option('-b, --bid <amount>', 'new FAAB priority bid')
    .option('-n, --note <text>', 'new reason')
    .option('--leg <n>', 'matchup week of the claim; inferred when omitted')
    .action(async (transactionId: string, options: WaiverOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      client.requireSession();

      const leagueId = await client.resolveLeagueId(options.league);
      const leg = options.leg
        ? Number(options.leg)
        : await inferLeg(client, leagueId, transactionId);
      if (leg === undefined) {
        throw new UsageError(
          `Could not determine the week for claim ${transactionId}`,
          'Pass --leg with the matchup week the claim was made in.',
        );
      }

      const input = {
        leagueId,
        transactionId,
        leg,
        ...(options.bid ? { bid: Number(options.bid) } : {}),
        ...(options.note ? { note: options.note } : {}),
      };
      const operation = buildUpdateWaiverOperation(input);

      if (context.explain) {
        emit.emitJsonPayload(operation);
        return;
      }
      if (context.dryRun) {
        emit.emit({
          command: deps.commandPath(),
          data: { dry_run: true, ...operation.variables },
          table: () =>
            `Dry run — would edit claim ${transactionId} (leg ${leg}). Nothing was sent.`,
        });
        return;
      }

      const detail = [
        options.bid ? `bid ${options.bid} FAAB` : '',
        options.note ? `note "${options.note}"` : '',
      ]
        .filter((part) => part.length > 0)
        .join(' and ');
      await confirmAction(`change claim ${transactionId} to ${detail}`, context);

      const result = await updateWaiver(client.graphql, input);
      emit.emit({
        command: deps.commandPath(),
        data: { transaction_id: result.transaction_id, status: result.status },
        table: () => `Claim ${transactionId} updated. Status ${result.status}.`,
      });
    });

  // ---------------------------------------------------------------- cancel
  waiver
    .command('cancel <transactionId>')
    .description('Withdraw a pending waiver claim')
    .option('-l, --league <id>', 'league the claim belongs to')
    .option('--leg <n>', 'matchup week of the claim; inferred when omitted')
    .action(async (transactionId: string, options: WaiverOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      client.requireSession();

      const leagueId = await client.resolveLeagueId(options.league);
      const leg = options.leg
        ? Number(options.leg)
        : await inferLeg(client, leagueId, transactionId);
      if (leg === undefined) {
        throw new UsageError(
          `Could not determine the week for claim ${transactionId}`,
          'Pass --leg with the matchup week the claim was made in.',
        );
      }

      const operation = buildCancelWaiverOperation({ leagueId, transactionId, leg });
      if (context.explain) {
        emit.emitJsonPayload(operation);
        return;
      }
      if (context.dryRun) {
        emit.emit({
          command: deps.commandPath(),
          data: { dry_run: true, ...operation.variables },
          table: () => `Dry run — would cancel claim ${transactionId}. Nothing was sent.`,
        });
        return;
      }

      await confirmAction(`withdraw waiver claim ${transactionId}`, context);
      const result = await cancelWaiver(client.graphql, { leagueId, transactionId, leg });

      emit.emit({
        command: deps.commandPath(),
        data: { transaction_id: result.transaction_id, status: result.status },
        table: () => `Claim ${transactionId} withdrawn. Status ${result.status}.`,
      });
    });

  // ------------------------------------------------------------------ list
  waiver
    .command('list [leagueId]')
    .description('List your pending waiver claims')
    .option('-n, --limit <count>', 'maximum rows', '25')
    .action(async (leagueId: string | undefined, options: WaiverOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);
      const rosterId = await client.resolveRosterId(resolved);

      const { claims, limitations } = await loadClaims(
        deps,
        resolved,
        rosterId,
        Number(options.limit ?? 25),
      );
      for (const note of limitations) emit.warn(note);

      const names = await buildNameMap(
        client,
        claims.flatMap((c) => [...c.side.received, ...c.side.sent]),
      );
      const label = (ids: readonly string[]): string =>
        ids.length === 0 ? '—' : ids.map((id) => names.get(id) ?? id).join(', ');

      const rows = claims.map((claim) => ({
        ...claim,
        claiming: label(claim.side.received),
        dropping: label(claim.side.sent),
      }));

      emit.emit({
        command: deps.commandPath(),
        data: { league_id: resolved, roster_id: rosterId, claims: rows },
        table: () => ({
          columns: [
            column('transaction', (row: (typeof rows)[number]) => row.transaction_id, {
              maxWidth: 22,
            }),
            column('leg', (row: (typeof rows)[number]) => row.leg, { align: 'right' }),
            column('claiming', (row: (typeof rows)[number]) => row.claiming, { maxWidth: 28 }),
            column('dropping', (row: (typeof rows)[number]) => row.dropping, { maxWidth: 24 }),
            column('created', (row: (typeof rows)[number]) => formatTimestamp(row.created)),
          ],
          rows,
          emptyMessage: 'No pending waiver claims.',
        }),
      });
    });

  // -------------------------------------------------------------- priority
  waiver
    .command('priority [leagueId]')
    .description('Show your waiver priority and the bid it would take')
    .action(async (leagueId: string | undefined, options: WaiverOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);
      const { rosters, teams } = await loadTeams(client, resolved);
      const rosterId = await client.resolveRosterId(resolved);
      const roster = rosters.find((r) => r.roster_id === rosterId);
      if (!roster) throw new UsageError(`Roster ${rosterId} not found in league ${resolved}`);

      const priority = waiverPriority(roster);
      const suggested = suggestedBid(priority);

      // League standings ordered by waiver position, which is the order claims resolve in.
      const queue = rosters
        .map((entry) => ({ roster_id: entry.roster_id, priority: waiverPriority(entry) }))
        .filter(
          (entry): entry is { roster_id: number; priority: number } => entry.priority !== undefined,
        )
        .sort((a, b) => a.priority - b.priority)
        .map((entry) => ({
          ...entry,
          manager: teamLabel(teams.get(entry.roster_id), entry.roster_id),
          is_you: entry.roster_id === rosterId,
        }));

      emit.emit({
        command: deps.commandPath(),
        data: {
          league_id: resolved,
          roster_id: rosterId,
          uses_priority: priority !== undefined,
          priority: priority ?? null,
          suggested_bid: suggested ?? null,
          queue,
        },
        table: () =>
          [
            priority === undefined
              ? 'This league does not use a FAAB priority. Claims resolve in reverse standings order.'
              : [`Your waiver priority: ${priority}`, `Bid that beats it:     ${suggested}`].join(
                  '\n',
                ),
            ...(queue.length > 0
              ? [
                  '',
                  'Claim order',
                  ...queue.map(
                    (entry) =>
                      `  ${String(entry.priority).padStart(3)}. ${entry.manager}${entry.is_you ? '  <- you' : ''}`,
                  ),
                ]
              : []),
          ].join('\n'),
      });
    });
}

/** Infer a claim's leg from the current week's feed, or undefined when absent. */
async function inferLeg(
  client: SleeperClient,
  leagueId: string,
  transactionId: string,
): Promise<number | undefined> {
  const week = await client
    .state()
    .then((s) => s.week)
    .catch(() => 1);
  const transactions = await client.rest.getTransactions(leagueId, week);
  return transactions.find((tx) => tx.transaction_id === transactionId)?.leg ?? undefined;
}
