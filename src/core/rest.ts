/**
 * Client for Sleeper's public read-only REST API.
 *
 * This layer needs no authentication, which makes it the right choice for
 * everything it can answer. Notably it cannot return statistics, so `get_player_stats`
 * and friends are only available on the GraphQL side.
 *
 * Sleeper documents a ceiling of 1000 requests per minute before an IP block, and
 * asks that the player map be fetched at most once a day. The player map is
 * therefore cached rather than requested here — see cache/players.ts.
 */

import { NetworkError, NotFoundError, RateLimitError, RejectedError } from './errors.js';
import type {
  Draft,
  DraftPick,
  League,
  NflState,
  Roster,
  SleeperUser,
  Transaction,
} from './types.js';

const REST_BASE = 'https://api.sleeper.app/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RestClientConfig {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Shapes that mean "this is not a JSON object". */
function looksLikeObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class RestClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(config: RestClientConfig = {}) {
    this.#baseUrl = config.baseUrl ?? REST_BASE;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
    this.#sleep = config.sleepImpl ?? sleep;
  }

  /**
   * GET a path relative to the API root and parse the JSON body.
   *
   * Retries transport failures and 5xx with exponential backoff. A 404, a 429, and any
   * 4xx are surfaced immediately: retrying them cannot change the answer.
   */
  async get<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    let lastError: NetworkError | undefined;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      try {
        return await this.#attempt<T>(url);
      } catch (err) {
        const isLast = attempt === this.#maxRetries;
        if (isFatal(err) || isLast) {
          if (isLast && err instanceof NetworkError) {
            throw new NetworkError(`GET ${url.pathname} failed: ${err.message}`, err);
          }
          throw err;
        }
        lastError = err instanceof NetworkError ? err : new NetworkError(String(err), err);
        await this.#sleep(backoffMs(attempt));
      }
    }

    throw lastError ?? new NetworkError(`GET ${url.pathname} failed`);
  }

  /** One request attempt. Throws a typed error for anything that is not a success. */
  async #attempt<T>(url: URL): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.#timeoutMs);

    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      if (response.status === 404) {
        throw new NotFoundError('Resource', url.pathname, 'Check the id and try again.');
      }
      if (response.status === 429) {
        throw new RateLimitError(
          'Sleeper is rate limiting requests',
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }
      if (response.status >= 500) {
        throw new NetworkError(`Sleeper returned HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new RejectedError(`Sleeper returned HTTP ${response.status}`, {
          status: response.status,
        });
      }

      const body: unknown = await response.json();
      // Sleeper signals some conditions with a 200 and an `{"error": "..."}` body.
      if (looksLikeObject(body) && typeof body.error === 'string') {
        throw new RejectedError(`Sleeper reported: ${body.error}`, { path: url.pathname });
      }
      return body as T;
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof RateLimitError ||
        err instanceof RejectedError
      ) {
        throw err;
      }
      if (isAbortError(err)) {
        throw new NetworkError(
          `Request to ${url.pathname} timed out after ${this.#timeoutMs}ms`,
          err,
        );
      }
      throw new NetworkError((err as Error).message, err);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Look up a user by username or numeric id. Either resolves to the same shape. */
  getUser(userIdOrUsername: string): Promise<SleeperUser> {
    return this.get<SleeperUser>(`/user/${encodeURIComponent(userIdOrUsername)}`);
  }

  /** Every league a user belongs to for a sport and season. */
  getUserLeagues(userId: string, sport: string, season: string): Promise<League[]> {
    return this.get<League[]>(`/user/${userId}/leagues/${sport}/${season}`);
  }

  /** One league by id. */
  getLeague(leagueId: string): Promise<League> {
    return this.get<League>(`/league/${leagueId}`);
  }

  /** All rosters in a league. */
  getRosters(leagueId: string): Promise<Roster[]> {
    return this.get<Roster[]>(`/league/${leagueId}/rosters`);
  }

  /** All managers in a league. */
  getUsers(leagueId: string): Promise<SleeperUser[]> {
    return this.get<SleeperUser[]>(`/league/${leagueId}/users`);
  }

  /** Matchups for a given week. */
  getMatchups(leagueId: string, week: number): Promise<Roster[]> {
    return this.get<Roster[]>(`/league/${leagueId}/matchups/${week}`);
  }

  /** The winners bracket. */
  getWinnersBracket(leagueId: string): Promise<unknown[]> {
    return this.get<unknown[]>(`/league/${leagueId}/winners_bracket`);
  }

  /** The losers bracket. */
  getLosersBracket(leagueId: string): Promise<unknown[]> {
    return this.get<unknown[]>(`/league/${leagueId}/losers_bracket`);
  }

  /** Transactions for a given week. */
  getTransactions(leagueId: string, week: number): Promise<Transaction[]> {
    return this.get<Transaction[]>(`/league/${leagueId}/transactions/${week}`);
  }

  /** Draft picks that have changed hands, including future seasons. */
  getTradedPicks(leagueId: string): Promise<unknown[]> {
    return this.get<unknown[]>(`/league/${leagueId}/traded_picks`);
  }

  /** Current week and season for a sport. */
  getState(sport = 'nfl'): Promise<NflState> {
    return this.get<NflState>(`/state/${sport}`);
  }

  /** Every draft belonging to a league, newest first. */
  getLeagueDrafts(leagueId: string): Promise<Draft[]> {
    return this.get<Draft[]>(`/league/${leagueId}/drafts`);
  }

  /** One draft by id. */
  getDraft(draftId: string): Promise<Draft> {
    return this.get<Draft>(`/draft/${draftId}`);
  }

  /** The full draft board. */
  getDraftPicks(draftId: string): Promise<DraftPick[]> {
    return this.get<DraftPick[]>(`/draft/${draftId}/picks`);
  }

  /** Drafts a user participated in, used to discover dynasty history. */
  getUserDrafts(userId: string, sport: string, season: string): Promise<Draft[]> {
    return this.get<Draft[]>(`/user/${userId}/drafts/${sport}/${season}`);
  }

  /**
   * The full player index, optionally filtered.
   *
   * Roughly 5MB unfiltered, which is exactly why the caller is expected to cache
   * this. Prefer `playersCache` in the client facade over calling this directly.
   */
  getPlayers(
    sport = 'nfl',
    filter: { position?: string; active?: boolean } = {},
  ): Promise<Record<string, Record<string, unknown>>> {
    const params: Record<string, string | boolean> = {};
    if (filter.position) params.position = filter.position;
    if (filter.active !== undefined) params.active = filter.active;
    return this.get<Record<string, Record<string, unknown>>>(`/players/${sport}`, params);
  }
}

/** Whether a failure should be surfaced immediately rather than retried. */
function isFatal(err: unknown): boolean {
  return (
    err instanceof NotFoundError || err instanceof RateLimitError || err instanceof RejectedError
  );
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Exponential backoff, capped so a long retry sequence cannot stall a command. */
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
