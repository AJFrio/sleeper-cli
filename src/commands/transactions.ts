/**
 * `sleeper transactions` — the league's transaction history.
 *
 * Reads GraphQL rather than the public REST endpoint, because REST returns only
 * settled transactions. A pending proposal is the thing a user most often wants to
 * find, and it is invisible to REST.
 */

import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import type { Transaction } from '../core/types.js';
import { getTransactionsWithPending, TRANSACTION_STATUSES } from '../domain/transactions.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { formatTimestamp, renderRecord } from '../output/format.js';
import type { CommandDeps } from './deps.js';
import { buildNameMap, loadTeams, type TeamInfo, teamLabel } from './shared.js';

interface TransactionOptions {
  week?: string;
  type?: string;
  status?: string;
  rosterId?: string;
  limit?: string;
  search?: string;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/** A transaction joined with the names of the players it moved. */
interface TransactionRow {
  transaction_id: string;
  type: string;
  status: string;
  leg: number | null;
  created: number;
  acquires: string;
  relinquishes: string;
  picks: number;
  faab: number;
  parties: string;
}

/** Fetch transactions, preferring the GraphQL feed that includes pending ones. */
async function loadTransactions(
  deps: CommandDeps,
  leagueId: string,
  options: TransactionOptions,
  week: number,
): Promise<{ transactions: Transaction[]; limitations: string[] }> {
  return getTransactionsWithPending(deps.client().graphql, deps.client().rest, {
    leagueId,
    week,
    ...(options.status ? { status: options.status } : {}),
    ...(options.type ? { type: options.type } : {}),
    ...(options.rosterId ? { rosterId: Number(options.rosterId) } : {}),
    limit: Number(options.limit ?? 100),
  });
}

/** A traded pick with its three owners resolved to manager names. */
interface TradedPickRow {
  season: string | null;
  round: string | null;
  original: string | null;
  previous: string | null;
  owner: string | null;
}

/**
 * Normalise the traded-picks payload.
 *
 * The endpoint returns an untyped array and omits ids it cannot resolve, so every
 * field is probed and a malformed entry is dropped rather than rendered as a row of
 * dashes.
 */
function normaliseTradedPicks(
  raw: readonly unknown[],
  teams: ReadonlyMap<number, TeamInfo>,
): TradedPickRow[] {
  const rosterId = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  const label = (value: unknown): string | null => {
    const id = rosterId(value);
    return id === null ? null : teamLabel(teams.get(id), id);
  };
  const asText = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);

  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const pick = entry as Record<string, unknown>;
    return [
      {
        season: asText(pick.season),
        round: asText(pick.round),
        original: label(pick.roster_id),
        previous: label(pick.previous_owner_id),
        owner: label(pick.owner_id),
      },
    ];
  });
}

export function registerTransactionCommands(program: Command, deps: CommandDeps): void {
  const transactions = program
    .command('transactions')
    .description('Inspect the league transaction history')
    .alias('tx');

  transactions
    .command('list [leagueId]')
    .description('List transactions for a week')
    .option('-w, --week <n>', 'week to read (defaults to the current week)')
    .option('-t, --type <type>', 'add, drop, trade, free_agent, waiver, or draft')
    .option('-s, --status <status>', `one of: ${TRANSACTION_STATUSES.join(', ')}`)
    .option('-r, --roster-id <n>', 'restrict to one roster')
    .option('-n, --limit <count>', 'maximum rows', '100')
    .action(async (leagueId: string | undefined, options: TransactionOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);

      const week = options.week ? Number(options.week) : (await client.state()).week;
      const { teams } = await loadTeams(client, resolved);
      const { transactions, limitations } = await loadTransactions(deps, resolved, options, week);
      for (const note of limitations) emit.warn(note);

      const allIds = transactions.flatMap((tx) => [
        ...Object.keys(tx.adds ?? {}),
        ...Object.keys(tx.drops ?? {}),
      ]);
      const names = await buildNameMap(client, allIds);
      const label = (ids: readonly string[]): string =>
        ids.length === 0 ? '—' : ids.map((id) => names.get(id) ?? id).join(', ');

      const rows: TransactionRow[] = transactions.map((tx) => ({
        transaction_id: tx.transaction_id,
        type: tx.type,
        status: tx.status,
        leg: tx.leg,
        created: tx.created,
        acquires: label(Object.keys(tx.adds ?? {})),
        relinquishes: label(Object.keys(tx.drops ?? {})),
        picks: Array.isArray(tx.draft_picks) ? tx.draft_picks.length : 0,
        faab: (tx.waiver_budget ?? []).reduce((sum, entry) => sum + entry.amount, 0),
        parties: (tx.roster_ids ?? []).map((id) => teamLabel(teams.get(id), id)).join(', '),
      }));

      emit.emit({
        command: deps.commandPath(),
        data: { league_id: resolved, week, transactions: rows },
        table: () => ({
          columns: [
            column('created', (row: TransactionRow) => formatTimestamp(row.created)),
            column('type', (row: TransactionRow) => row.type),
            column('status', (row: TransactionRow) => row.status),
            column('parties', (row: TransactionRow) => row.parties, { maxWidth: 24 }),
            column('acquires', (row: TransactionRow) => row.acquires, { maxWidth: 28 }),
            column('relinquishes', (row: TransactionRow) => row.relinquishes, { maxWidth: 24 }),
            column('picks', (row: TransactionRow) => row.picks, { align: 'right' }),
            column('faab', (row: TransactionRow) => row.faab, { align: 'right' }),
            column('id', (row: TransactionRow) => row.transaction_id, { maxWidth: 20 }),
          ],
          rows,
          emptyMessage: `No transactions found for week ${week}.`,
        }),
      });
    });

  transactions
    .command('show <transactionId> [leagueId]')
    .description('Show one transaction in full')
    .option('-w, --week <n>', 'week to search (defaults to the current week)')
    .option('--search-weeks <n>', 'how many weeks back to search', '5')
    .action(
      async (
        transactionId: string,
        leagueId: string | undefined,
        options: TransactionOptions & { searchWeeks?: string },
      ) => {
        buildContext(options, deps.client().config.output);
        const emit = deps.emit();
        const client = deps.client();
        const resolved = await client.resolveLeagueId(leagueId);

        const currentWeek = options.week ? Number(options.week) : (await client.state()).week;
        const depth = Number(options.searchWeeks ?? 5);

        // Sleeper scopes transactions by week, so a lookup has to sweep a range. Done
        // sequentially rather than in parallel to stay well inside the rate limit.
        let found: Transaction | undefined;
        for (let offset = 0; offset < depth && !found; offset++) {
          const week = currentWeek - offset;
          if (week < 1) break;
          const result = await loadTransactions(deps, resolved, { ...options, limit: '200' }, week);
          found = result.transactions.find((tx) => tx.transaction_id === transactionId);
        }

        if (!found) {
          throw new UsageError(
            `Transaction ${transactionId} not found in the last ${depth} week(s)`,
            'Widen the search with --search-weeks, or confirm the id.',
          );
        }

        const { teams } = await loadTeams(client, resolved);
        const names = await buildNameMap(client, [
          ...Object.keys(found.adds ?? {}),
          ...Object.keys(found.drops ?? {}),
        ]);
        const label = (ids: readonly string[]): string =>
          ids.length === 0 ? '—' : ids.map((id) => names.get(id) ?? id).join(', ');

        const picks = Array.isArray(found.draft_picks) ? found.draft_picks : [];

        emit.emit({
          command: deps.commandPath(),
          data: {
            ...found,
            labels: {
              adds: label(Object.keys(found.adds ?? {})),
              drops: label(Object.keys(found.drops ?? {})),
            },
          },
          table: () =>
            [
              renderRecord(
                {
                  transaction: found.transaction_id,
                  type: found.type,
                  status: found.status,
                  leg: found.leg,
                  created: formatTimestamp(found.created),
                  updated: formatTimestamp(found.status_updated),
                  parties: (found.roster_ids ?? [])
                    .map((id) => teamLabel(teams.get(id), id))
                    .join(', '),
                },
                { indent: 2 },
              ),
              `\n  acquires    : ${label(Object.keys(found.adds ?? {}))}`,
              `  relinquishes: ${label(Object.keys(found.drops ?? {}))}`,
              ...(picks.length > 0
                ? [
                    '',
                    '  Draft picks',
                    ...picks.map((pick) => {
                      const record = (pick ?? {}) as Record<string, unknown>;
                      return (
                        `    season ${record.season ?? '—'}  round ${record.round ?? '—'}  ` +
                        `from ${teamLabel(teams.get(Number(record.previous_owner_id)), Number(record.previous_owner_id))} ` +
                        `to ${teamLabel(teams.get(Number(record.owner_id)), Number(record.owner_id))}`
                      );
                    }),
                  ]
                : []),
              ...((found.waiver_budget ?? []).length > 0
                ? [
                    '',
                    '  FAAB',
                    ...(found.waiver_budget ?? []).map(
                      (entry) =>
                        `    ${teamLabel(teams.get(entry.sender), entry.sender)} sends ${entry.amount} to ${teamLabel(teams.get(entry.receiver), entry.receiver)}`,
                    ),
                  ]
                : []),
            ].join('\n'),
        });
      },
    );

  transactions
    .command('traded-picks [leagueId]')
    .description('List draft picks that have changed hands')
    .action(async (leagueId: string | undefined, options: TransactionOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);

      const raw = await client.rest.getTradedPicks(resolved);
      const { teams } = await loadTeams(client, resolved);

      const rows = normaliseTradedPicks(raw, teams);

      emit.emit({
        command: deps.commandPath(),
        data: { league_id: resolved, traded_picks: rows },
        table: () => ({
          columns: [
            column('season', (row: TradedPickRow) => row.season),
            column('round', (row: TradedPickRow) => row.round, { align: 'right' }),
            column('original owner', (row: (typeof rows)[number]) => row.original, {
              maxWidth: 22,
            }),
            column('previous owner', (row: (typeof rows)[number]) => row.previous, {
              maxWidth: 22,
            }),
            column('current owner', (row: (typeof rows)[number]) => row.owner, { maxWidth: 22 }),
          ],
          rows,
          emptyMessage: 'No picks have been traded in this league.',
        }),
      });
    });
}
