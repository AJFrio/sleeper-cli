/**
 * Waiver claims.
 *
 * `submit_waiver_claim` differs from a plain add/drop in one important way: the
 * claim is queued rather than applied, and it may carry a priority bid. That bid
 * travels as a kmap with the single key `waiver_bid`.
 *
 * The web client omits both halves of the settings kmap when the object is empty,
 * because Sleeper rejects empty arrays on these arguments. That guard is reproduced
 * in `toGraphQLKmapArgs`.
 */

import { UsageError } from '../core/errors.js';
import type { GraphQLClient } from '../core/graphql.js';
import { type RosterMap, type SettingMap, toGraphQLKmapArgs } from '../core/kmap.js';
import type { Transaction } from '../core/types.js';

export interface SubmitWaiverInput {
  leagueId: string;
  /** Players being claimed, mapped to the roster claiming them. */
  adds: RosterMap;
  /** Players being dropped to make room, mapped to the roster losing them. */
  drops: RosterMap;
  /** Priority bid in FAAB. Omit for leagues without a waiver budget. */
  bid?: number;
  /** Optional note shown to the league, e.g. a reason for the claim. */
  note?: string;
}

export interface WaiverResult {
  transaction_id: string;
  type: string;
  status: string;
  leg: number | null;
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  roster_ids: number[];
}

/** Assemble the settings kmap a waiver claim carries. */
export function buildWaiverSettings(input: { bid?: number; note?: string }): SettingMap {
  const settings: SettingMap = {};
  if (input.bid !== undefined) settings.waiver_bid = input.bid;
  return settings;
}

/** Assemble the metadata kmap a waiver claim carries. */
export function buildWaiverMetadata(input: { note?: string }): SettingMap {
  return input.note ? { note: input.note } : {};
}

/** Build the submit operation, for dry runs and `--explain`. */
export function buildSubmitWaiverOperation(input: SubmitWaiverInput): {
  document: string;
  variables: Record<string, unknown>;
} {
  if (Object.keys(input.adds).length === 0) {
    throw new UsageError(
      'A waiver claim must request at least one player',
      'Pass --add with one or more player ids or names.',
    );
  }

  if (input.bid !== undefined && (!Number.isFinite(input.bid) || input.bid < 0)) {
    throw new UsageError(
      `Invalid waiver bid: ${input.bid}`,
      'The bid must be a non-negative number of FAAB.',
    );
  }

  return {
    document: `
      mutation submit_waiver_claim(
        $leagueId: String!
        $k_adds: [String] $v_adds: [Int] $k_drops: [String] $v_drops: [Int]
        $k_settings: [String] $v_settings: [Int]
        $k_metadata: [String] $v_metadata: [String]
      ) {
        submit_waiver_claim(
          league_id: $leagueId,
          k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops,
          k_settings: $k_settings, v_settings: $v_settings,
          k_metadata: $k_metadata, v_metadata: $v_metadata
        ) {
          transaction_id type status leg adds drops roster_ids
        }
      }
    `,
    variables: {
      leagueId: input.leagueId,
      ...toGraphQLKmapArgs({
        adds: input.adds,
        drops: input.drops,
        settings: buildWaiverSettings(input),
        metadata: buildWaiverMetadata(input),
      }),
    },
  };
}

/** Submit a waiver claim. */
export async function submitWaiver(
  graphql: GraphQLClient,
  input: SubmitWaiverInput,
): Promise<WaiverResult> {
  const { document, variables } = buildSubmitWaiverOperation(input);
  const data = await graphql.query<{ submit_waiver_claim: WaiverResult }>(document, variables);
  const result = data.submit_waiver_claim;

  if (!result) {
    throw new UsageError('Sleeper accepted the claim but returned no transaction');
  }
  return result;
}

export interface WaiverEditInput {
  leagueId: string;
  transactionId: string;
  leg: number;
  bid?: number;
  note?: string;
}

/** Build the edit operation for a pending claim. */
export function buildUpdateWaiverOperation(input: WaiverEditInput): {
  document: string;
  variables: Record<string, unknown>;
} {
  const settings = buildWaiverSettings(input);
  const metadata = buildWaiverMetadata(input);

  if (Object.keys(settings).length === 0 && Object.keys(metadata).length === 0) {
    throw new UsageError(
      'Nothing to change about this waiver claim',
      'Pass --bid to change the priority, or --note to change the reason.',
    );
  }

  return {
    document: `
      mutation update_waiver_claim(
        $leagueId: String!  $transactionId: String!  $leg: Int
        $k_settings: [String] $v_settings: [Int]
        $k_metadata: [String] $v_metadata: [String]
      ) {
        update_waiver_claim(
          league_id: $leagueId, transaction_id: $transactionId, leg: $leg,
          k_settings: $k_settings, v_settings: $v_settings,
          k_metadata: $k_metadata, v_metadata: $v_metadata
        ) {
          transaction_id type status leg adds drops roster_ids
        }
      }
    `,
    variables: {
      leagueId: input.leagueId,
      transactionId: input.transactionId,
      leg: input.leg,
      ...toGraphQLKmapArgs({ settings, metadata }),
    },
  };
}

/** Change the bid or note on a pending claim. */
export async function updateWaiver(
  graphql: GraphQLClient,
  input: WaiverEditInput,
): Promise<Transaction> {
  const { document, variables } = buildUpdateWaiverOperation(input);
  const data = await graphql.query<{ update_waiver_claim: Transaction }>(document, variables);
  const result = data.update_waiver_claim;

  if (!result) {
    throw new UsageError('Sleeper returned no transaction after updating the claim');
  }
  return result;
}

/** Build the cancel operation. */
export function buildCancelWaiverOperation(input: {
  leagueId: string;
  transactionId: string;
  leg: number;
}): { document: string; variables: Record<string, unknown> } {
  return {
    document: `
      mutation cancel_waiver_claim($leagueId: String!, $transactionId: String!, $leg: Int) {
        cancel_waiver_claim(league_id: $leagueId, transaction_id: $transactionId, leg: $leg) {
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

/** Withdraw a pending claim. */
export async function cancelWaiver(
  graphql: GraphQLClient,
  input: { leagueId: string; transactionId: string; leg: number },
): Promise<Transaction> {
  const { document, variables } = buildCancelWaiverOperation(input);
  const data = await graphql.query<{ cancel_waiver_claim: Transaction }>(document, variables);
  const result = data.cancel_waiver_claim;

  if (!result) {
    throw new UsageError('Sleeper returned no transaction after cancelling the claim');
  }
  return result;
}

/**
 * The highest bid a claim must beat to be guaranteed a chance.
 *
 * With FAAB leagues this is the standing priority plus one, per Sleeper's own
 * guidance. Without FAAB there is no priority to compute, so the claim is a pure
 * priority queue and this returns undefined.
 */
export function suggestedBid(currentStandingPriority: number | undefined): number | undefined {
  if (currentStandingPriority === undefined) return undefined;
  return currentStandingPriority + 1;
}
