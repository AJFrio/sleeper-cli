/**
 * Helpers shared across command modules.
 *
 * These are the two things nearly every read command needs: a manager-name lookup
 * keyed by roster id, and turning a user-supplied player token into an id. Both are
 * non-obvious enough that duplicating them per command is how they drift apart.
 */

import type { SleeperClient } from '../core/client.js';
import { UsageError } from '../core/errors.js';
import type { Player, Roster, SleeperUser } from '../core/types.js';
import { playerName } from '../core/types.js';

/** A manager's display identity, keyed by roster id. */
export interface TeamInfo {
  roster_id: number;
  user_id: string | null;
  display_name: string | null;
  team_name: string | null;
  username: string | null;
}

/**
 * Map roster ids to manager identities.
 *
 * The join is `roster.owner_id === user.user_id`, which is the only link between the
 * two lists — Sleeper does not put roster ids on users or vice versa.
 */
export function buildTeamsMap(
  rosters: readonly Roster[],
  users: readonly SleeperUser[],
): Map<number, TeamInfo> {
  const byUserId = new Map(users.map((user) => [user.user_id, user]));
  const teams = new Map<number, TeamInfo>();

  for (const roster of rosters) {
    const user = roster.owner_id ? byUserId.get(roster.owner_id) : undefined;
    const teamName = typeof user?.metadata?.team_name === 'string' ? user.metadata.team_name : null;
    teams.set(roster.roster_id, {
      roster_id: roster.roster_id,
      user_id: roster.owner_id,
      display_name: user?.display_name ?? null,
      team_name: teamName,
      username: user?.username ?? null,
    });
  }
  return teams;
}

/** The best available label for a manager, preferring an explicit team name. */
export function teamLabel(team: TeamInfo | undefined, rosterId?: number): string {
  if (!team) return rosterId === undefined ? 'Unknown' : `Roster ${rosterId}`;
  return team.team_name ?? team.display_name ?? team.username ?? `Roster ${team.roster_id}`;
}

/** Fetch rosters and users and join them, the two-step nearly every read needs. */
export async function loadTeams(
  client: SleeperClient,
  leagueId: string,
): Promise<{
  rosters: Roster[];
  users: SleeperUser[];
  teams: Map<number, TeamInfo>;
}> {
  const [rosters, users] = await Promise.all([
    client.rosters(leagueId),
    client.leagueUsers(leagueId),
  ]);
  return { rosters, users, teams: buildTeamsMap(rosters, users) };
}

/** A `player_id` token, i.e. all digits. */
function isPlayerId(token: string): boolean {
  return /^\d+$/.test(token);
}

/** Look up a player by exact full name, case- and punctuation-insensitively. */
function findByName(map: Record<string, Player>, name: string): Player[] {
  const wanted = normalise(name);
  return Object.values(map).filter((player) => {
    if (player.full_name && normalise(player.full_name) === wanted) return true;
    return normalise(`${player.first_name ?? ''} ${player.last_name ?? ''}`) === wanted;
  });
}

/** Lowercase and strip punctuation, so "P.J. Walker" matches "pj walker". */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Turn user-supplied tokens into player ids.
 *
 * Accepts raw ids, and also full names, because typing a nine-digit id is a poor
 * experience and agents frequently have a name rather than an id. A name that matches
 * nothing, or more than one player, is an error rather than a guess — silently
 * dropping a player from a waiver claim is exactly the failure this tool must not
 * have.
 */
export async function resolvePlayerTokens(
  client: SleeperClient,
  tokens: readonly string[],
): Promise<string[]> {
  const names = tokens.filter((token) => !isPlayerId(token));
  const literal = tokens.filter((token) => isPlayerId(token));

  if (names.length === 0) return [...new Set(literal)];

  const map = await client.playerMap();
  const resolved: string[] = [...literal];
  const unresolved: string[] = [];

  for (const name of names) {
    if (map[name]) {
      resolved.push(name);
      continue;
    }
    const matches = findByName(map, name);
    if (matches.length === 1) {
      const match = matches[0];
      if (match) resolved.push(match.player_id);
    } else if (matches.length === 0) {
      unresolved.push(name);
    } else {
      const candidates = matches.map((m) => m.player_id).join(', ');
      unresolved.push(`${name} (ambiguous: ${candidates})`);
    }
  }

  if (unresolved.length > 0) {
    throw new UsageError(
      `Could not resolve player(s): ${unresolved.join('; ')}`,
      'Use exact Sleeper names or numeric player ids. `sleeper players search <name>` lists candidates.',
    );
  }

  return [...new Set(resolved)];
}

/**
 * Render a list of player ids as names, in the same order.
 *
 * Accepts an optional separator so callers can choose a readable layout without
 * re-deriving the lookup.
 */
export async function namePlayerIds(
  client: SleeperClient,
  playerIds: readonly string[],
  separator = ', ',
): Promise<string> {
  if (playerIds.length === 0) return '—';
  const players = await client.playersByIds(playerIds);
  return playerIds.map((id) => playerName(players.get(id))).join(separator);
}

/** Look up players and return `id -> label` for rendering a table column. */
export async function buildNameMap(
  client: SleeperClient,
  playerIds: readonly string[],
): Promise<Map<string, string>> {
  const players = await client.playersByIds(playerIds);
  const labels = new Map<string, string>();
  for (const [id, player] of players) {
    labels.set(id, playerName(player));
  }
  for (const id of playerIds) {
    if (!labels.has(id)) labels.set(id, `Unknown (${id})`);
  }
  return labels;
}

/**
 * Parse a repeatable `<rosterId>:<round>[:<season>]` draft pick option.
 *
 * Returns null for a malformed token so the caller can collect every problem and
 * report them together, rather than failing on the first one.
 */
export function parsePickSpec(
  spec: string,
):
  | { ok: true; value: { rosterId: number; round: number; season?: number } }
  | { ok: false; error: string } {
  const parts = spec.split(':');
  if (parts.length < 2 || parts.length > 3) {
    return { ok: false, error: `Expected ROSTER_ID:ROUND[:SEASON], got "${spec}"` };
  }
  const [rosterRaw, roundRaw, seasonRaw] = parts;
  const rosterId = Number(rosterRaw);
  const round = Number(roundRaw);
  const season = seasonRaw === undefined ? undefined : Number(seasonRaw);

  if (!Number.isInteger(rosterId) || rosterId < 1) {
    return { ok: false, error: `Invalid roster id in "${spec}"` };
  }
  if (!Number.isInteger(round) || round < 1) {
    return { ok: false, error: `Invalid round in "${spec}"` };
  }
  if (season !== undefined && (!Number.isInteger(season) || season < 1900)) {
    return { ok: false, error: `Invalid season in "${spec}"` };
  }
  return { ok: true, value: { rosterId, round, ...(season === undefined ? {} : { season }) } };
}
