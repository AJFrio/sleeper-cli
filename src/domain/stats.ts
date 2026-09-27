/**
 * Statistics and projections.
 *
 * The public REST API carries no statistics at all — its player index is identity
 * and status only. Anything about points has to come from GraphQL, which is why
 * this module is separate from the roster and league reads.
 *
 * Sleeper exposes two shapes here: per-player lines via `get_player_stats`, and a
 * league-wide feed via `game_stats`. The `category` argument selects the breakdown
 * and its accepted values differ by sport, so it is passed through rather than
 * hardcoded, with the common NFL categories named for discoverability.
 */

/** Stat categories Sleeper accepts for NFL. Others may work; these are the documented ones. */
export const NFL_STAT_CATEGORIES = [
  'pts',
  'pts_ppr',
  ' rushing',
  'passing',
  'receiving',
  'defensive',
  'misc',
  'kicking',
  'punting',
] as const;

export type NflStatCategory = (typeof NFL_STAT_CATEGORIES)[number] | (string & {});

export interface StatQuery {
  sport?: string;
  season: number;
  /** Matchup week for weekly stats. Omit for season totals. */
  week?: number;
  seasonType?: 'regular' | 'post' | 'pre';
  category?: NflStatCategory;
}

export interface GameStatsQuery extends StatQuery {
  /** NFL conference the game belonged to, for conference-specific feeds. */
  conference?: 'AFC' | 'NFC';
  orderBy?: string;
  /** Restrict to a set of positions. */
  positions?: string[];
  /** Restrict to players appearing in a specific game. */
  gameId?: string;
}

export interface PlayerStatLine {
  player_id: string;
  /** Aggregate points, or the named category's total. */
  stat?: string | number | null;
  pts?: number | null;
  [key: string]: unknown;
}

export interface GameStatLine {
  player_id: string;
  stats: string | null;
  /** Present on the per-week feed. */
  projected_stats?: string | null;
  opponent?: string | null;
  game_id?: string | null;
  [key: string]: unknown;
}

const PLAYER_STATS = `
  query get_player_stats(
    $sport: String!, $playerId: String, $season: Int, $week: Int,
    $seasonType: String, $category: String
  ) {
    get_player_stats(
      sport: $sport, player_id: $playerId, season: $season, week: $week,
      season_type: $seasonType, category: $category
    ) {
      player_id
      stat
    }
  }
`;

const GAME_STATS = `
  query game_stats(
    $sport: String!, $season: Int, $week: Int, $seasonType: String,
    $category: String, $orderBy: String, $conference: String, $gameId: String
  ) {
    game_stats(
      sport: $sport, season: $season, week: $week, season_type: $seasonType,
      category: $category, order_by: $orderBy, conference: $conference, game_id: $gameId
    ) {
      player_id
      stats
      projected_stats
      opponent
      game_id
    }
  }
`;

/** Build the per-player stats operation. */
export function buildPlayerStatsOperation(query: StatQuery & { playerId?: string }): {
  document: string;
  variables: Record<string, unknown>;
} {
  return {
    document: PLAYER_STATS,
    variables: {
      sport: query.sport ?? 'nfl',
      ...(query.playerId ? { playerId: query.playerId } : {}),
      season: query.season,
      ...(query.week !== undefined ? { week: query.week } : {}),
      ...(query.seasonType ? { seasonType: query.seasonType } : {}),
      ...(query.category ? { category: query.category } : {}),
    },
  };
}

/** Build the league-wide stats operation. */
export function buildGameStatsOperation(query: GameStatsQuery): {
  document: string;
  variables: Record<string, unknown>;
} {
  return {
    document: GAME_STATS,
    variables: {
      sport: query.sport ?? 'nfl',
      season: query.season,
      ...(query.week !== undefined ? { week: query.week } : {}),
      ...(query.seasonType ? { seasonType: query.seasonType } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.orderBy ? { orderBy: query.orderBy } : {}),
      ...(query.conference ? { conference: query.conference } : {}),
      ...(query.gameId ? { gameId: query.gameId } : {}),
    },
  };
}

/**
 * Parse Sleeper's `stats` field.
 *
 * The field arrives as a JSON-encoded string on the game feed and as a bare value on
 * the per-player feed, so both shapes are accepted. Anything unparseable yields an
 * empty object rather than throwing, because one malformed line should not fail an
 * entire report.
 */
export function parseStatField(raw: unknown): Record<string, number> {
  if (raw === null || raw === undefined) return {};

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return toNumberRecord(raw as Record<string, unknown>);
  }
  if (typeof raw === 'number') return { total: raw };

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return toNumberRecord(parsed[0] as Record<string, unknown>);
      if (typeof parsed === 'object' && parsed !== null) {
        return toNumberRecord(parsed as Record<string, unknown>);
      }
      if (typeof parsed === 'number') return { total: parsed };
    } catch {
      // Not JSON. Fall through to the plain-number case below.
    }
    const asNumber = Number(trimmed);
    return Number.isFinite(asNumber) ? { total: asNumber } : {};
  }
  return {};
}

function toNumberRecord(input: Record<string, unknown> | undefined): Record<string, number> {
  if (!input) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Sum a named key across many stat lines.
 *
 * Used to total a team's points per player, which is what makes a projection
 * comparable against a live score.
 */
export function sumStat(lines: readonly GameStatLine[], key = 'pts'): number {
  let total = 0;
  for (const line of lines) {
    const stats = parseStatField(line.stats);
    const value = stats[key];
    if (typeof value === 'number') total += value;
  }
  return Math.round(total * 100) / 100;
}

/** Sum projections across many stat lines. */
export function sumProjected(lines: readonly GameStatLine[]): number {
  return sumStat(lines.map((line) => ({ ...line, stats: line.projected_stats ?? line.stats })));
}
