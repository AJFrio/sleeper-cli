/**
 * Matchups, standings and playoff brackets.
 *
 * GraphQL is preferred over the public REST matchups endpoint because it separates
 * `starters` from `players` more cleanly and carries `proj_points`, which REST
 * omits. Both are reconciled here so callers see one shape.
 */

import type { GraphQLClient } from '../core/graphql.js';
import type { MatchupLeg, Roster } from '../core/types.js';

export interface MatchupQuery {
  leagueId: string;
  /** Matchup week. Sleeper calls this the leg; the CLI exposes it as a week. */
  week: number;
}

export interface MatchupWithTeams extends MatchupLeg {
  /** Display name of the manager, joined from the league's user list. */
  display_name: string | null;
  team_name: string | null;
  /** Opponent's roster id within the same matchup, if there is one. */
  opponent_roster_id: number | null;
  opponent_points: number | null;
  opponent_display_name: string | null;
}

const MATCHUP_LEGS = `
  query matchup_legs($leagueId: String!, $week: Int!) {
    matchup_legs(league_id: $leagueId, round: $week) {
      league_id
      leg
      round
      matchup_id
      roster_id
      points
      proj_points
      max_points
      custom_points
      starters
      players
      subs
    }
  }
`;

/** Build the matchup operation. */
export function buildMatchupOperation(query: MatchupQuery): {
  document: string;
  variables: Record<string, unknown>;
} {
  return {
    document: MATCHUP_LEGS,
    variables: { leagueId: query.leagueId, week: query.week },
  };
}

/** Fetch one week's matchups. */
export async function getMatchups(
  graphql: GraphQLClient,
  query: MatchupQuery,
): Promise<MatchupLeg[]> {
  const { document, variables } = buildMatchupOperation(query);
  const data = await graphql.query<{ matchup_legs: MatchupLeg[] }>(document, variables);
  return data.matchup_legs ?? [];
}

/**
 * Attach manager names and pair each side against its opponent.
 *
 * Sleeper returns one row per team, with two rows sharing a `matchup_id`. An
 * unmatched row, which happens in a bye week, gets a null opponent rather than
 * being dropped.
 */
export function pairMatchups(
  legs: readonly MatchupLeg[],
  teams: ReadonlyMap<number, { display_name: string | null; team_name: string | null }>,
): MatchupWithTeams[] {
  const byMatchup = new Map<number, MatchupLeg[]>();
  for (const leg of legs) {
    const bucket = byMatchup.get(leg.matchup_id);
    if (bucket) bucket.push(leg);
    else byMatchup.set(leg.matchup_id, [leg]);
  }

  return legs.map((leg) => {
    const opponents = (byMatchup.get(leg.matchup_id) ?? []).filter(
      (other) => other.roster_id !== leg.roster_id,
    );
    const opponent = opponents[0];
    const team = teams.get(leg.roster_id);

    return {
      ...leg,
      display_name: team?.display_name ?? null,
      team_name: team?.team_name ?? null,
      opponent_roster_id: opponent?.roster_id ?? null,
      opponent_points: opponent?.points ?? null,
      opponent_display_name: opponent
        ? (teams.get(opponent.roster_id)?.display_name ?? null)
        : null,
    };
  });
}

export interface Standing {
  roster_id: number;
  display_name: string | null;
  team_name: string | null;
  wins: number;
  losses: number;
  ties: number;
  /** Points for, including the decimal part. */
  points_for: number;
  points_against: number;
  playoff_seed: number | null;
  division: number | null;
  waiver_position: number | null;
}

/** Reduce rosters to a standings table, sorted the way Sleeper sorts them. */
export function buildStandings(
  rosters: readonly Roster[],
  teams: ReadonlyMap<number, { display_name: string | null; team_name: string | null }>,
): Standing[] {
  const standings = rosters.map((roster) => {
    const settings = roster.settings ?? {};
    const team = teams.get(roster.roster_id);
    return {
      roster_id: roster.roster_id,
      display_name: team?.display_name ?? null,
      team_name: team?.team_name ?? null,
      wins: numberOr(settings.wins, 0),
      losses: numberOr(settings.losses, 0),
      ties: numberOr(settings.ties, 0),
      // `fpts` truncates; the decimal variant is authoritative when present.
      points_for: numberOr(settings.fpts_decimal, numberOr(settings.fpts, 0)) / 100,
      points_against:
        numberOr(settings.fpts_against_decimal, numberOr(settings.fpts_against, 0)) / 100,
      playoff_seed: typeof settings.playoff_seed === 'number' ? settings.playoff_seed : null,
      division: typeof settings.division === 'number' ? settings.division : null,
      waiver_position:
        typeof settings.waiver_position === 'number' ? settings.waiver_position : null,
    };
  });

  return standings.sort((a, b) => {
    if (a.playoff_seed !== null && b.playoff_seed !== null) {
      return a.playoff_seed - b.playoff_seed;
    }
    const pctA = winPct(a);
    const pctB = winPct(b);
    if (pctA !== pctB) return pctB - pctA;
    return b.points_for - a.points_for;
  });
}

function winPct(standing: Standing): number {
  const games = standing.wins + standing.losses + standing.ties;
  if (games === 0) return 0;
  return (standing.wins + standing.ties * 0.5) / games;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Fetch a playoff bracket. Sleeper returns the map form on the GraphQL endpoint. */
export async function getPlayoffBracket(
  graphql: GraphQLClient,
  leagueId: string,
  kind: 'winners' | 'losers' = 'winners',
): Promise<unknown> {
  const field = kind === 'winners' ? 'league_playoff_bracket' : 'league_playoff_loser_bracket';
  const data = await graphql.query<Record<string, unknown>>(
    `query ${field}($leagueId: String!) { ${field}(league_id: $leagueId) }`,
    { leagueId },
  );
  return data[field] ?? null;
}
