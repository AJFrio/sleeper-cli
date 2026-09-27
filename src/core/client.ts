/**
 * The facade every command talks to.
 *
 * Bundles the two transports plus the player cache and adds the cross-cutting
 * concerns the command layer should not each reimplement: resolving which league
 * is active, resolving which roster is "mine", and refusing to attempt a write
 * without a session.
 */

import { PlayerCache } from '../cache/players.js';
import { resolveToken } from '../config/credentials.js';
import { type CliConfig, loadConfig } from '../config/store.js';
import { SessionError, UsageError } from './errors.js';
import { GraphQLClient } from './graphql.js';
import { RestClient } from './rest.js';
import type { League, NflState, Player, Roster, SleeperUser } from './types.js';

export interface SleeperClientOptions {
  config?: CliConfig;
  rest?: RestClient;
  graphql?: GraphQLClient;
  playerCache?: PlayerCache;
}

export interface MeResult {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar: string | null;
}

export class SleeperClient {
  readonly rest: RestClient;
  readonly graphql: GraphQLClient;
  readonly players: PlayerCache;
  #config: CliConfig;
  #me: MeResult | null = null;

  constructor(options: SleeperClientOptions = {}) {
    this.#config = options.config ?? loadConfig();
    this.rest = options.rest ?? new RestClient();
    this.graphql = options.graphql ?? new GraphQLClient();
    this.players =
      options.playerCache ?? new PlayerCache({ ttlHours: this.#config.player_cache_ttl_hours });

    // Attach whatever session is already available so read commands that touch
    // GraphQL work without an explicit login step.
    const token = resolveToken();
    if (token) this.graphql.setToken(token);
  }

  get config(): CliConfig {
    return this.#config;
  }

  get sport(): string {
    return this.#config.sport;
  }

  /** Replace the in-memory config, e.g. after `sleeper config set`. */
  setConfig(config: CliConfig): void {
    this.#config = config;
  }

  /** True when a session token is available, without validating it. */
  hasSession(): boolean {
    return this.graphql.token !== undefined;
  }

  /**
   * Ensure a session exists, loading one from the environment or credentials file.
   *
   * Throws a SessionError when none is present, which command handlers surface as
   * exit code 3 so an agent knows to re-authenticate.
   */
  requireSession(): string {
    const token = this.graphql.token ?? resolveToken();
    if (!token) {
      throw new SessionError();
    }
    this.graphql.setToken(token);
    return token;
  }

  /**
   * Fetch the authenticated user, memoised for the process lifetime.
   *
   * Doubles as the session validity check: an expired token surfaces here as an
   * unauthorized GraphQL error, which the transport has already classified as a
   * SessionError.
   */
  async me(options: { refresh?: boolean } = {}): Promise<MeResult> {
    if (this.#me && !options.refresh) return this.#me;

    this.requireSession();
    const data = await this.graphql.query<{ me: MeResult | null }>(`
      query me {
        me {
          user_id
          username
          display_name
          avatar
        }
      }
    `);

    if (!data.me) {
      throw new SessionError(
        'Sleeper did not return a user for this session',
        'The token may be malformed. Run `sleeper auth login` to obtain a fresh one.',
      );
    }
    this.#me = data.me;
    return data.me;
  }

  /** The authenticated user's id, or a SessionError. */
  async userId(): Promise<string> {
    return (await this.me()).user_id;
  }

  /** Current week and season, used to default week-scoped commands. */
  async state(): Promise<NflState> {
    return this.rest.getState(this.sport);
  }

  /**
   * Resolve the league to operate on.
   *
   * Accepts an explicit id, otherwise falls back to the configured active league.
   * The error names both escape hatches, because "no league selected" is the most
   * common first-run failure.
   */
  async resolveLeagueId(explicit?: string): Promise<string> {
    const leagueId = explicit ?? this.#config.active_league_id;
    if (!leagueId) {
      throw new UsageError(
        'No league selected',
        'Pass a league id explicitly, or set a default with `sleeper leagues use <id>`. ' +
          'Run `sleeper leagues list` to see the options.',
      );
    }
    return leagueId;
  }

  /** Every league the authenticated user belongs to, for the current season. */
  async myLeagues(season?: string): Promise<League[]> {
    const resolvedSeason = season ?? this.#config.season ?? (await this.currentSeason());
    const me = await this.me();

    // The GraphQL query returns every league in one call; the REST endpoint needs a
    // numeric user id and only covers the requested season. Prefer GraphQL.
    const data = await this.graphql.query<{ league_user_by_user: { leagues: League[] } | null }>(
      `
      query league_user_by_user($sport: String!, $season: String, $seasonType: String) {
        league_user_by_user(sport: $sport, season: $season, season_type: $seasonType) {
          leagues {
            league_id
            name
            avatar
            status
            sport
            season
            season_type
            current_week
            leg
            member_count
            total_rosters
          }
        }
      }
    `,
      { sport: this.sport, season: resolvedSeason, seasonType: 'regular' },
    );

    if (data.league_user_by_user?.leagues) {
      return data.league_user_by_user.leagues;
    }

    // Fall back to REST for accounts the GraphQL query does not cover.
    return this.rest.getUserLeagues(me.user_id, this.sport, resolvedSeason);
  }

  /** The season Sleeper is currently in. */
  async currentSeason(): Promise<string> {
    const state = await this.state();
    return state.season;
  }

  /** Managers in a league. */
  async leagueUsers(leagueId: string): Promise<SleeperUser[]> {
    return this.rest.getUsers(leagueId);
  }

  /** All rosters in a league. */
  async rosters(leagueId: string): Promise<Roster[]> {
    return this.rest.getRosters(leagueId);
  }

  /**
   * Find the roster belonging to the authenticated user.
   *
   * `owner_id` is a user id, so this needs a session even though the underlying
   * roster fetch does not — that is inherent to answering "which roster is mine".
   */
  async myRoster(leagueId: string, options: { refresh?: boolean } = {}): Promise<Roster> {
    const me = await this.me(options);
    const rosters = await this.rosters(leagueId);
    const mine = rosters.find((r) => r.owner_id === me.user_id);

    if (!mine) {
      throw new UsageError(
        `No roster found for you in league ${leagueId}`,
        'Confirm you are a member of this league, or pass --roster-id to target a specific roster.',
      );
    }
    return mine;
  }

  /**
   * Resolve which roster a command should act on.
   *
   * An explicit roster id wins, then a configured default, then the authenticated
   * user's own roster. Commissioner actions pass an explicit id to act on someone
   * else's roster.
   */
  async resolveRosterId(leagueId: string, explicit?: number): Promise<number> {
    if (typeof explicit === 'number') return explicit;
    if (typeof this.#config.default_roster_id === 'number') return this.#config.default_roster_id;
    return (await this.myRoster(leagueId)).roster_id;
  }

  /**
   * The player map, from cache when warm.
   *
   * Fetches and caches on a miss. This is the reason the cache exists: the payload
   * is about 5MB and rosters reference players only by id.
   */
  async playerMap(
    options: { refresh?: boolean; activeOnly?: boolean } = {},
  ): Promise<Record<string, Player>> {
    const cached = this.players.read(this.sport);
    if (cached && !options.refresh && !options.activeOnly) return cached;

    const raw = await this.rest.getPlayers(this.sport, {
      ...(options.activeOnly ? { active: true } : {}),
    });
    // The endpoint returns an untyped index of player objects. Each entry carries at
    // minimum player_id, first_name and last_name, so the cast is sound in practice;
    // `Player` keeps the rest optional.
    const players = raw as unknown as Record<string, Player>;
    this.players.write(players, this.sport, options.activeOnly ?? false);
    return players;
  }

  /** Resolve a handful of players by id, tolerating ids that no longer exist. */
  async playersByIds(ids: readonly string[]): Promise<Map<string, Player>> {
    const wanted = new Set(ids);
    if (wanted.size === 0) return new Map();

    const map = await this.playerMap();
    const found = new Map<string, Player>();
    for (const id of wanted) {
      const player = map[id];
      if (player) found.set(id, player);
    }

    // Ids can be missed when the cache is cold on a player added since the fetch.
    // A single targeted refetch is worth it to avoid printing "Unknown".
    if (found.size < wanted.size) {
      const fresh = await this.playerMap({ refresh: true });
      for (const id of wanted) {
        if (!found.has(id)) {
          const player = fresh[id];
          if (player) found.set(id, player);
        }
      }
    }
    return found;
  }
}
