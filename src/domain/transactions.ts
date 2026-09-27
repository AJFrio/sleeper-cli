/**
 * Transaction reads, including the pending ones.
 *
 * This is a genuine gap in the public REST API: `GET /league/<id>/transactions/<week>`
 * returns only settled transactions, so a pending trade proposal or an unprocessed
 * waiver claim is invisible to it. The GraphQL `league_transactions` query returns
 * every status, which is the only way to show an agent what is awaiting a response.
 *
 * Status values observed on the live server: `proposed`, `complete`, `rejected`,
 * `cancelled` (British spelling), `vetoed`. Note that a pending trade reports as
 * `proposed`, not `pending` — filtering on the wrong one silently returns nothing.
 */

import type { GraphQLClient } from '../core/graphql.js';
import type { Transaction } from '../core/types.js';

/** Statuses Sleeper reports. `proposed` is what a pending trade shows as. */
export const TRANSACTION_STATUSES = [
  'proposed',
  'complete',
  'rejected',
  'cancelled',
  'vetoed',
  'pending',
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number] | (string & {});

export interface TransactionQuery {
  leagueId: string;
  /** Restrict to one status. Omit to get everything. */
  status?: TransactionStatus;
  /** Restrict to one kind: add, drop, trade, free_agent, waiver, draft. */
  type?: string;
  /** Restrict to one matchup week. */
  leg?: number;
  /** Restrict to a single roster. */
  rosterId?: number;
  limit?: number;
}

const LEAGUE_TRANSACTIONS = `
  query league_transactions(
    $leagueId: String!, $status: String, $type: String,
    $leg: Int, $rosterId: Int, $limit: Int
  ) {
    league_transactions(
      league_id: $leagueId, status: $status, type: $type,
      leg: $leg, roster_id: $rosterId, limit: $limit
    ) {
      transaction_id
      type
      status
      leg
      created
      status_updated
      roster_ids
      consenter_ids
      creator
      adds
      drops
      draft_picks
      waiver_budget
      settings
      metadata
    }
  }
`;

/** Build the transaction query, for `--explain`. */
export function buildTransactionQuery(query: TransactionQuery): {
  document: string;
  variables: Record<string, unknown>;
} {
  return {
    document: LEAGUE_TRANSACTIONS,
    variables: {
      leagueId: query.leagueId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.leg !== undefined ? { leg: query.leg } : {}),
      ...(query.rosterId !== undefined ? { rosterId: query.rosterId } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    },
  };
}

/** Fetch transactions, including pending ones. */
export async function getTransactions(
  graphql: GraphQLClient,
  query: TransactionQuery,
): Promise<Transaction[]> {
  const { document, variables } = buildTransactionQuery(query);
  const data = await graphql.query<{ league_transactions: Transaction[] }>(document, variables);
  return data.league_transactions ?? [];
}

/**
 * Fetch pending transactions, falling back to the REST API.
 *
 * GraphQL needs a session, so a caller without one still gets settled transactions
 * rather than an error. The fallback cannot see proposals, which the `limitations`
 * field makes explicit rather than leaving the caller to wonder why a list is short.
 */
export async function getTransactionsWithPending(
  graphql: GraphQLClient,
  rest: { getTransactions(leagueId: string, week: number): Promise<Transaction[]> },
  query: TransactionQuery & { week: number },
): Promise<{ transactions: Transaction[]; limitations: string[] }> {
  try {
    const transactions = await getTransactions(graphql, {
      leagueId: query.leagueId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.leg !== undefined ? { leg: query.leg } : {}),
      ...(query.rosterId !== undefined ? { rosterId: query.rosterId } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    return { transactions, limitations: [] };
  } catch {
    const transactions = await rest.getTransactions(query.leagueId, query.week);
    return {
      transactions,
      limitations: [
        'Showing settled transactions only. Pending proposals and unprocessed waiver ' +
          'claims require a signed-in session; run `sleeper auth login` to see them.',
      ],
    };
  }
}

/** Filter transactions down to those a given roster is party to. */
export function involvingRoster(
  transactions: readonly Transaction[],
  rosterId: number,
): Transaction[] {
  return transactions.filter((tx) => (tx.roster_ids ?? []).includes(rosterId));
}

/** Which pending transactions a roster is party to. */
export function pendingForRoster(
  transactions: readonly Transaction[],
  rosterId: number,
): Transaction[] {
  return involvingRoster(transactions, rosterId).filter(
    (tx) => tx.status === 'proposed' || tx.status === 'pending',
  );
}

/** A one-sided view of a trade or waiver from one roster's perspective. */
export interface SideView {
  /** Players arriving on the roster. */
  received: string[];
  /** Players leaving the roster. */
  sent: string[];
  /** Picks moving, described as round numbers. */
  picksOut: number[];
  picksIn: number[];
  /** FAAB moving, in the roster's favour. */
  faabIn: number;
  faabOut: number;
}

/**
 * Split a transaction into what a given roster gains and loses.
 *
 * `adds` maps player to the roster *receiving* it and `drops` maps player to the
 * roster *losing* it, so a roster's incoming players are the `adds` entries pointing
 * at it, and its outgoing players are the `drops` entries pointing at it.
 */
export function viewForRoster(tx: Transaction, rosterId: number): SideView {
  const received = Object.entries(tx.adds ?? {})
    .filter(([, target]) => target === rosterId)
    .map(([playerId]) => playerId);

  const sent = Object.entries(tx.drops ?? {})
    .filter(([, source]) => source === rosterId)
    .map(([playerId]) => playerId);

  const picksOut: number[] = [];
  const picksIn: number[] = [];
  for (const pick of Array.isArray(tx.draft_picks) ? tx.draft_picks : []) {
    if (typeof pick !== 'object' || pick === null) continue;
    const record = pick as Record<string, unknown>;
    const round = typeof record.round === 'number' ? record.round : undefined;
    if (round === undefined) continue;
    if (record.previous_owner_id === rosterId) picksOut.push(round);
    else if (record.owner_id === rosterId) picksIn.push(round);
  }

  let faabIn = 0;
  let faabOut = 0;
  for (const entry of tx.waiver_budget ?? []) {
    if (entry.receiver === rosterId) faabIn += entry.amount;
    if (entry.sender === rosterId) faabOut += entry.amount;
  }

  return { received, sent, picksOut, picksIn, faabIn, faabOut };
}

/** The FAAB priority a roster currently holds, or undefined when the league has none. */
export function waiverPriority(roster: {
  settings?: { waiver_position?: number } | null;
}): number | undefined {
  const value = roster.settings?.waiver_position;
  return typeof value === 'number' ? value : undefined;
}
