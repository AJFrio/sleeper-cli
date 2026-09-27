/**
 * `sleeper lineup` — reading and setting a weekly lineup.
 *
 * Reads are free. `set` and `bench-all` are mutations and go through
 * `confirmAction`, so a non-interactive invocation without `--yes` fails with exit
 * code 8 rather than hanging or, worse, proceeding unasked.
 */

import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { type Player, playerName } from '../core/types.js';
import {
  buildSetLineupOperation,
  expectedStarterCount,
  setLineup,
  validateLineup,
} from '../domain/lineup.js';
import { getMatchups, type MatchupWithTeams, pairMatchups } from '../domain/matchups.js';
import { parseStatField } from '../domain/stats.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { renderTable } from '../output/format.js';
import { confirmAction } from '../output/safety.js';
import type { CommandDeps } from './deps.js';
import { buildNameMap, loadTeams, resolvePlayerTokens, teamLabel } from './shared.js';

interface LineupOptions {
  week?: string;
  league?: string;
  rosterId?: string;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/** A player as presented in lineup output. */
interface PlayerRow {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  status: string | null;
  injury: string | null;
  projected: number | null;
}

function rosterColumns() {
  return [
    column('id', (row: PlayerRow) => row.player_id),
    column('player', (row: PlayerRow) => row.name, { maxWidth: 26 }),
    column('pos', (row: PlayerRow) => row.position),
    column('team', (row: PlayerRow) => row.team),
    column('status', (row: PlayerRow) => row.status, { maxWidth: 18 }),
    column('proj', (row: PlayerRow) => (row.projected === null ? null : row.projected.toFixed(2)), {
      align: 'right',
    }),
  ];
}

function toPlayerRow(player: Player | undefined, id: string, projected: number | null): PlayerRow {
  return {
    player_id: id,
    name: player ? playerName(player) : id,
    position: player?.fantasy_positions?.join('/') ?? player?.position ?? null,
    team: player?.team ?? null,
    status: player?.status ?? null,
    injury: player?.injury_status ?? null,
    projected,
  };
}

/**
 * Fetch per-player projected points for a week.
 *
 * Sleeper's public projections endpoint returns every player keyed by id with a
 * `stats` object holding several scoring variants. Failures are swallowed and yield
 * an empty map: projections are legitimately unavailable early in a week and in the
 * offseason, and that should degrade the display rather than fail the command.
 */
async function fetchProjections(
  deps: CommandDeps,
  playerIds: readonly string[],
  week: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (playerIds.length === 0) return out;

  const client = deps.client();
  const state = await client.state().catch(() => null);
  if (!state) return out;

  try {
    const raw = await client.rest.get<Record<string, { stats?: unknown } | null>>(
      `/projections/${client.sport}/${state.season}/${week}`,
      { season_type: 'regular' },
    );
    for (const id of playerIds) {
      const stats = parseStatField(raw[id]?.stats);
      const value = stats.pts ?? stats.pts_ppr ?? stats.pts_std;
      if (typeof value === 'number') out.set(id, value);
    }
  } catch {
    return out;
  }
  return out;
}

/** Build display rows for a set of player ids. */
async function playerRows(
  deps: CommandDeps,
  playerIds: readonly string[],
  projections: Map<string, number>,
): Promise<PlayerRow[]> {
  const players = await deps.client().playersByIds(playerIds);
  return playerIds.map((id) => toPlayerRow(players.get(id), id, projections.get(id) ?? null));
}

/**
 * Whether a roster slot can hold a given player.
 *
 * Sleeper names its flex slots explicitly and each admits a documented set, so the
 * check is against those names rather than a hardcoded league format.
 */
function slotAccepts(slot: string, positions: readonly string[]): boolean {
  const wanted = slot.toUpperCase();
  const primary = (positions[0] ?? '').toUpperCase();
  const set = new Set(positions.map((p) => p.toUpperCase()));

  switch (wanted) {
    case 'FLEX':
      return set.has('WR') || set.has('RB') || set.has('TE');
    case 'SUPER_FLEX':
      return ['QB', 'RB', 'WR', 'TE'].includes(primary);
    case 'WRRB':
    case 'WRRB_FLEX':
      return ['WR', 'RB'].includes(primary);
    case 'REC':
    case 'REC_FLEX':
      return ['WR', 'TE'].includes(primary);
    case 'DST':
    case 'DEF':
      return primary === 'DEF';
    case 'BN':
      return true;
    default:
      return primary === wanted || set.has(wanted);
  }
}

/**
 * Fill the league's slot list greedily by projection.
 *
 * Slots are walked in the order Sleeper declares them, which is the order the UI
 * shows, and each takes the best eligible player not already used. A greedy pass is
 * not globally optimal when slots overlap, but it is predictable and it never places
 * a player in an ineligible slot, which is the property that actually matters here.
 */
function suggestLineup(
  slots: readonly string[],
  candidates: readonly string[],
  positions: ReadonlyMap<string, string[]>,
  projections: ReadonlyMap<string, number>,
): { slot: string; player_id: string; projected: number | null }[] {
  const taken = new Set<string>();
  const out: { slot: string; player_id: string; projected: number | null }[] = [];

  for (const slot of slots) {
    if (slot.toUpperCase() === 'BN') continue;

    let best: string | undefined;
    let bestValue = Number.NEGATIVE_INFINITY;

    for (const id of candidates) {
      if (taken.has(id)) continue;
      if (!slotAccepts(slot, positions.get(id) ?? [])) continue;
      const value = projections.get(id) ?? Number.NEGATIVE_INFINITY;
      if (value > bestValue) {
        best = id;
        bestValue = value;
      }
    }
    if (best === undefined) continue;

    taken.add(best);
    out.push({ slot, player_id: best, projected: projections.get(best) ?? null });
  }
  return out;
}

export function registerLineupCommands(program: Command, deps: CommandDeps): void {
  const lineup = program.command('lineup').description('View, set, and optimise a weekly lineup');

  // ----------------------------------------------------------------- show
  lineup
    .command('show [leagueId]')
    .description('Show your current lineup with opponent and projections')
    .option('-w, --week <n>', 'matchup week (defaults to the current week)')
    .action(async (leagueId: string | undefined, options: LineupOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);

      const week = options.week ? Number(options.week) : (await client.state()).display_week;
      const { rosters, teams } = await loadTeams(client, resolved);
      const rosterId = await client.resolveRosterId(resolved);
      const roster = rosters.find((r) => r.roster_id === rosterId);
      if (!roster) throw new UsageError(`Roster ${rosterId} not found in league ${resolved}`);

      const legs = await getMatchups(client.graphql, { leagueId: resolved, week });
      const leg = pairMatchups(legs, teams).find((entry) => entry.roster_id === rosterId);

      const projections = await fetchProjections(deps, roster.starters, week);
      const starters = await playerRows(deps, roster.starters, projections);

      const reserveSet = new Set(roster.reserve ?? []);
      const taxiSet = new Set(roster.taxi ?? []);
      const deployed = new Set([...roster.starters, ...reserveSet, ...taxiSet]);
      const reserve = (roster.reserve ?? []).filter((id) => !roster.starters.includes(id));
      const taxi = (roster.taxi ?? []).filter(
        (id) => !roster.starters.includes(id) && !reserveSet.has(id),
      );
      const bench = roster.players.filter((id) => !deployed.has(id));

      emit.emit({
        command: deps.commandPath(),
        data: {
          league_id: resolved,
          week,
          roster_id: rosterId,
          manager: teamLabel(teams.get(rosterId), rosterId),
          opponent: leg?.opponent_display_name ?? null,
          points: leg?.points ?? null,
          projected: leg?.proj_points ?? null,
          starters,
          reserve: await playerRows(deps, reserve, projections),
          taxi: await playerRows(deps, taxi, projections),
          bench: await playerRows(deps, bench, projections),
        },
        table: () =>
          [
            `Week ${week} — ${teamLabel(teams.get(rosterId), rosterId)} vs ${leg?.opponent_display_name ?? 'bye week'}`,
            ...(leg?.points === null || leg?.points === undefined
              ? ['  Not yet scored']
              : [
                  `  Points ${leg.points.toFixed(2)}   Projected ${leg.proj_points?.toFixed(2) ?? '—'}`,
                ]),
            '',
            ...(starters.length > 0
              ? [renderTable({ columns: rosterColumns(), rows: starters })]
              : ['  No starters set. Try `sleeper lineup recommend`, then `sleeper lineup set`.']),
            `  Reserve ${reserve.length} · Taxi ${taxi.length} · Bench ${bench.length}`,
          ].join('\n'),
      });
    });

  // ------------------------------------------------------------------ set
  lineup
    .command('set <players...>')
    .description('Set your weekly starting lineup')
    .option('-l, --league <id>', 'league to act in')
    .option('--roster-id <n>', 'roster to act on (defaults to yours)')
    .addHelpText(
      'after',
      [
        '',
        'Player ids and exact Sleeper names are both accepted.',
        'Use --dry-run to preview, --explain to print the GraphQL request.',
        '',
        'Examples:',
        '  sleeper lineup set 486 1309 4045',
        '  sleeper lineup set "Josh Allen" "Stefon Diggs" --dry-run',
      ].join('\n'),
    )
    .action(async (players: string[], options: LineupOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      client.requireSession();

      const leagueId = await client.resolveLeagueId(options.league);
      const rosterId = await client.resolveRosterId(
        leagueId,
        options.rosterId ? Number(options.rosterId) : undefined,
      );

      const rosters = await client.rosters(leagueId);
      const roster = rosters.find((r) => r.roster_id === rosterId);
      if (!roster) throw new UsageError(`Roster ${rosterId} not found in league ${leagueId}`);

      const starters = await resolvePlayerTokens(client, players);
      const expected = expectedStarterCount(roster);
      const check = validateLineup(roster, starters, expected);
      if (!check.ok) {
        throw new UsageError(
          `Invalid lineup: ${check.problems.join('; ')}`,
          expected
            ? `This league fields ${expected} starters. Confirm the ids with \`sleeper lineup show\`.`
            : 'Confirm the ids with `sleeper lineup show`.',
        );
      }

      const operation = buildSetLineupOperation({ leagueId, rosterId, starters });
      if (context.explain) {
        emit.emitJsonPayload(operation);
        return;
      }

      const incoming = starters.filter((id) => !roster.starters.includes(id));
      const outgoing = roster.starters.filter((id) => !starters.includes(id));
      const names = await buildNameMap(client, [...incoming, ...outgoing, ...starters]);
      const label = (ids: readonly string[]): string =>
        ids.length === 0 ? '—' : ids.map((id) => names.get(id) ?? id).join(', ');

      if (context.dryRun) {
        emit.emit({
          command: deps.commandPath(),
          data: { dry_run: true, league_id: leagueId, roster_id: rosterId, starters, operation },
          table: () =>
            [
              'Dry run — nothing was sent.',
              '',
              `  starters : ${label(starters)}`,
              `  added    : ${label(incoming)}`,
              `  removed  : ${label(outgoing)}`,
            ].join('\n'),
        });
        return;
      }

      await confirmAction(
        `set your lineup to ${starters.length} players (in: ${label(incoming)}; out: ${label(outgoing)})`,
        context,
      );

      const result = await setLineup(client.graphql, { leagueId, rosterId, starters });
      emit.emit({
        command: deps.commandPath(),
        data: {
          league_id: leagueId,
          roster_id: rosterId,
          starters: result.starters,
          added: incoming,
          removed: outgoing,
        },
        table: () =>
          [
            `Lineup updated — ${result.starters.length} starters set.`,
            `  added   : ${label(incoming)}`,
            `  removed : ${label(outgoing)}`,
          ].join('\n'),
      });
    });

  // ------------------------------------------------------------ recommend
  lineup
    .command('recommend [leagueId]')
    .description('Suggest a lineup from projections. Read-only; changes nothing')
    .option('-w, --week <n>', 'matchup week (defaults to the current week)')
    .addHelpText(
      'after',
      '\nThis only prints a suggestion. Apply it with `sleeper lineup set <players...>`.',
    )
    .action(async (leagueId: string | undefined, options: LineupOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);

      const week = options.week ? Number(options.week) : (await client.state()).display_week;
      const { rosters, teams } = await loadTeams(client, resolved);
      const rosterId = await client.resolveRosterId(resolved);
      const roster = rosters.find((r) => r.roster_id === rosterId);
      if (!roster) throw new UsageError(`Roster ${rosterId} not found in league ${resolved}`);

      const league = await client.rest.getLeague(resolved);
      const legs = await getMatchups(client.graphql, { leagueId: resolved, week });
      const leg: MatchupWithTeams | undefined = pairMatchups(legs, teams).find(
        (entry) => entry.roster_id === rosterId,
      );

      // Only players slotted this week can be started, which is what the matchup leg
      // reports; fall back to the roster when there is no leg.
      const candidates = leg?.starters.length ? leg.starters : roster.starters;
      if (candidates.length === 0) {
        throw new UsageError(
          'No players are slotted this week',
          'Set a lineup first, or confirm the league is in season with `sleeper matchups week`.',
        );
      }

      const [projections, playerIndex] = await Promise.all([
        fetchProjections(deps, candidates, week),
        client.playersByIds(candidates),
      ]);
      const positions = new Map<string, string[]>();
      for (const [id, player] of playerIndex) {
        positions.set(id, player.fantasy_positions ?? []);
      }

      const slots = league.roster_positions?.filter((s) => s.toUpperCase() !== 'BN') ?? [];
      const suggestion = suggestLineup(slots, candidates, positions, projections);
      const names = await buildNameMap(
        client,
        suggestion.map((s) => s.player_id),
      );
      const total = suggestion.reduce((sum, s) => sum + (s.projected ?? 0), 0);

      emit.emit({
        command: deps.commandPath(),
        data: {
          league_id: resolved,
          roster_id: rosterId,
          week,
          current_projected: leg?.proj_points ?? null,
          suggested_projected: Math.round(total * 100) / 100,
          slots: suggestion.map((s) => ({ ...s, name: names.get(s.player_id) ?? s.player_id })),
        },
        table: () =>
          [
            `Suggested lineup — week ${week} (read-only, nothing was changed)`,
            `  current projection  ${leg?.proj_points?.toFixed(2) ?? '—'}`,
            `  suggested total     ${total.toFixed(2)}`,
            '',
            ...suggestion.map(
              (s) =>
                `  ${s.slot.padEnd(12)} ${(names.get(s.player_id) ?? s.player_id).padEnd(24)} ${s.projected?.toFixed(2) ?? '—'}`,
            ),
            '',
            'Apply with:',
            `  sleeper lineup set ${suggestion.map((s) => s.player_id).join(' ')}`,
          ].join('\n'),
      });
    });

  // ------------------------------------------------------------- bench-all
  lineup
    .command('bench-all [leagueId]')
    .description('DANGER: bench the entire roster by submitting an empty lineup')
    .addHelpText(
      'after',
      [
        '',
        'Submits an empty starters list, which benches every player and forfeits the',
        'week. It exists for the rare case where deliberately sitting everyone is',
        'correct. There is no undo.',
      ].join('\n'),
    )
    .action(async (leagueId: string | undefined, options: LineupOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      client.requireSession();

      const resolved = await client.resolveLeagueId(leagueId);
      const rosterId = await client.resolveRosterId(resolved);

      // Built inline rather than through buildSetLineupOperation, which rejects an
      // empty starters list on purpose: that guard is right for `set` and wrong here.
      const document = `
        mutation roster_update_starters($leagueId: String!, $rosterId: Int!, $starters: [String]) {
          roster_update_starters(league_id: $leagueId, roster_id: $rosterId, starters: $starters) {
            roster_id league_id starters
          }
        }
      `;
      const variables = { leagueId: resolved, rosterId, starters: [] };

      if (context.explain) {
        emit.emitJsonPayload({ document, variables });
        return;
      }
      if (context.dryRun) {
        emit.emit({
          command: deps.commandPath(),
          data: { dry_run: true, ...variables },
          table: () =>
            'Dry run — would submit an empty lineup and bench everyone. Nothing was sent.',
        });
        return;
      }

      await confirmAction(
        `bench your ENTIRE roster in league ${resolved}, forfeiting the week`,
        context,
      );
      await client.graphql.query(document, variables);

      emit.emit({
        command: deps.commandPath(),
        data: { league_id: resolved, roster_id: rosterId, starters: [] },
        table: () => 'Lineup emptied. Every player is now benched.',
      });
    });
}
