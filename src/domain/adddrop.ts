/**
 * Free-agent adds and drops.
 *
 * Both are the same mutation, `league_create_transaction`, differing only in the
 * `type` argument. The kmap/vmap encoding is the load-bearing part; see
 * docs/INTERNAL-API.md section 4 and core/kmap.ts.
 *
 * Worth internalising: for `adds` the value is the **destination** roster, and for
 * `drops` it is the **source** roster. That is what lets a single mutation express
 * both halves of a trade without extra parameters.
 */

import { UsageError } from '../core/errors.js';
import type { GraphQLClient } from '../core/graphql.js';
import { type RosterMap, toGraphQLKmapArgs, toRosterMap } from '../core/kmap.js';
import type { Transaction } from '../core/types.js';

/** Transaction types Sleeper accepts here. */
export type AddDropType = 'free_agent' | 'waiver';

export interface AddDropInput {
  leagueId: string;
  type: AddDropType;
  /** Player ids being added, mapped to the roster receiving them. */
  adds: RosterMap;
  /** Player ids being dropped, mapped to the roster losing them. */
  drops: RosterMap;
}

export interface AddDropResult {
  transaction_id: string;
  type: string;
  status: string;
  leg: number | null;
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  roster_ids: number[];
}

/**
 * Build the add/drop operation.
 *
 * Rejects a no-op up front: a transaction with neither adds nor drops is what a
 * mistyped player id looks like, and Sleeper would reject it with an opaque error.
 */
export function buildAddDropOperation(input: AddDropInput): {
  document: string;
  variables: Record<string, unknown>;
} {
  const addCount = Object.keys(input.adds).length;
  const dropCount = Object.keys(input.drops).length;

  if (addCount === 0 && dropCount === 0) {
    throw new UsageError('Nothing to add or drop', 'Pass at least one --add or --drop player.');
  }

  const overlap = Object.keys(input.adds).filter((id) => id in input.drops);
  if (overlap.length > 0) {
    throw new UsageError(
      `Player(s) appear in both --add and --drop: ${overlap.join(', ')}`,
      'A single transaction cannot add and drop the same player. Use two calls if that is intended.',
    );
  }

  return {
    document: `
      mutation league_create_transaction(
        $leagueId: String!  $type: String!
        $k_adds: [String]  $v_adds: [Int]  $k_drops: [String]  $v_drops: [Int]
      ) {
        league_create_transaction(
          league_id: $leagueId, type: $type,
          k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops
        ) {
          transaction_id type status leg adds drops roster_ids
        }
      }
    `,
    variables: {
      leagueId: input.leagueId,
      type: input.type,
      ...toGraphQLKmapArgs({ adds: input.adds, drops: input.drops }),
    },
  };
}

/** Add or drop players as a free agent. */
export async function addDrop(graphql: GraphQLClient, input: AddDropInput): Promise<AddDropResult> {
  const { document, variables } = buildAddDropOperation(input);
  const data = await graphql.query<{ league_create_transaction: AddDropResult }>(
    document,
    variables,
  );
  const result = data.league_create_transaction;

  if (!result) {
    throw new UsageError('Sleeper accepted the request but returned no transaction');
  }
  return result;
}

/** Convenience wrapper for the common case: add and drop for a single roster. */
export function addDropForRoster(input: {
  leagueId: string;
  rosterId: number;
  add?: readonly string[];
  drop?: readonly string[];
  type?: AddDropType;
}): AddDropInput {
  return {
    leagueId: input.leagueId,
    type: input.type ?? 'free_agent',
    adds: input.add?.length ? toRosterMap(input.add, input.rosterId) : {},
    drops: input.drop?.length ? toRosterMap(input.drop, input.rosterId) : {},
  };
}

/**
 * Summarise a transaction for human display.
 *
 * Adds and drops come back as `{ player_id: roster_id }`, so this renders them in
 * the same "you give / you get" shape a trade does.
 */
export function describeTransaction(
  tx: Pick<Transaction, 'type' | 'status' | 'adds' | 'drops' | 'draft_picks' | 'waiver_budget'>,
): { acquires: string[]; relinquishes: string[]; picks: number; faab: number } {
  return {
    acquires: Object.keys(tx.adds ?? {}),
    relinquishes: Object.keys(tx.drops ?? {}),
    picks: Array.isArray(tx.draft_picks) ? tx.draft_picks.length : 0,
    faab: (tx.waiver_budget ?? []).reduce((sum, entry) => sum + entry.amount, 0),
  };
}
