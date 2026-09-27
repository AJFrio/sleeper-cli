/**
 * `sleeper players` — the player index, and the cache that makes it usable.
 *
 * The player map is about 5MB of JSON. Sleeper asks that it be fetched at most once a
 * day, and every roster or transaction payload references players only by id, so the
 * CLI caches it on disk and reads names from there. Almost every other command
 * depends on this being fast, which is why the cache is a first-class concern here
 * rather than an implementation detail.
 */

import type { Command } from 'commander';
import { NotFoundError } from '../core/errors.js';
import { type Player, playerName } from '../core/types.js';
import { buildPlayerStatsOperation } from '../domain/stats.js';
import { buildContext } from '../output/context.js';
import { column } from '../output/emit.js';
import { formatAge, formatBytes, renderRecord } from '../output/format.js';
import type { CommandDeps } from './deps.js';
import { loadTeams } from './shared.js';

interface PlayersOptions {
  position?: string;
  active?: boolean;
  limit?: string;
  season?: string;
  week?: string;
  category?: string;
  post?: boolean;
  stats?: boolean;
  refresh?: boolean;
  clear?: boolean;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

interface PlayerRow {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  status: string | null;
  injury: string | null;
  age: number | null;
  college: string | null;
}

function toRow(player: Player): PlayerRow {
  return {
    player_id: player.player_id,
    name: playerName(player),
    position: player.fantasy_positions?.join('/') ?? player.position ?? null,
    team: player.team ?? null,
    status: player.status ?? null,
    injury: player.injury_status ?? null,
    age: player.age ?? null,
    college: player.college ?? null,
  };
}

const PLAYER_COLUMNS = () => [
  column('player id', (row: PlayerRow) => row.player_id),
  column('name', (row: PlayerRow) => row.name, { maxWidth: 26 }),
  column('pos', (row: PlayerRow) => row.position),
  column('team', (row: PlayerRow) => row.team),
  column('status', (row: PlayerRow) => row.status, { maxWidth: 18 }),
  column('injury', (row: PlayerRow) => row.injury),
];

/** Loose match on name fields, so "mike" finds "Mike Evans" and "van driessche" works. */
function matchesQuery(player: Player, needle: string): boolean {
  const haystack = [
    player.full_name,
    player.first_name,
    player.last_name,
    player.player_id,
    player.team,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function hasPosition(player: Player, position: string): boolean {
  const wanted = position.toUpperCase();
  const positions = (player.fantasy_positions ?? []).map((p) => p.toUpperCase());
  if (positions.includes(wanted)) return true;
  // A single letter should also match the defence grouping, which is how Sleeper
  // labels individual defensive backs.
  if (wanted === 'DST') return (player.position ?? '').toUpperCase() === 'DEF';
  return false;
}

/** Coerce Sleeper's loosely-typed stat object into something renderable. */
function toDisplayRecord(
  stats: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value === null || value === undefined) out[key] = null;
    else if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value;
    } else out[key] = JSON.stringify(value);
  }
  return out;
}

export function registerPlayersCommands(program: Command, deps: CommandDeps): void {
  const players = program
    .command('players')
    .description('Search the player index and inspect player data');

  players
    .command('search <query>')
    .description('Search players by name, team, or id')
    .option('-p, --position <pos>', 'QB, RB, WR, TE, K, DST')
    .option('--active', 'only currently active players')
    .option('-n, --limit <count>', 'maximum rows to return', '25')
    .action(async (query: string, options: PlayersOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const map = await deps.client().playerMap();
      const limit = Number(options.limit ?? 25);

      const candidates = Object.values(map)
        .filter((player) => matchesQuery(player, query))
        .filter((player) => (options.position ? hasPosition(player, options.position) : true))
        .filter((player) => (options.active ? player.status === 'Active' : true));

      const ranked = candidates
        .map((player) => ({ player, rank: (player as { search_rank?: number }).search_rank }))
        .sort((a, b) => {
          const ra = typeof a.rank === 'number' ? a.rank : Number.MAX_SAFE_INTEGER;
          const rb = typeof b.rank === 'number' ? b.rank : Number.MAX_SAFE_INTEGER;
          if (ra !== rb) return ra - rb;
          return playerName(a.player).localeCompare(playerName(b.player));
        })
        .slice(0, limit)
        .map(({ player }) => toRow(player));

      emit.emit({
        command: deps.commandPath(),
        data: { query, total_matches: candidates.length, players: ranked },
        table: () => ({
          columns: PLAYER_COLUMNS(),
          rows: ranked,
          emptyMessage: `No player matched "${query}". Try a shorter query, or \`sleeper players search <last name>\`.`,
        }),
      });
    });

  players
    .command('get <playerId>')
    .description('Show one player in full')
    .option('--stats', 'also fetch season totals')
    .option('--season <year>', 'season for --stats')
    .option('--week <n>', 'week for --stats')
    .option('--category <cat>', 'stat category for --stats (default pts)')
    .option('--post', 'use postseason stats')
    .action(async (playerId: string, options: PlayersOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const map = await client.playerMap();
      const player = map[playerId];

      if (!player) {
        throw new NotFoundError(
          'Player',
          playerId,
          'Look the id up with `sleeper players search <name>`.',
        );
      }

      let stats: Record<string, unknown> | null = null;
      if (options.stats) {
        const season = Number(options.season ?? (await client.state()).season);
        const operation = buildPlayerStatsOperation({
          playerId,
          season,
          ...(options.week ? { week: Number(options.week) } : {}),
          ...(options.category ? { category: options.category } : {}),
          ...(options.post ? { seasonType: 'post' as const } : {}),
        });
        const data = await client.graphql.query<{
          get_player_stats: { player_id: string; stat: Record<string, unknown> | null } | null;
        }>(operation.document, operation.variables);
        stats = data.get_player_stats?.stat ?? null;
      }

      emit.emit({
        command: deps.commandPath(),
        data: { ...player, name: playerName(player), stats },
        table: () =>
          [
            renderRecord(
              {
                player_id: player.player_id,
                name: playerName(player),
                position: (player.fantasy_positions ?? []).join('/'),
                team: player.team ?? null,
                status: player.status ?? null,
                injury: player.injury_status ?? null,
                age: player.age ?? null,
                height: player.height ?? null,
                weight: player.weight ?? null,
                college: player.college ?? null,
                years_exp: player.years_exp ?? null,
              },
              { indent: 2 },
            ),
            ...(stats
              ? ['', '  Season stats', renderRecord(toDisplayRecord(stats), { indent: 4 })]
              : []),
          ].join('\n'),
      });
    });

  players
    .command('available [leagueId]')
    .description('List players nobody in the league rosters, i.e. waiver targets')
    .option('-p, --position <pos>', 'QB, RB, WR, TE, K, DST')
    .option('-n, --limit <count>', 'maximum rows to return', '50')
    .action(async (leagueId: string | undefined, options: PlayersOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const resolved = await client.resolveLeagueId(leagueId);
      const limit = Number(options.limit ?? 50);

      const { rosters } = await loadTeams(client, resolved);
      const rostered = new Set(rosters.flatMap((roster) => roster.players));

      const map = await client.playerMap();
      const rows = Object.values(map)
        .filter((player) => !rostered.has(player.player_id))
        .filter((player) => (options.position ? hasPosition(player, options.position) : true))
        .map((player) => ({ player, rank: (player as { search_rank?: number }).search_rank }))
        .sort((a, b) => {
          const ra = typeof a.rank === 'number' ? a.rank : Number.MAX_SAFE_INTEGER;
          const rb = typeof b.rank === 'number' ? b.rank : Number.MAX_SAFE_INTEGER;
          return ra - rb;
        })
        .slice(0, limit)
        .map(({ player }) => toRow(player));

      emit.emit({
        command: deps.commandPath(),
        data: { league_id: resolved, rostered_count: rostered.size, available: rows },
        table: () => ({
          columns: PLAYER_COLUMNS(),
          rows,
          emptyMessage: 'Every player is rostered in this league.',
        }),
      });
    });

  players
    .command('cache')
    .description('Report, refresh, or clear the cached player index')
    .option('--refresh', 're-download the index, ignoring the cache')
    .option('--clear', 'delete the cache file')
    .action(async (options: PlayersOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const cache = deps.client().players;

      if (options.clear) {
        cache.clear();
        emit.emit({
          command: deps.commandPath(),
          data: { cleared: true, path: cache.path },
          table: () => `Player cache cleared (${cache.path}).`,
        });
        return;
      }

      if (options.refresh || context.explain) {
        if (context.explain) {
          emit.emitJsonPayload({
            endpoint: `https://api.sleeper.app/v1/players/${deps.client().sport}`,
          });
          return;
        }
        await deps.client().playerMap({ refresh: true });
      }

      const size = cache.sizeBytes();
      const age = cache.ageMs();

      emit.emit({
        command: deps.commandPath(),
        data: {
          path: cache.path,
          size_bytes: size ?? null,
          age_ms: age ?? null,
          warm: cache.has(),
          ttl_hours: deps.client().config.player_cache_ttl_hours,
        },
        table: () =>
          renderRecord(
            {
              path: cache.path,
              size: formatBytes(size),
              age: formatAge(age),
              state: cache.has() ? 'warm' : 'cold or stale',
              ttl: `${deps.client().config.player_cache_ttl_hours}h`,
            },
            { indent: 2 },
          ),
      });
    });
}
