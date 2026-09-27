/**
 * `sleeper roster` — the signed-in user's own roster, and how it is deployed.
 */

import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { playerName } from '../core/types.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { renderTable } from '../output/format.js';
import type { CommandDeps } from './deps.js';
import { loadTeams, teamLabel } from './shared.js';

interface RosterOptions {
  rosterId?: string;
  league?: string;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

interface RosterPlayer {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  status: string | null;
  injury: string | null;
  slot: string;
}

export function registerRosterCommands(program: Command, deps: CommandDeps): void {
  const roster = program
    .command('roster')
    .description('Show a roster and how it is deployed')
    .alias('team');

  roster
    .command('show [leagueId]')
    .description('Show your roster: starters, reserve, taxi, and bench')
    .option('-l, --league <id>', 'league to inspect')
    .option('--roster-id <n>', "show a different manager's roster")
    .action(async (leagueId: string | undefined, options: RosterOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();

      const resolved = await client.resolveLeagueId(leagueId ?? options.league);
      const { rosters, teams } = await loadTeams(client, resolved);
      const rosterId = await client.resolveRosterId(
        resolved,
        options.rosterId ? Number(options.rosterId) : undefined,
      );

      const target = rosters.find((entry) => entry.roster_id === rosterId);
      if (!target) throw new UsageError(`Roster ${rosterId} not found in league ${resolved}`);

      const players = await client.playersByIds(target.players);
      const label = (id: string): string => playerName(players.get(id));

      const toRow = (id: string, slot: string): RosterPlayer => {
        const player = players.get(id);
        return {
          player_id: id,
          name: label(id),
          position: player?.fantasy_positions?.join('/') ?? player?.position ?? null,
          team: player?.team ?? null,
          status: player?.status ?? null,
          injury: player?.injury_status ?? null,
          slot,
        };
      };

      const starterSet = new Set(target.starters);
      const reserveSet = new Set(target.reserve ?? []);
      const taxiSet = new Set(target.taxi ?? []);

      const starters = target.starters.map((id) => toRow(id, 'starter'));
      const reserve = (target.reserve ?? [])
        .filter((id) => !starterSet.has(id))
        .map((id) => toRow(id, 'reserve'));
      const taxi = (target.taxi ?? [])
        .filter((id) => !starterSet.has(id) && !reserveSet.has(id))
        .map((id) => toRow(id, 'taxi'));
      const deployed = new Set([...starterSet, ...reserveSet, ...taxiSet]);
      const bench = target.players
        .filter((id) => !deployed.has(id))
        .map((id) => toRow(id, 'bench'));

      const settings = target.settings ?? {};
      const info = teams.get(rosterId);

      const columns = () => [
        column('id', (row: RosterPlayer) => row.player_id),
        column('player', (row: RosterPlayer) => row.name, { maxWidth: 26 }),
        column('pos', (row: RosterPlayer) => row.position),
        column('team', (row: RosterPlayer) => row.team),
        column('status', (row: RosterPlayer) => row.status, { maxWidth: 18 }),
        column('injury', (row: RosterPlayer) => row.injury),
      ];

      emit.emit({
        command: deps.commandPath(),
        data: {
          league_id: resolved,
          roster_id: rosterId,
          owner: {
            user_id: target.owner_id,
            display_name: info?.display_name ?? null,
            team_name: info?.team_name ?? null,
          },
          record: {
            wins: typeof settings.wins === 'number' ? settings.wins : null,
            losses: typeof settings.losses === 'number' ? settings.losses : null,
            ties: typeof settings.ties === 'number' ? settings.ties : null,
          },
          points_for: typeof settings.fpts === 'number' ? settings.fpts : null,
          points_against: typeof settings.fpts_against === 'number' ? settings.fpts_against : null,
          starters,
          reserve,
          taxi,
          bench,
        },
        table: () => {
          const blocks: string[] = [
            `${teamLabel(info, rosterId)} — roster ${rosterId}, league ${resolved}`,
            `Record ${settings.wins ?? 0}-${settings.losses ?? 0}-${settings.ties ?? 0}   ` +
              `PF ${settings.fpts ?? 0}   PA ${settings.fpts_against ?? 0}`,
          ];
          for (const [labelText, rows] of [
            ['STARTERS', starters],
            ['RESERVE', reserve],
            ['TAXI', taxi],
            ['BENCH', bench],
          ] as const) {
            if (rows.length === 0) continue;
            blocks.push(
              '',
              `${labelText} (${rows.length})`,
              renderTable({ columns: columns(), rows }),
            );
          }
          return blocks.join('\n');
        },
      });
    });
}
