/**
 * `sleeper matchups` — scores, schedules, and the playoff bracket.
 *
 * Reads the GraphQL `matchup_legs` query rather than the REST equivalent, because
 * GraphQL separates starters from players cleanly and carries `proj_points`, which
 * REST omits entirely.
 */

import type { Command } from 'commander';
import { getMatchups, getPlayoffBracket, pairMatchups } from '../domain/matchups.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { renderRecord } from '../output/format.js';
import type { CommandDeps } from './deps.js';
import { loadTeams, teamLabel } from './shared.js';

interface MatchupOptions {
  week?: string;
  losers?: boolean;
  limit?: string;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/** One bracket row, after normalising Sleeper's loosely-typed payload. */
interface BracketRow {
  round: number;
  match: number;
  t1: string;
  t2: string;
  winner: string | null;
  loser: string | null;
  position: number | null;
}

/**
 * Normalise one bracket entry.
 *
 * A team slot is either a roster id or a `{w: n}` / `{l: n}` reference to another
 * match's winner or loser, and the endpoint returns the `Map` scalar untyped. Rather
 * than trusting a shape, every field is probed and anything unrecognised renders as a
 * dash, so a payload change degrades the display instead of throwing.
 */
function toBracketRow(
  raw: unknown,
  teams: ReadonlyMap<number, { roster_id: number }>,
  resolve: (id: number) => string,
): BracketRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;

  const round = typeof entry.r === 'number' ? entry.r : 0;
  const match = typeof entry.m === 'number' ? entry.m : 0;

  const slot = (value: unknown): string => {
    if (typeof value === 'number') return resolve(value);
    if (typeof value === 'object' && value !== null) {
      const ref = value as Record<string, unknown>;
      if (typeof ref.w === 'number') return `winner of M${ref.w}`;
      if (typeof ref.l === 'number') return `loser of M${ref.l}`;
    }
    return '—';
  };

  const name = (value: unknown): string | null => {
    if (typeof value !== 'number') return null;
    void teams;
    return resolve(value);
  };

  return {
    round,
    match,
    t1: slot(entry.t1),
    t2: slot(entry.t2),
    winner: name(entry.w),
    loser: name(entry.l),
    position: typeof entry.p === 'number' ? entry.p : null,
  };
}

/** Normalise the bracket payload into a list, whatever wrapper it arrived in. */
function extractBracketRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'object' && payload !== null) {
    for (const value of Object.values(payload as Record<string, unknown>)) {
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

export function registerMatchupCommands(program: Command, deps: CommandDeps): void {
  const matchups = program
    .command('matchups')
    .description('Scores, schedules, and playoff brackets');

  // ----------------------------------------------------------------- show
  matchups
    .command('show [leagueId]')
    .description('Show one week of matchups with scores and projections')
    .option('-w, --week <n>', 'matchup week (defaults to the current week)')
    .action(async (leagueId: string | undefined, options: MatchupOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);

      const week = options.week ? Number(options.week) : (await client.state()).display_week;
      const { teams } = await loadTeams(client, resolved);
      const legs = await getMatchups(client.graphql, { leagueId: resolved, week });
      const paired = pairMatchups(legs, teams);

      // One row per matchup, not per team, which is how a person reads a slate.
      const byMatchup = new Map<number, (typeof paired)[number]>();
      for (const leg of paired) {
        if (!byMatchup.has(leg.matchup_id)) byMatchup.set(leg.matchup_id, leg);
      }
      const rows = [...byMatchup.values()].sort((a, b) => a.matchup_id - b.matchup_id);

      emit.emit({
        command: deps.commandPath(),
        data: {
          league_id: resolved,
          week,
          matchups: rows.map((leg) => ({
            matchup_id: leg.matchup_id,
            roster_id: leg.roster_id,
            manager: teamLabel(teams.get(leg.roster_id), leg.roster_id),
            points: leg.points,
            projected: leg.proj_points,
            custom_points: leg.custom_points,
            max_points: leg.max_points,
            starters: leg.starters,
            players: leg.players,
            opponent: leg.opponent_roster_id
              ? {
                  roster_id: leg.opponent_roster_id,
                  manager: leg.opponent_display_name,
                  points: leg.opponent_points,
                }
              : null,
          })),
        },
        table: () => ({
          columns: [
            column('manager', (row: (typeof rows)[number]) => teamLabel(teams.get(row.roster_id)), {
              maxWidth: 24,
            }),
            column('pts', (row: (typeof rows)[number]) => row.points, { align: 'right' }),
            column('proj', (row: (typeof rows)[number]) => row.proj_points, { align: 'right' }),
            column('vs', (row: (typeof rows)[number]) => row.opponent_display_name ?? 'bye', {
              maxWidth: 24,
            }),
            column('opp pts', (row: (typeof rows)[number]) => row.opponent_points, {
              align: 'right',
            }),
            column(
              'margin',
              (row: (typeof rows)[number]) => {
                if (row.points === null || row.opponent_points === null) return null;
                return (row.points - row.opponent_points).toFixed(2);
              },
              { align: 'right' },
            ),
          ],
          rows,
          emptyMessage: `No matchups recorded for week ${week}.`,
        }),
      });
    });

  // ----------------------------------------------------------------- week
  matchups
    .command('week')
    .description('Show the current week and season')
    .action(async (_options: MatchupOptions) => {
      const context = buildContext(_options, deps.client().config.output);
      const emit = deps.emit();
      const state = await deps.client().state();

      emit.emit({
        command: deps.commandPath(),
        data: state,
        table: () =>
          renderRecord(
            {
              season: state.season,
              week: state.week,
              display_week: state.display_week,
              leg: state.leg,
              season_type: state.season_type,
              season_start: state.season_start_date,
              has_scores: state.season_has_scores,
            },
            { indent: 2 },
          ),
      });
      void context;
    });

  // -------------------------------------------------------------- bracket
  matchups
    .command('bracket [leagueId]')
    .description('Show the playoff bracket')
    .option('--losers', 'show the consolation bracket instead')
    .action(async (leagueId: string | undefined, options: MatchupOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);

      const { teams } = await loadTeams(client, resolved);
      const resolve = (rosterId: number): string => teamLabel(teams.get(rosterId), rosterId);
      const kind = options.losers ? 'losers' : 'winners';

      const payload = await getPlayoffBracket(client.graphql, resolved, kind);
      const rows = extractBracketRows(payload)
        .map((entry) => toBracketRow(entry, teams, resolve))
        .filter((row): row is BracketRow => row !== null)
        .sort((a, b) => a.round - b.round || a.match - b.match);

      emit.emit({
        command: deps.commandPath(),
        data: { league_id: resolved, bracket: kind, rounds: rows },
        table: () => ({
          columns: [
            column('round', (row: BracketRow) => row.round, { align: 'right' }),
            column('match', (row: BracketRow) => row.match, { align: 'right' }),
            column('t1', (row: BracketRow) => row.t1, { maxWidth: 26 }),
            column('t2', (row: BracketRow) => row.t2, { maxWidth: 26 }),
            column('winner', (row: BracketRow) => row.winner, { maxWidth: 22 }),
            column('seed', (row: BracketRow) => row.position, { align: 'right' }),
          ],
          rows,
          emptyMessage: `No ${kind} bracket exists for this league.`,
        }),
      });
    });
}
