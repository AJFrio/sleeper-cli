/**
 * Lineup management: setting a weekly lineup, as a manager or as a commissioner.
 *
 * `roster_update_starters` is the ordinary path. `update_matchup_leg` is the
 * commissioner's path, and behaves differently in a way that matters: it takes a
 * `leg` (the matchup week) in addition to the roster, and it can carry a `subs`
 * map used for games played on Thursday night.
 */

import { UsageError } from '../core/errors.js';
import type { GraphQLClient } from '../core/graphql.js';
import type { Roster } from '../core/types.js';

export interface SetLineupInput {
  leagueId: string;
  rosterId: number;
  /** Player ids in the desired order. Order is positional in Sleeper's UI. */
  starters: string[];
}

export interface SetLineupResult {
  roster_id: number;
  league_id: string;
  owner_id: string | null;
  starters: string[];
  players: string[];
  reserve: string[] | null;
  taxi: string[] | null;
}

const SET_LINEUP = `
  mutation roster_update_starters($leagueId: String!, $rosterId: Int!, $starters: [String]) {
    roster_update_starters(league_id: $leagueId, roster_id: $rosterId, starters: $starters) {
      roster_id
      league_id
      owner_id
      starters
      players
      reserve
      taxi
    }
  }
`;

/** Build the document and variables for a lineup change, for `--explain`. */
export function buildSetLineupOperation(input: SetLineupInput): {
  document: string;
  variables: Record<string, unknown>;
} {
  if (input.starters.length === 0) {
    throw new UsageError(
      'Cannot set an empty lineup',
      'An empty starters list would bench the whole roster. Pass --bench-all to do that deliberately.',
    );
  }

  return {
    document: SET_LINEUP,
    variables: {
      leagueId: input.leagueId,
      rosterId: input.rosterId,
      starters: input.starters,
    },
  };
}

/** Apply a weekly lineup. */
export async function setLineup(
  graphql: GraphQLClient,
  input: SetLineupInput,
): Promise<SetLineupResult> {
  const { document, variables } = buildSetLineupOperation(input);
  const data = await graphql.query<{ roster_update_starters: SetLineupResult }>(
    document,
    variables,
  );
  const result = data.roster_update_starters;

  if (!result) {
    throw new UsageError('Sleeper accepted the request but returned no roster');
  }
  return result;
}

export interface CommissionerLineupInput {
  leagueId: string;
  rosterId: number;
  /** The matchup week. Distinct from the current week for historical edits. */
  leg: number;
  round: number;
  starters: string[];
  /**
   * Thursday-night substitutions, keyed by player id.
   *
   * Sleeper models this as a `Map` scalar whose keys are the player ids being moved
   * and whose values are the ids replacing them.
   */
  subs?: Record<string, string>;
}

export interface MatchupLegResult {
  league_id: string;
  leg: number;
  round: number;
  matchup_id: number;
  roster_id: number;
  points: number | null;
  proj_points: number | null;
  max_points: number | null;
  custom_points: number | null;
  starters: string[];
  players: string[];
  subs: Record<string, string> | null;
}

/** Build the commissioner lineup operation, omitting `subs` when there are none. */
export function buildCommissionerLineupOperation(input: CommissionerLineupInput): {
  document: string;
  variables: Record<string, unknown>;
} {
  if (input.starters.length === 0) {
    throw new UsageError('Cannot set an empty lineup', 'Pass at least one starter.');
  }

  const hasSubs = input.subs !== undefined && Object.keys(input.subs).length > 0;
  const document = hasSubs
    ? `
      mutation update_matchup_leg(
        $leagueId: String!, $rosterId: Int!, $round: Int!, $leg: Int!
        $starters: [String], $subs: Map
      ) {
        update_matchup_leg(
          league_id: $leagueId, roster_id: $rosterId, round: $round, leg: $leg,
          starters: $starters, subs: $subs
        ) {
          league_id leg round matchup_id roster_id points proj_points max_points
          custom_points starters players subs
        }
      }
    `
    : `
      mutation update_matchup_leg(
        $leagueId: String!, $rosterId: Int!, $round: Int!, $leg: Int!, $starters: [String]
      ) {
        update_matchup_leg(
          league_id: $leagueId, roster_id: $rosterId, round: $round, leg: $leg,
          starters: $starters
        ) {
          league_id leg round matchup_id roster_id points proj_points max_points
          custom_points starters players subs
        }
      }
    `;

  return {
    document,
    variables: {
      leagueId: input.leagueId,
      rosterId: input.rosterId,
      round: input.round,
      leg: input.leg,
      starters: input.starters,
      ...(hasSubs ? { subs: input.subs } : {}),
    },
  };
}

/** Set or edit another manager's lineup. Commissioner only. */
export async function setCommissionerLineup(
  graphql: GraphQLClient,
  input: CommissionerLineupInput,
): Promise<MatchupLegResult> {
  const { document, variables } = buildCommissionerLineupOperation(input);
  const data = await graphql.query<{ update_matchup_leg: MatchupLegResult }>(document, variables);
  const result = data.update_matchup_leg;

  if (!result) {
    throw new UsageError('Sleeper accepted the request but returned no matchup leg');
  }
  return result;
}

/**
 * Reconcile a desired lineup against what a roster actually owns.
 *
 * Sleeper rejects a starters list containing a player the roster does not hold, and
 * rejects a starters count that does not match the league's lineup slots. Catching
 * both here turns both into precise messages instead of a generic rejection.
 */
export function validateLineup(
  roster: Roster,
  starters: string[],
  expectedSlots?: number,
): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const owned = new Set(roster.players);

  const notOwned = starters.filter((id) => !owned.has(id));
  if (notOwned.length > 0) {
    problems.push(`not on this roster: ${notOwned.join(', ')}`);
  }

  const duplicates = starters.filter((id, i) => starters.indexOf(id) !== i);
  if (duplicates.length > 0) {
    problems.push(`duplicated: ${[...new Set(duplicates)].join(', ')}`);
  }

  if (expectedSlots !== undefined && starters.length !== expectedSlots) {
    problems.push(`expected ${expectedSlots} starters, received ${starters.length}`);
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Count the lineup slots a league expects.
 *
 * Derived from the roster's current starter count rather than the league settings,
 * because the settings object uses several different key spellings across league
 * types and the existing starter count is authoritative for the current format.
 */
export function expectedStarterCount(roster: Roster): number | undefined {
  return roster.starters.length > 0 ? roster.starters.length : undefined;
}
