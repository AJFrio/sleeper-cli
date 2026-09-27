/**
 * Trade proposals and responses.
 *
 * A trade proposal is one mutation, `propose_trade`, carrying both halves of the
 * deal as kmap pairs: what you acquire under `adds`, what you relinquish under
 * `drops`, with the roster id on each side identifying the counterparty. Draft picks
 * and FAAB ride along as JSON strings.
 *
 * ## Verification status
 *
 * `propose_trade` and its siblings are not present in Sleeper's public page bundle —
 * they load only for authenticated users — so their exact argument encoding comes
 * from schema introspection rather than from reading the call site. The player
 * half of the payload is confirmed by the shared kmap convention. The `draft_picks`
 * encoding is the one part still unverified against a live league; see
 * `encodeDraftPicks` for what is assumed and how to override it.
 */

import { UsageError } from '../core/errors.js';
import type { GraphQLClient } from '../core/graphql.js';
import { type RosterMap, toGraphQLKmapArgs } from '../core/kmap.js';
import type { Transaction } from '../core/types.js';

export interface DraftPickRef {
  /** Round of the pick being traded. */
  round: number;
  /** Roster id of the pick's **current** holder. In a two-team trade, the counterparty. */
  rosterId: number;
  /**
   * Season the pick belongs to.
   *
   * Required unless `defaultSeason` is supplied to the encoder, since the wire format
   * has no room for an absent season.
   */
  season?: number;
  /**
   * Roster id of the pick's **original** slot owner.
   *
   * Defaults to `rosterId`. These differ once a pick has been traded onward, at which
   * point the original owner is what Sleeper needs to preserve the pick's lineage.
   */
  originalOwnerRosterId?: number;
  /** Roster id receiving the pick. Defaults to `rosterId`, i.e. a pick comes home. */
  toRosterId?: number;
}

export interface ProposeTradeInput {
  leagueId: string;
  /** Players received, mapped to the roster that sends them. */
  adds: RosterMap;
  /** Players sent, mapped to the roster that receives them. */
  drops: RosterMap;
  /** Draft picks changing hands. */
  picks?: DraftPickRef[];
  /** FAAB changing hands, as a send/receive pair. */
  faab?: { fromRosterId: number; toRosterId: number; amount: number };
  /** Absolute expiry in epoch milliseconds. Sleeper defaults this when omitted. */
  expiresAt?: number;
  /** Season assumed for any pick that does not name one. */
  defaultSeason?: number;
  /** Counter a rejected proposal rather than opening a new negotiation. */
  counterTransaction?: { transactionId: string; leg: number };
}

export interface ProposeTradeResult {
  transaction_id: string;
  type: string;
  status: string;
  leg: number | null;
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  roster_ids: number[];
}

/** Default proposal lifetime. Sleeper shows pending trades for two days. */
export const DEFAULT_TRADE_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Serialise draft picks for the `draft_picks` argument.
 *
 * The argument is `[String]`, not a JSON string, so each pick is one
 * comma-separated record of five integers:
 *
 *     originalOwnerRoster,season,round,fromRoster,toRoster
 *
 * That field order is the same as the public REST `traded_picks` payload
 * (`roster_id`, `season`, `round`, `previous_owner_id`, `owner_id`), which is the
 * corroboration for the format: the two shapes describe the same object.
 *
 * `originalOwnerRoster` and `fromRoster` are frequently the same team, the difference
 * being that `original` is the pick's slot owner and `from` is who holds it now.
 *
 * A pick whose season is not supplied inherits the league season, because a future
 * pick is not a thing you trade in a redraft league.
 */
export function encodeDraftPicks(picks: readonly DraftPickRef[], defaultSeason?: number): string[] {
  return picks.map((pick) => {
    const season = pick.season ?? defaultSeason;
    if (season === undefined) {
      throw new UsageError(
        `Cannot encode pick ${pick.rosterId}:${pick.round} without a season`,
        'Pass the season explicitly, e.g. --pick 2:1:2027.',
      );
    }
    const original = pick.originalOwnerRosterId ?? pick.rosterId;
    const from = pick.rosterId;
    return `${original},${season},${pick.round},${from},${pick.toRosterId ?? pick.rosterId}`;
  });
}

/**
 * Serialise the FAAB leg for the `waiver_budget` argument, which is `[String]`.
 *
 * Each entry is three dash-separated integers: `fromRoster-toRoster-amount`.
 */
export function encodeWaiverBudget(faab: ProposeTradeInput['faab']): string[] | undefined {
  if (!faab) return undefined;
  return [`${faab.fromRosterId}-${faab.toRosterId}-${faab.amount}`];
}

/** Parse Sleeper's comma-separated draft pick records back into structured picks. */
export function decodeDraftPicks(raw: readonly string[]): {
  originalOwnerRosterId: number;
  season: number;
  round: number;
  fromRosterId: number;
  toRosterId: number;
}[] {
  return raw.flatMap((entry) => {
    const parts = entry.split(',').map((part) => Number(part.trim()));
    if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return [];
    const [originalOwnerRosterId, season, round, fromRosterId, toRosterId] = parts;
    if (
      originalOwnerRosterId === undefined ||
      season === undefined ||
      round === undefined ||
      fromRosterId === undefined ||
      toRosterId === undefined
    ) {
      return [];
    }
    return [{ originalOwnerRosterId, season, round, fromRosterId, toRosterId }];
  });
}

function validate(input: ProposeTradeInput): void {
  const addCount = Object.keys(input.adds).length;
  const dropCount = Object.keys(input.drops).length;
  const pickCount = input.picks?.length ?? 0;

  if (addCount === 0 && dropCount === 0 && pickCount === 0) {
    throw new UsageError(
      'A trade must offer something',
      'Provide players with --send/--receive, or a draft pick with --pick.',
    );
  }

  // Giving something away with nothing coming back is a giveaway, and is almost
  // always a sign the caller mixed up the direction of the trade.
  if (dropCount > 0 && addCount === 0 && pickCount === 0) {
    throw new UsageError(
      'This trade sends players and receives nothing',
      'If that is genuinely intended, add the players you expect back with --receive.',
    );
  }

  if (input.faab && (!Number.isFinite(input.faab.amount) || input.faab.amount < 0)) {
    throw new UsageError(
      `Invalid FAAB amount: ${input.faab.amount}`,
      'FAAB must be a non-negative number.',
    );
  }
}

/** Build the propose-trade operation, for dry runs and `--explain`. */
export function buildProposeTradeOperation(input: ProposeTradeInput): {
  document: string;
  variables: Record<string, unknown>;
} {
  validate(input);

  const draftPicks = input.picks?.length
    ? encodeDraftPicks(input.picks, input.defaultSeason)
    : undefined;
  const waiverBudget = encodeWaiverBudget(input.faab);

  return {
    document: `
      mutation propose_trade(
        $leagueId: String!
        $k_adds: [String]  $v_adds: [Int]  $k_drops: [String]  $v_drops: [Int]
        $draftPicks: [String]  $waiverBudget: [String]  $expiresAt: Int
        $rejectTransactionId: String  $rejectTransactionLeg: Int
      ) {
        propose_trade(
          league_id: $leagueId,
          k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops,
          draft_picks: $draftPicks, waiver_budget: $waiverBudget, expires_at: $expiresAt,
          reject_transaction_id: $rejectTransactionId, reject_transaction_leg: $rejectTransactionLeg
        ) {
          transaction_id type status leg adds drops roster_ids
        }
      }
    `,
    variables: {
      leagueId: input.leagueId,
      ...toGraphQLKmapArgs({ adds: input.adds, drops: input.drops }),
      // Omitted rather than sent as an empty array: Sleeper rejects empty arrays on
      // these arguments.
      ...(draftPicks ? { draftPicks } : {}),
      ...(waiverBudget ? { waiverBudget } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.counterTransaction
        ? {
            rejectTransactionId: input.counterTransaction.transactionId,
            rejectTransactionLeg: input.counterTransaction.leg,
          }
        : {}),
    },
  };
}

/** Propose a trade. */
export async function proposeTrade(
  graphql: GraphQLClient,
  input: ProposeTradeInput,
): Promise<ProposeTradeResult> {
  const { document, variables } = buildProposeTradeOperation(input);
  const data = await graphql.query<{ propose_trade: ProposeTradeResult }>(document, variables);
  const result = data.propose_trade;

  if (!result) {
    throw new UsageError('Sleeper accepted the request but returned no transaction');
  }
  return result;
}

export type TradeResponseAction = 'accept' | 'reject';

/** Build the accept/reject operation. Both share a signature. */
export function buildTradeResponseOperation(input: {
  leagueId: string;
  transactionId: string;
  leg: number;
  action: TradeResponseAction;
}): { document: string; variables: Record<string, unknown> } {
  const field = input.action === 'accept' ? 'accept_trade' : 'reject_trade';
  return {
    document: `
      mutation ${field}($leagueId: String!, $transactionId: String!, $leg: Int) {
        ${field}(league_id: $leagueId, transaction_id: $transactionId, leg: $leg) {
          transaction_id type status leg adds drops roster_ids
        }
      }
    `,
    variables: {
      leagueId: input.leagueId,
      transactionId: input.transactionId,
      leg: input.leg,
    },
  };
}

/** Accept or reject a pending trade proposal. */
export async function respondToTrade(
  graphql: GraphQLClient,
  input: { leagueId: string; transactionId: string; leg: number; action: TradeResponseAction },
): Promise<Transaction> {
  const { document, variables } = buildTradeResponseOperation(input);
  const field = input.action === 'accept' ? 'accept_trade' : 'reject_trade';
  const data = await graphql.query<Record<string, Transaction>>(document, variables);
  const result = data[field];

  if (!result) {
    throw new UsageError(`Sleeper returned no transaction after ${input.action}ing the trade`);
  }
  return result;
}
