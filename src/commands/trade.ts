/**
 * `sleeper trade` — proposing and answering trades.
 *
 * ## How the roster sides are encoded
 *
 * `propose_trade` takes two positionally-zipped array pairs. The value attached to
 * each player is that player's **current owner**: the counterparty's roster for a
 * player you receive, and your own roster for a player you send. Getting this
 * backwards silently inverts the whole trade, so it is asserted against the two
 * roster ids and commented at the call site below.
 *
 * Pending proposals are not visible through the public REST API — it returns only
 * settled transactions — so `list` goes through the GraphQL transaction query.
 */

import type { Command } from 'commander';
import type { SleeperClient } from '../core/client.js';
import { UsageError } from '../core/errors.js';
import { toRosterMap } from '../core/kmap.js';
import {
  buildProposeTradeOperation,
  buildTradeResponseOperation,
  type DraftPickRef,
  proposeTrade,
  respondToTrade,
} from '../domain/trades.js';
import {
  getTransactionsWithPending,
  type SideView,
  viewForRoster,
} from '../domain/transactions.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { formatTimestamp, renderRecord } from '../output/format.js';
import { confirmAction } from '../output/safety.js';
import type { CommandDeps } from './deps.js';
import {
  buildNameMap,
  loadTeams,
  parsePickSpec,
  resolvePlayerTokens,
  teamLabel,
} from './shared.js';

/** Proposal lifetime, matching the 48 hours the web client defaults to. */
const DEFAULT_TRADE_TTL_HOURS = 48;

interface TradeOptions {
  league?: string;
  with?: string;
  receive?: string[];
  send?: string[];
  pick?: string[];
  faab?: string;
  counter?: string;
  counterLeg?: string;
  expires?: string;
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

/** A proposal as shown to the user, resolved from the mutations' own encoding. */
interface ProposalView {
  transaction_id: string;
  type: string;
  status: string;
  leg: number | null;
  created: number;
  side: SideView;
  my_roster_id: number;
  counterparty_roster_id: number;
}

/** Parse every `--pick` value, reporting all malformed ones together. */
function parsePickSpecs(specs: string[] | undefined): DraftPickRef[] {
  const picks: DraftPickRef[] = [];
  const problems: string[] = [];

  for (const spec of specs ?? []) {
    const parsed = parsePickSpec(spec);
    if (parsed.ok) picks.push(parsed.value);
    else problems.push(parsed.error);
  }
  if (problems.length > 0) {
    throw new UsageError(`Invalid --pick value(s): ${problems.join('; ')}`);
  }
  return picks;
}

/** The pick portion of a human-readable proposal summary. */
function pickText(picks: readonly DraftPickRef[]): string {
  return picks.length > 0 ? `, picks ${picks.map((p) => `R${p.round}`).join(', ')}` : '';
}

/** Load pending proposals involving a roster, newest first. */
async function loadProposals(
  deps: CommandDeps,
  leagueId: string,
  rosterId: number,
  limit: number,
): Promise<{ views: ProposalView[]; limitations: string[] }> {
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
      type: 'trade',
      week,
      limit,
    },
  );

  const views = transactions
    .filter((tx) => tx.status === 'proposed' || tx.status === 'pending')
    .filter((tx) => (tx.roster_ids ?? []).includes(rosterId))
    .map((tx) => {
      const other = (tx.roster_ids ?? []).find((id) => id !== rosterId) ?? null;
      return {
        transaction_id: tx.transaction_id,
        type: tx.type,
        status: tx.status,
        leg: tx.leg,
        created: tx.created,
        side: viewForRoster(tx, rosterId),
        my_roster_id: rosterId,
        counterparty_roster_id: other ?? 0,
      };
    })
    .sort((a, b) => b.created - a.created);

  return { views, limitations };
}

export function registerTradeCommands(program: Command, deps: CommandDeps): void {
  const trade = program.command('trade').description('Propose, accept, and reject trades');

  // -------------------------------------------------------------- propose
  trade
    .command('propose')
    .description('Propose a trade')
    .option('-l, --league <id>', 'league to act in')
    .requiredOption('-w, --with <rosterId>', 'roster id of the counterparty')
    .option('-r, --receive <players...>', 'players you will receive')
    .option('-s, --send <players...>', 'players you will send')
    .option('-p, --pick <spec...>', 'draft pick as ROSTER_ID:ROUND[:SEASON]')
    .option('--faab <amount>', 'FAAB to attach to the trade')
    .option('--counter <transactionId>', 'counter a rejected proposal instead of opening a new one')
    .option('--counter-leg <n>', 'leg of the proposal being countered')
    .option('--expires <hours>', 'hours until the proposal expires', '48')
    .addHelpText(
      'after',
      [
        '',
        'Player ids and exact Sleeper names are both accepted.',
        '',
        'Examples:',
        '  sleeper trade propose --with 3 --receive 1309 --send 486',
        '  sleeper trade propose --with 3 --send "Josh Allen" --pick 2:1 --dry-run',
        '  sleeper trade propose --with 3 --receive 1309 --faab 5',
        '',
        'The --pick roster id is the CURRENT owner of the pick, which in a two-team',
        'trade is the counterparty.',
      ].join('\n'),
    )
    .action(async (options: TradeOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      client.requireSession();

      const leagueId = await client.resolveLeagueId(options.league);
      const counterpartyId = Number(options.with);
      if (!Number.isInteger(counterpartyId) || counterpartyId < 1) {
        throw new UsageError(`Invalid counterparty roster id: ${options.with}`);
      }

      const myRosterId = await client.resolveRosterId(leagueId);
      if (counterpartyId === myRosterId) {
        throw new UsageError(
          'You cannot trade with your own roster',
          'Pass a different --with roster id.',
        );
      }

      const receive = options.receive?.length
        ? await resolvePlayerTokens(client, options.receive)
        : [];
      const send = options.send?.length ? await resolvePlayerTokens(client, options.send) : [];

      const picks = parsePickSpecs(options.pick);

      const input = {
        leagueId,
        // The value on each kmap entry is the player's current owner: the counterparty
        // for what you receive, you for what you send. Inverting these reverses the
        // trade, so it is built once here and reused for both the preview and the send.
        adds: toRosterMap(receive, counterpartyId),
        drops: toRosterMap(send, myRosterId),
        ...(picks.length > 0 ? { picks } : {}),
        ...(options.faab
          ? {
              faab: {
                fromRosterId: myRosterId,
                toRosterId: counterpartyId,
                amount: Number(options.faab),
              },
            }
          : {}),
        ...(options.counter
          ? {
              counterTransaction: {
                transactionId: options.counter,
                leg: Number(options.counterLeg ?? 0),
              },
            }
          : {}),
        expiresAt: Date.now() + Number(options.expires ?? DEFAULT_TRADE_TTL_HOURS) * 3_600_000,
      };
      const operation = buildProposeTradeOperation(input);

      if (context.explain) {
        emit.emitJsonPayload(operation);
        return;
      }

      const { teams } = await loadTeams(client, leagueId);
      const counterparty = teamLabel(teams.get(counterpartyId), counterpartyId);
      const names = await buildNameMap(client, [...receive, ...send]);
      const label = (ids: readonly string[]): string =>
        ids.length === 0 ? 'nothing' : ids.map((id) => names.get(id) ?? id).join(', ');

      const legs = pickText(picks);
      const faabText = options.faab ? `, ${options.faab} FAAB` : '';
      const outbound = `${label(send)}${legs}${faabText}`;

      if (context.dryRun) {
        emit.emit({
          command: deps.commandPath(),
          data: {
            dry_run: true,
            league_id: leagueId,
            you: myRosterId,
            counterparty: counterpartyId,
            receive,
            send,
            picks,
            operation,
          },
          table: () =>
            [
              'Dry run — nothing was sent.',
              '',
              `  you send     : ${outbound}`,
              `  you receive  : ${label(receive)}`,
              `  counterparty : ${counterparty} (roster ${counterpartyId})`,
            ].join('\n'),
        });
        return;
      }

      await confirmAction(
        `trade with ${counterparty} (roster ${counterpartyId}): you send ${outbound} and receive ${label(receive)}`,
        context,
      );
      const result = await proposeTrade(client.graphql, input);

      emit.emit({
        command: deps.commandPath(),
        data: {
          transaction_id: result.transaction_id,
          status: result.status,
          leg: result.leg,
          league_id: leagueId,
          counterparty: counterpartyId,
          receive,
          send,
        },
        table: () =>
          [
            `Trade proposed to ${counterparty}.`,
            `  transaction : ${result.transaction_id}`,
            `  status      : ${result.status}`,
            `  expires in  : ${options.expires ?? DEFAULT_TRADE_TTL_HOURS}h`,
          ].join('\n'),
      });
    });

  // ------------------------------------------------------------------ list
  trade
    .command('list [leagueId]')
    .description('List pending trade proposals involving you')
    .option('-n, --limit <count>', 'maximum rows', '25')
    .action(async (leagueId: string | undefined, options: TradeOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);
      const rosterId = await client.resolveRosterId(resolved);
      const { teams } = await loadTeams(client, resolved);

      const { views, limitations } = await loadProposals(
        deps,
        resolved,
        rosterId,
        Number(options.limit ?? 25),
      );
      for (const note of limitations) emit.warn(note);

      const names = await buildNameMap(
        client,
        views.flatMap((view) => [...view.side.received, ...view.side.sent]),
      );
      const label = (ids: readonly string[]): string =>
        ids.length === 0 ? '—' : ids.map((id) => names.get(id) ?? id).join(', ');

      const rows = views.map((view) => ({
        ...view,
        counterparty: teamLabel(
          teams.get(view.counterparty_roster_id),
          view.counterparty_roster_id,
        ),
        you_send: label([...view.side.sent, ...view.side.picksOut.map((r) => `pick ${r}`)]),
        you_receive: label([...view.side.received, ...view.side.picksIn.map((r) => `pick ${r}`)]),
      }));

      emit.emit({
        command: deps.commandPath(),
        data: { league_id: resolved, roster_id: rosterId, pending: rows },
        table: () => ({
          columns: [
            column('transaction', (row: (typeof rows)[number]) => row.transaction_id, {
              maxWidth: 22,
            }),
            column('with', (row: (typeof rows)[number]) => row.counterparty, { maxWidth: 24 }),
            column('leg', (row: (typeof rows)[number]) => row.leg, { align: 'right' }),
            column('you send', (row: (typeof rows)[number]) => row.you_send, { maxWidth: 30 }),
            column('you receive', (row: (typeof rows)[number]) => row.you_receive, {
              maxWidth: 30,
            }),
            column('created', (row: (typeof rows)[number]) => formatTimestamp(row.created)),
          ],
          rows,
          emptyMessage: 'No pending trade proposals.',
        }),
      });
    });

  // ------------------------------------------------------------------ show
  trade
    .command('show <transactionId> [leagueId]')
    .description('Show one trade proposal in full')
    .action(async (transactionId: string, leagueId: string | undefined, options: TradeOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);
      const rosterId = await client.resolveRosterId(resolved);

      const week = await client
        .state()
        .then((s) => s.week)
        .catch(() => 1);
      const { transactions } = await getTransactionsWithPending(client.graphql, client.rest, {
        leagueId: resolved,
        week,
        limit: 100,
      });
      const tx = transactions.find((entry) => entry.transaction_id === transactionId);
      if (!tx) {
        throw new UsageError(
          `Transaction ${transactionId} not found in week ${week}`,
          'A proposal is only visible in the week it was made. Check the id, or pass the right week.',
        );
      }

      const side = viewForRoster(tx, rosterId);
      const names = await buildNameMap(client, [...side.received, ...side.sent]);
      const { teams } = await loadTeams(client, resolved);
      const label = (ids: readonly string[]): string =>
        ids.length === 0 ? '—' : ids.map((id) => names.get(id) ?? id).join(', ');

      emit.emit({
        command: deps.commandPath(),
        data: { ...tx, from_your_perspective: side },
        table: () =>
          [
            renderRecord(
              {
                transaction: tx.transaction_id,
                type: tx.type,
                status: tx.status,
                leg: tx.leg,
                created: formatTimestamp(tx.created),
                parties: (tx.roster_ids ?? [])
                  .map((id) => teamLabel(teams.get(id), id))
                  .join(' vs '),
              },
              { indent: 2 },
            ),
            `\n  you send     : ${label(side.sent)}`,
            `  you receive  : ${label(side.received)}`,
            `  picks out    : ${side.picksOut.length > 0 ? side.picksOut.map((r) => `R${r}`).join(', ') : '—'}`,
            `  picks in     : ${side.picksIn.length > 0 ? side.picksIn.map((r) => `R${r}`).join(', ') : '—'}`,
            `  faab         : ${side.faabOut > 0 ? `-${side.faabOut}` : side.faabIn > 0 ? `+${side.faabIn}` : '—'}`,
          ].join('\n'),
      });
    });

  // ------------------------------------------------------- accept / reject
  for (const action of ['accept', 'reject'] as const) {
    trade
      .command(`${action} <transactionId>`)
      .description(
        action === 'accept' ? 'Accept a pending trade proposal' : 'Reject a pending trade proposal',
      )
      .option('-l, --league <id>', 'league the trade belongs to')
      .option('--leg <n>', 'matchup week of the proposal; inferred when omitted')
      .action(async (transactionId: string, options: TradeOptions) => {
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
            `Could not determine the week for transaction ${transactionId}`,
            'Pass --leg with the matchup week the proposal was made in.',
          );
        }

        const operation = buildTradeResponseOperation({ leagueId, transactionId, leg, action });
        if (context.explain) {
          emit.emitJsonPayload(operation);
          return;
        }
        if (context.dryRun) {
          emit.emit({
            command: deps.commandPath(),
            data: { dry_run: true, action, ...operation.variables },
            table: () =>
              `Dry run — would ${action} trade ${transactionId} (leg ${leg}). Nothing was sent.`,
          });
          return;
        }

        await confirmAction(`${action} trade ${transactionId}`, context);
        const result = await respondToTrade(client.graphql, {
          leagueId,
          transactionId,
          leg,
          action,
        });

        emit.emit({
          command: deps.commandPath(),
          data: {
            action,
            transaction_id: result.transaction_id,
            status: result.status,
            leg: result.leg,
          },
          table: () => `Trade ${action}ed. Status is now ${result.status}.`,
        });
      });
  }
}

/**
 * Infer a transaction's leg from the current week's feed.
 *
 * Sleeper stamps a transaction with the week it belongs to, but the REST feed is
 * week-scoped, so a proposal made last week needs `--leg` explicitly. Returning
 * undefined rather than guessing keeps a wrong-week accept from failing obscurely.
 */
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
