/**
 * `sleeper leagues` — discovering leagues and choosing the active one.
 *
 * Reads use the GraphQL `league_user_by_user` query where possible, which returns
 * every league in one authenticated call, and falls back to the public REST endpoint
 * for accounts that query does not cover.
 */

import type { Command } from 'commander';
import { updateConfig } from '../config/store.js';
import { NotFoundError, UsageError } from '../core/errors.js';
import { avatarUrl, type League } from '../core/types.js';
import { buildStandings } from '../domain/matchups.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { renderRecord } from '../output/format.js';
import type { CommandDeps } from './deps.js';
import { loadTeams, teamLabel } from './shared.js';

interface LeagueOptions {
  season?: string;
  limit?: string;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export function registerLeaguesCommands(program: Command, deps: CommandDeps): void {
  const leagues = program.command('leagues').description('List leagues and choose the active one');

  // ----------------------------------------------------------------- list
  leagues
    .command('list')
    .description('List every league you belong to')
    .option('--season <year>', 'season to list')
    .addHelpText('after', '\nThe active league is marked with * in the name column.')
    .action(async (options: LeagueOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const season = options.season ?? client.config.season ?? undefined;
      const found = await client.myLeagues(season);
      const active = client.config.active_league_id;

      emit.emit({
        command: deps.commandPath(),
        data: {
          season: season ?? null,
          active_league_id: active,
          leagues: found.map((league) => ({ ...league, is_active: league.league_id === active })),
        },
        table: () => ({
          columns: [
            column('', (league: (typeof found)[number]) =>
              league.league_id === active ? '*' : '',
            ),
            column('name', (league: (typeof found)[number]) => league.name, { maxWidth: 34 }),
            column('league id', (league: (typeof found)[number]) => league.league_id),
            column('status', (league: (typeof found)[number]) => league.status ?? null),
            column('week', (league: (typeof found)[number]) => league.current_week ?? null, {
              align: 'right',
            }),
            column('teams', (league: (typeof found)[number]) => league.total_rosters ?? null, {
              align: 'right',
            }),
          ],
          rows: found,
          emptyMessage: 'No leagues found. Confirm you are signed in with `sleeper auth status`.',
        }),
      });
    });

  // ------------------------------------------------------------------ use
  leagues
    .command('use <leagueId>')
    .description('Set the league that commands default to')
    .action(async (leagueId: string, options: LeagueOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();

      if (!/^\d+$/.test(leagueId)) {
        throw new UsageError(`Invalid league id: ${leagueId}`, 'Sleeper league ids are numeric.');
      }

      // Validate before persisting, so a typo does not become sticky state.
      let name = leagueId;
      try {
        const league = await deps.client().rest.getLeague(leagueId);
        name = league.name;
      } catch (err) {
        if (err instanceof NotFoundError) {
          throw new NotFoundError(
            'League',
            leagueId,
            'Run `sleeper leagues list` to see your leagues.',
          );
        }
        if (context.json) throw err;
        emit.warn(
          `Could not verify league ${leagueId} (${(err as Error).message}); setting it anyway.`,
        );
      }

      updateConfig({ active_league_id: leagueId });
      deps.client().setConfig({ ...deps.client().config, active_league_id: leagueId });

      emit.emit({
        command: deps.commandPath(),
        data: { active_league_id: leagueId, name },
        table: () => `Active league set to ${name} (${leagueId}).`,
      });
    });

  // -------------------------------------------------------------- current
  leagues
    .command('current [leagueId]')
    .description('Show the active league in detail')
    .action(async (leagueId: string | undefined, options: LeagueOptions) => {
      buildContext(options, deps.client().config.output);
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);
      const league = await client.rest.getLeague(resolved);
      const state = await client.state().catch(() => null);

      const scoring = league.scoring_settings ?? {};
      const rec = typeof scoring.rec === 'number' ? scoring.rec : null;

      emitLeagueDetail(deps, league, state?.week ?? null, rec);
    });

  // ------------------------------------------------------------- settings
  leagues
    .command('settings [leagueId]')
    .description('Dump league settings and scoring settings')
    .action(async (leagueId: string | undefined, options: LeagueOptions) => {
      buildContext(options, deps.client().config.output);
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);
      const league = await client.rest.getLeague(resolved);

      deps.emit().emit({
        command: deps.commandPath(),
        data: {
          league_id: league.league_id,
          name: league.name,
          settings: league.settings ?? {},
          scoring_settings: league.scoring_settings ?? {},
          roster_positions: league.roster_positions ?? [],
        },
        table: () =>
          [
            `\nRoster positions: ${(league.roster_positions ?? []).join(', ')}`,
            '\nSettings',
            renderRecord(flattenForDisplay(league.settings ?? {}), { indent: 2 }),
            '\nScoring settings',
            renderRecord(flattenForDisplay(league.scoring_settings ?? {}), { indent: 2 }),
          ].join('\n'),
      });
    });

  // ------------------------------------------------------------ standings
  leagues
    .command('standings [leagueId]')
    .description('Show the standings table')
    .action(async (leagueId: string | undefined, options: LeagueOptions) => {
      buildContext(options, deps.client().config.output);
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);
      const { rosters, teams } = await loadTeams(client, resolved);
      const standings = buildStandings(rosters, teams);
      const me = client.hasSession() ? await client.me().catch(() => null) : null;

      deps.emit().emit({
        command: deps.commandPath(),
        data: {
          league_id: resolved,
          standings: standings.map((row) => ({
            ...row,
            label: teamLabel(teams.get(row.roster_id), row.roster_id),
            is_you: me !== null && teams.get(row.roster_id)?.user_id === me.user_id,
          })),
        },
        table: () => ({
          columns: [
            column(
              '',
              (row: (typeof standings)[number]) =>
                row.playoff_seed === null ? '' : String(row.playoff_seed),
              {
                align: 'right',
              },
            ),
            column(
              'manager',
              (row: (typeof standings)[number]) => teamLabel(teams.get(row.roster_id)),
              {
                maxWidth: 30,
              },
            ),
            column('w', (row: (typeof standings)[number]) => row.wins, { align: 'right' }),
            column('l', (row: (typeof standings)[number]) => row.losses, { align: 'right' }),
            column('t', (row: (typeof standings)[number]) => row.ties, { align: 'right' }),
            column('pf', (row: (typeof standings)[number]) => row.points_for.toFixed(1), {
              align: 'right',
            }),
            column('pa', (row: (typeof standings)[number]) => row.points_against.toFixed(1), {
              align: 'right',
            }),
            column(
              'diff',
              (row: (typeof standings)[number]) => (row.points_for - row.points_against).toFixed(1),
              {
                align: 'right',
              },
            ),
            column('waiver', (row: (typeof standings)[number]) => row.waiver_position, {
              align: 'right',
            }),
          ],
          rows: standings,
          emptyMessage: 'No rosters found in this league.',
        }),
      });
    });

  // -------------------------------------------------------------- rosters
  leagues
    .command('rosters [leagueId]')
    .description('List every roster in the league')
    .action(async (leagueId: string | undefined, options: LeagueOptions) => {
      buildContext(options, deps.client().config.output);
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);
      const { rosters, teams } = await loadTeams(client, resolved);

      deps.emit().emit({
        command: deps.commandPath(),
        data: {
          league_id: resolved,
          rosters: rosters.map((roster) => {
            const info = teams.get(roster.roster_id);
            const settings = roster.settings ?? {};
            return {
              roster_id: roster.roster_id,
              manager: info?.display_name ?? null,
              team_name: info?.team_name ?? null,
              username: info?.username ?? null,
              wins: typeof settings.wins === 'number' ? settings.wins : null,
              losses: typeof settings.losses === 'number' ? settings.losses : null,
              ties: typeof settings.ties === 'number' ? settings.ties : null,
              players: roster.players.length,
              starters: roster.starters.length,
            };
          }),
        },
        table: () => ({
          columns: [
            column('roster', (row: (typeof rosters)[number]) => row.roster_id, { align: 'right' }),
            column(
              'manager',
              (row: (typeof rosters)[number]) => teamLabel(teams.get(row.roster_id)),
              {
                maxWidth: 30,
              },
            ),
            column('record', (row: (typeof rosters)[number]) => {
              const s = row.settings ?? {};
              return `${s.wins ?? 0}-${s.losses ?? 0}-${s.ties ?? 0}`;
            }),
            column('players', (row: (typeof rosters)[number]) => row.players.length, {
              align: 'right',
            }),
            column('starters', (row: (typeof rosters)[number]) => row.starters.length, {
              align: 'right',
            }),
          ],
          rows: rosters,
          emptyMessage: 'No rosters found in this league.',
        }),
      });
    });
}

function emitLeagueDetail(
  deps: CommandDeps,
  league: League,
  week: number | null,
  rec: number | null,
): void {
  deps.emit().emit({
    command: deps.commandPath(),
    data: { ...league, scoring_summary: describeScoring(rec) },
    table: () =>
      renderRecord(
        {
          name: league.name,
          league_id: league.league_id,
          status: league.status ?? null,
          season: league.season ?? null,
          season_type: league.season_type ?? null,
          current_week: week,
          rosters: league.total_rosters ?? null,
          scoring: describeScoring(rec),
          roster_positions: (league.roster_positions ?? []).join(' '),
          avatar: avatarUrl(league.avatar),
        },
        { indent: 2 },
      ),
  });
}

/** Name the scoring format, since `scoring_settings.rec` is the only reliable tell. */
function describeScoring(rec: number | null): string | null {
  if (rec === null) return null;
  if (rec === 1) return 'PPR';
  if (rec === 0.5) return 'Half-PPR';
  if (rec === 0) return 'Standard';
  return `${rec} PPR`;
}

/**
 * Flatten nested settings for display.
 *
 * League settings nest one or two levels (`playoff_round_type.division_1` and so on),
 * which renders as unreadable JSON in a terminal; joining the key path reads better
 * and still round-trips as a key/value list.
 */
function flattenForDisplay(
  input: Record<string, unknown>,
  prefix = '',
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenForDisplay(value as Record<string, unknown>, path));
    } else if (Array.isArray(value)) {
      out[path] = value.join(', ');
    } else if (typeof value === 'object') {
      out[path] = null;
    } else {
      out[path] = (value as string | number | null) ?? null;
    }
  }
  return out;
}
