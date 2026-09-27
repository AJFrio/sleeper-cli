/**
 * `sleeper draft` — reading draft boards.
 *
 * Draft actions live on the same internal GraphQL API as everything else, but
 * picking in a live draft is a time-critical action where a wrong pick is very hard
 * to walk back, so this module is read-only. Drafting itself is deliberately left to
 * the web app.
 */

import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { type DraftPick, playerName } from '../core/types.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { formatTimestamp } from '../output/format.js';
import type { CommandDeps } from './deps.js';
import { loadTeams, teamLabel } from './shared.js';

interface DraftOptions {
  league?: string;
  season?: string;
  round?: string;
  keepersOnly?: boolean;
  limit?: string;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

interface PickRow {
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number | null;
  manager: string;
  player_id: string | null;
  name: string;
  position: string | null;
  team: string | null;
  is_keeper: boolean;
}

export function registerDraftCommands(program: Command, deps: CommandDeps): void {
  const draft = program.command('draft').description('Inspect draft history and draft boards');

  // ----------------------------------------------------------------- list
  draft
    .command('list [leagueId]')
    .description("List a league's drafts, newest first")
    .option('-s, --season <year>', 'restrict to one season')
    .action(async (leagueId: string | undefined, options: DraftOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);

      const drafts = await client.rest.getLeagueDrafts(resolved);
      const filtered = options.season
        ? drafts.filter((entry) => entry.season === options.season)
        : drafts;

      emit.emit({
        command: deps.commandPath(),
        data: {
          league_id: resolved,
          drafts: filtered.map((entry, index) => ({
            draft_id: entry.draft_id,
            season: entry.season,
            season_type: entry.season_type,
            type: entry.type,
            status: entry.status,
            start_time: entry.start_time,
            is_latest: index === 0,
            previous_draft_id: entry.previous_draft_id ?? null,
          })),
        },
        table: () => ({
          columns: [
            column('', (row: (typeof filtered)[number]) =>
              row.draft_id === filtered[0]?.draft_id ? '*' : '',
            ),
            column(
              'season',
              (row: (typeof filtered)[number]) =>
                `${row.season} ${row.season_type === 'regular' ? '' : `(${row.season_type})`}`,
            ),
            column('type', (row: (typeof filtered)[number]) => row.type),
            column('status', (row: (typeof filtered)[number]) => row.status),
            column('starts', (row: (typeof filtered)[number]) => formatTimestamp(row.start_time)),
            column('draft id', (row: (typeof filtered)[number]) => row.draft_id, { maxWidth: 22 }),
          ],
          rows: filtered,
          emptyMessage: 'No drafts found for this league.',
        }),
      });
    });

  // ---------------------------------------------------------------- board
  draft
    .command('board [draftId]')
    .description("Show a draft board, defaulting to the league's most recent draft")
    .option('-l, --league <id>', 'league whose latest draft to show')
    .option('-r, --round <n>', 'restrict to one round')
    .option('--keepers-only', 'show only keeper picks')
    .option('-n, --limit <count>', 'maximum rows', '500')
    .action(async (draftId: string | undefined, options: DraftOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();

      let resolvedDraftId = draftId;
      let leagueId: string;

      if (resolvedDraftId) {
        const found = await client.rest.getDraft(resolvedDraftId);
        leagueId = found.league_id;
      } else {
        leagueId = await client.resolveLeagueId(options.league);
        const drafts = await client.rest.getLeagueDrafts(leagueId);
        const latest = drafts[0];
        if (!latest) {
          throw new UsageError(
            `League ${leagueId} has no drafts`,
            'Dynasty leagues keep history; check `sleeper draft list`.',
          );
        }
        resolvedDraftId = latest.draft_id;
      }

      const picks: DraftPick[] = await client.rest.getDraftPicks(resolvedDraftId);
      const { teams } = await loadTeams(client, leagueId);

      // Resolve every name in one pass: the player map is 5MB, so a per-pick lookup
      // would be unusably slow.
      const playerIds = picks
        .map((pick) => pick.player_id)
        .filter((id): id is string => id !== null);
      const players = await client.playersByIds(playerIds);
      const names = new Map([...players].map(([id, player]) => [id, playerName(player)]));

      const rows: PickRow[] = picks
        .filter((pick) => (options.round ? pick.round === Number(options.round) : true))
        .filter((pick) => (options.keepersOnly ? pick.is_keeper === true : true))
        .slice(0, Number(options.limit ?? 500))
        .map((pick) => {
          const player = pick.player_id ? players.get(pick.player_id) : undefined;
          const metadata = (pick.metadata ?? {}) as Record<string, unknown>;
          return {
            pick_no: pick.pick_no,
            round: pick.round,
            draft_slot: pick.draft_slot,
            roster_id: pick.roster_id,
            manager:
              pick.roster_id === null ? '—' : teamLabel(teams.get(pick.roster_id), pick.roster_id),
            player_id: pick.player_id,
            name: pick.player_id ? (names.get(pick.player_id) ?? pick.player_id) : '—',
            position: player?.position ?? (metadata.position as string | undefined) ?? null,
            team: player?.team ?? (metadata.team as string | undefined) ?? null,
            is_keeper: pick.is_keeper === true,
          };
        });

      emit.emit({
        command: deps.commandPath(),
        data: {
          league_id: leagueId,
          draft_id: resolvedDraftId,
          total_picks: picks.length,
          picks: rows,
        },
        table: () => ({
          columns: [
            column('#', (row: PickRow) => row.pick_no, { align: 'right' }),
            column('rd', (row: PickRow) => row.round, { align: 'right' }),
            column('slot', (row: PickRow) => row.draft_slot, { align: 'right' }),
            column('manager', (row: PickRow) => row.manager, { maxWidth: 24 }),
            column('player', (row: PickRow) => row.name, { maxWidth: 26 }),
            column('pos', (row: PickRow) => row.position),
            column('team', (row: PickRow) => row.team),
            column('K', (row: PickRow) => (row.is_keeper ? 'K' : '')),
          ],
          rows,
          emptyMessage: 'No picks on this draft board match the filters.',
        }),
      });
    });
}
