/**
 * `sleeper stats` — statistics and projections.
 *
 * The public REST player map carries no statistics whatsoever, so everything here
 * goes through GraphQL. The `category` argument selects a scoring breakdown and its
 * accepted values are sport-specific, so it is passed through rather than
 * constrained, with the common NFL values surfaced in the help text.
 */

import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { type Player, playerName } from '../core/types.js';
import {
  buildGameStatsOperation,
  buildPlayerStatsOperation,
  type GameStatLine,
  NFL_STAT_CATEGORIES,
  parseStatField,
} from '../domain/stats.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { renderRecord } from '../output/format.js';
import type { CommandDeps } from './deps.js';

interface StatsOptions {
  season?: string;
  week?: string;
  category?: string;
  position?: string;
  limit?: string;
  post?: boolean;
  projections?: boolean;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/** A stat line joined with the player's identity and points. */
interface StatRow {
  player_id: string;
  name: string;
  position: string | null;
  opponent: string | null;
  points: number | null;
}

/** Group stat lines into per-position leaderboards, truncated to `limit` each. */
function bucketLeaders(
  lines: readonly GameStatLine[],
  players: ReadonlyMap<string, Player>,
  options: { limit: number; position?: string },
): { position: string; rows: StatRow[] }[] {
  const byPosition = new Map<string, StatRow[]>();

  for (const line of lines) {
    const player = players.get(line.player_id);
    const points = parseStatField(line.stats).pts;
    if (typeof points !== 'number') continue;

    const position = player?.position ?? 'UNK';
    if (options.position && position.toUpperCase() !== options.position.toUpperCase()) continue;

    const row: StatRow = {
      player_id: line.player_id,
      name: playerName(player),
      position,
      opponent: line.opponent ?? null,
      points,
    };
    const bucket = byPosition.get(position);
    if (bucket) bucket.push(row);
    else byPosition.set(position, [row]);
  }

  return [...byPosition.entries()]
    .map(([position, rows]) => ({
      position,
      rows: rows.sort((a, b) => (b.points ?? 0) - (a.points ?? 0)).slice(0, options.limit),
    }))
    .sort((a, b) => a.position.localeCompare(b.position));
}

/** Coerce a loose stat object into a display record. */
function toDisplayRecord(
  input: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) out[key] = null;
    else if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value;
    } else out[key] = JSON.stringify(value);
  }
  return out;
}

export function registerStatsCommands(program: Command, deps: CommandDeps): void {
  const stats = program.command('stats').description('Fetch statistics and projections');

  // ---------------------------------------------------------------- player
  stats
    .command('player <playerId>')
    .description("Show one player's statistics")
    .option('-s, --season <year>', 'season (defaults to the current season)')
    .option('-w, --week <n>', 'single week instead of season totals')
    .option('-c, --category <cat>', `stat category (${NFL_STAT_CATEGORIES.join(', ')})`, 'pts')
    .option('--post', 'use postseason stats')
    .action(async (playerId: string, options: StatsOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      client.requireSession();

      const state = await client.state();
      const operation = buildPlayerStatsOperation({
        sport: client.sport,
        playerId,
        season: Number(options.season ?? state.season),
        ...(options.week ? { week: Number(options.week) } : {}),
        seasonType: options.post ? 'post' : 'regular',
        category: options.category ?? 'pts',
      });

      if (context.explain) {
        emit.emitJsonPayload(operation);
        return;
      }

      const players = await client.playersByIds([playerId]);
      const player = players.get(playerId);
      if (!player) {
        throw new UsageError(
          `Player ${playerId} not found`,
          'Check the id with `sleeper players search`.',
        );
      }

      const data = await client.graphql.query<{
        get_player_stats: { player_id: string; stat: Record<string, unknown> | null } | null;
      }>(operation.document, operation.variables);

      const raw = data.get_player_stats?.stat ?? null;

      emit.emit({
        command: deps.commandPath(),
        data: {
          player_id: playerId,
          name: playerName(player),
          position: player.fantasy_positions ?? [],
          season: operation.variables.season,
          week: operation.variables.week ?? null,
          category: options.category ?? 'pts',
          raw,
        },
        table: () =>
          [
            `${playerName(player)} — ${(player.fantasy_positions ?? []).join('/')}`,
            `season ${operation.variables.season}${operation.variables.week ? ` week ${operation.variables.week}` : ''}`,
            '',
            raw ? renderRecord(toDisplayRecord(raw), { indent: 2 }) : '  No statistics returned.',
          ].join('\n'),
      });
    });

  // ---------------------------------------------------------------- league
  stats
    .command('league [leagueId]')
    .description('Show league-wide stat lines for a season or week')
    .option('-s, --season <year>', 'season (defaults to the current season)')
    .option('-w, --week <n>', 'single week instead of season totals')
    .option('-c, --category <cat>', `stat category (${NFL_STAT_CATEGORIES.join(', ')})`, 'pts')
    .option('-n, --limit <count>', 'maximum rows', '25')
    .option('--projections', 'sum projections instead of actuals')
    .action(async (leagueId: string | undefined, options: StatsOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      client.requireSession();

      const state = await client.state();
      const operation = buildGameStatsOperation({
        sport: client.sport,
        season: Number(options.season ?? state.season),
        ...(options.week ? { week: Number(options.week) } : {}),
        seasonType: options.post ? 'post' : 'regular',
        category: options.category ?? 'pts',
      });

      if (context.explain) {
        emit.emitJsonPayload(operation);
        return;
      }

      const data = await client.graphql.query<{ game_stats: GameStatLine[] | null }>(
        operation.document,
        operation.variables,
      );
      const lines = data.game_stats ?? [];

      const ids = lines.map((line) => line.player_id);
      const [players, names] = await Promise.all([
        client.playersByIds(ids),
        client
          .playersByIds(ids)
          .then((map) => new Map([...map].map(([id, p]) => [id, playerName(p)]))),
      ]);

      const rows: StatRow[] = lines
        .map((line) => {
          const parsed = parseStatField(
            options.projections ? (line.projected_stats ?? line.stats) : line.stats,
          );
          return {
            player_id: line.player_id,
            name: names.get(line.player_id) ?? line.player_id,
            position: players.get(line.player_id)?.fantasy_positions?.join('/') ?? null,
            opponent: line.opponent ?? null,
            points: typeof parsed.pts === 'number' ? parsed.pts : null,
          };
        })
        .filter((row) =>
          options.position ? (row.position ?? '').includes(options.position.toUpperCase()) : true,
        )
        .filter((row) => (options.projections ? true : row.points !== null))
        .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
        .slice(0, Number(options.limit ?? 25));

      const label = options.projections ? 'Projected' : 'Points';

      emit.emit({
        command: deps.commandPath(),
        data: {
          league_id: leagueId ?? null,
          season: operation.variables.season,
          week: operation.variables.week ?? null,
          category: options.category ?? 'pts',
          total_lines: lines.length,
          rows,
        },
        table: () => ({
          columns: [
            column(label, (row: StatRow) => row.points, { align: 'right' }),
            column('player', (row: StatRow) => row.name, { maxWidth: 26 }),
            column('pos', (row: StatRow) => row.position),
            column('vs', (row: StatRow) => row.opponent),
          ],
          rows,
          emptyMessage: 'No stat lines returned for this query.',
        }),
      });
    });

  // -------------------------------------------------------------- leaders
  stats
    .command('leaders [leagueId]')
    .description('Show the top performers by position')
    .option('-p, --position <pos>', 'restrict to one position')
    .option('-n, --limit <count>', 'rows per position', '5')
    .option('-w, --week <n>', 'single week instead of season totals')
    .action(async (leagueId: string | undefined, options: StatsOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      client.requireSession();

      // `leagueId` is accepted for symmetry with the other stats commands; the feed
      // itself is league-wide, so the value is echoed rather than acted on.
      void leagueId;
      const state = await client.state();
      const limit = Number(options.limit ?? 5);
      const operation = buildGameStatsOperation({
        sport: client.sport,
        season: Number(options.season ?? state.season),
        ...(options.week ? { week: Number(options.week) } : {}),
        seasonType: options.post ? 'post' : 'regular',
        category: options.category ?? 'pts',
      });

      if (context.explain) {
        emit.emitJsonPayload(operation);
        return;
      }

      const data = await client.graphql.query<{ game_stats: GameStatLine[] | null }>(
        operation.document,
        operation.variables,
      );
      const lines = data.game_stats ?? [];
      const players = await client.playersByIds(lines.map((line) => line.player_id));

      const leaders = bucketLeaders(lines, players, {
        limit,
        ...(options.position ? { position: options.position } : {}),
      });

      emit.emit({
        command: deps.commandPath(),
        data: { league_id: leagueId ?? null, season: operation.variables.season, leaders },
        table: () =>
          leaders
            .flatMap((group) => [
              `\n${group.position}`,
              ...group.rows.map((row) => `  ${String(row.points).padStart(8)}  ${row.name}`),
            ])
            .join('\n') || 'No statistics returned.',
      });
    });
}
