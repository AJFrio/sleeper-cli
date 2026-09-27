/**
 * GraphQL transport for Sleeper's internal API.
 *
 * Sleeper's public REST API is read-only, so every write goes through the GraphQL
 * endpoint the web client itself uses. Three behaviours here are load-bearing and
 * were established by reading Sleeper's shipped bundle and probing the live server;
 * see docs/INTERNAL-API.md.
 *
 *  1. The session token goes in a bare `Authorization` header with **no** `Bearer`
 *     prefix.
 *  2. There is no CSRF or anti-forgery header. Older third-party guides describe an
 *     `x-sleeper-hash`; the current web client sends nothing of the sort.
 *  3. A rejected call usually still returns HTTP 200, with the failure carried in an
 *     `errors` array. Inspecting only the status line would report success for
 *     mutations that never happened.
 */

import {
  CaptchaError,
  EXIT,
  MfaError,
  NetworkError,
  RateLimitError,
  RejectedError,
  SessionError,
  SleeperError,
} from './errors.js';

export const GRAPHQL_URL = 'https://api.sleeper.app/graphql';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

/** One entry in a GraphQL response's `errors` array. */
export interface GraphQLErrorShape {
  message: string;
  path?: (string | number)[];
  code?: string;
  locations?: { line: number; column: number }[];
  data?: Record<string, unknown>;
  originalErrors?: GraphQLErrorShape[];
}

export interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLErrorShape[];
}

export interface GraphQLRequestOptions {
  /** Session token. Omit for unauthenticated operations such as `login`. */
  token?: string | undefined;
  /** Per-call timeout override in milliseconds. */
  timeoutMs?: number;
  /** Retry attempts for transport errors and 5xx. Defaults to 3. */
  maxRetries?: number;
  /** Abort signal for caller-driven cancellation. */
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Parse `Retry-After`, which may be seconds or an HTTP date. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Determine whether a failure is an expired session rather than a bad request.
 *
 * Sleeper surfaces expiry as a normal 200 with `code: "unauthorized"`, so without
 * this check an expired token would look like a generic rejection and the operator
 * would never be told to re-authenticate.
 */
function isUnauthorized(errors: GraphQLErrorShape[] | undefined): boolean {
  return (errors ?? []).some(
    (e) =>
      e.code === 'unauthorized' || /unauthorized|not authenticated|invalid token/i.test(e.message),
  );
}

/** Collapse an errors array into one readable sentence. */
function summarise(errors: GraphQLErrorShape[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const e of errors) {
    const msg = e.message?.trim();
    if (msg && !seen.has(msg)) {
      seen.add(msg);
      parts.push(msg);
    }
  }
  return parts.join('; ') || 'Request failed with no error message';
}

/**
 * Convert a GraphQL error payload into the right typed error.
 *
 * `unauthorized` becomes a SessionError so the CLI can tell the operator to
 * re-login. Everything else is a RejectedError: Sleeper parsed the request and
 * declined it, which is a materially different situation from a transport failure.
 */
function classify(errors: GraphQLErrorShape[]): SleeperError {
  if (isUnauthorized(errors)) {
    return new SessionError(
      'Sleeper rejected the session token',
      'The session is missing or has expired. Run `sleeper auth login` to sign in again.',
    );
  }
  const code = errors.find((e) => e.code)?.code;
  const summary = summarise(errors);
  return new RejectedError(summary, {
    code,
    errors: errors.map((e) => ({ message: e.message, path: e.path, code: e.code })),
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface GraphQLClientConfig {
  url?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so retry backoff does not slow the suite down. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injected for tests to observe the resolved session token. */
  onToken?: (token: string) => void;
}

/**
 * A thin, dependency-free GraphQL client for Sleeper.
 *
 * Stateless apart from the token: the same instance serves the read-only public
 * commands and the authenticated write commands.
 */
export class GraphQLClient {
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onToken: ((token: string) => void) | undefined;
  #token: string | undefined;

  constructor(config: GraphQLClientConfig = {}) {
    this.#url = config.url ?? GRAPHQL_URL;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
    this.#sleep = config.sleepImpl ?? sleep;
    this.#onToken = config.onToken;
  }

  /** The current session token, if one has been set. */
  get token(): string | undefined {
    return this.#token;
  }

  /** Install a session token obtained from `login` or from stored credentials. */
  setToken(token: string | undefined): void {
    this.#token = token;
    if (token) this.#onToken?.(token);
  }

  /**
   * Execute an operation and return its single root field.
   *
   * Throws a typed SleeperError rather than returning a result envelope, so command
   * handlers can stay linear. `field` is the root field name; Sleeper's responses
   * always key `data` by operation name.
   */
  async query<T>(
    document: string,
    variables: Record<string, unknown> = {},
    options: GraphQLRequestOptions = {},
  ): Promise<T> {
    const { data, errors } = await this.#send<T>(document, variables, options);
    if (errors && errors.length > 0) {
      throw classify(errors);
    }
    if (data === null || data === undefined) {
      throw new RejectedError('Sleeper returned an empty response', {
        operation: extractOperationName(document),
      });
    }
    return data;
  }

  /**
   * Execute an operation, preserving any field-level errors instead of throwing.
   *
   * Useful for fan-out reads where one missing sub-object should not sink the whole
   * command.
   */
  async queryAllowingErrors<T>(
    document: string,
    variables: Record<string, unknown> = {},
    options: GraphQLRequestOptions = {},
  ): Promise<{ data: T | null; errors: GraphQLErrorShape[] }> {
    const { data, errors } = await this.#send<T>(document, variables, options);
    if (errors && errors.length > 0 && isUnauthorized(errors)) {
      throw classify(errors);
    }
    return { data: data ?? null, errors: errors ?? [] };
  }

  /**
   * Post an operation, retrying transport failures and retryable statuses.
   *
   * Auth failures are not retried: a bad token will still be bad next time, and
   * retrying only delays the re-login prompt.
   */
  async #send<T>(
    document: string,
    variables: Record<string, unknown>,
    options: GraphQLRequestOptions,
  ): Promise<GraphQLResponse<T>> {
    const maxRetries = options.maxRetries ?? this.#maxRetries;
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const token = options.token ?? this.#token;

    let lastError: SleeperError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const isLast = attempt === maxRetries;

      try {
        return await this.#attempt<T>(document, variables, token, timeoutMs, options.signal);
      } catch (err) {
        const error = err instanceof SleeperError ? err : new NetworkError(String(err), err);

        if (error.exitCode === EXIT.SESSION || error.exitCode === EXIT.REJECTED || isLast) {
          throw error;
        }

        lastError = error;
        await this.#sleep(backoffMs(attempt, error));
      }
    }

    throw lastError ?? new NetworkError('Request failed after retries');
  }

  async #attempt<T>(
    document: string,
    variables: Record<string, unknown>,
    token: string | undefined,
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<GraphQLResponse<T>> {
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        // The bare token, deliberately not `Bearer ${token}`.
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: token } : {}),
        },
        body: JSON.stringify({ query: document, variables }),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new RateLimitError(
          'Sleeper is rate limiting requests',
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new SessionError('Sleeper rejected the session token');
      }
      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status)) {
          throw new NetworkError(`Sleeper returned HTTP ${response.status}`, undefined);
        }
        throw new RejectedError(`Sleeper returned HTTP ${response.status}`, {
          status: response.status,
        });
      }

      let payload: GraphQLResponse<T>;
      try {
        payload = (await response.json()) as GraphQLResponse<T>;
      } catch (err) {
        throw new NetworkError('Sleeper returned a response that was not valid JSON', err);
      }

      if (payload.errors && isUnauthorized(payload.errors)) {
        throw classify(payload.errors);
      }
      return payload;
    } catch (err) {
      if (err instanceof SleeperError) throw err;
      if (isAbortError(err)) {
        throw new NetworkError(
          externalSignal?.aborted ? 'Request cancelled' : `Request timed out after ${timeoutMs}ms`,
          err,
        );
      }
      throw new NetworkError(describeNetworkFailure(err), err);
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function describeNetworkFailure(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
  const code = cause?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Could not resolve api.sleeper.app (DNS failure)';
    case 'ECONNREFUSED':
      return 'Connection to api.sleeper.app was refused';
    case 'ECONNRESET':
      return 'Connection to api.sleeper.app was reset';
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS certificate verification failed for api.sleeper.app';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

/** Exponential backoff with a deterministic jitter-free offset for testability. */
function backoffMs(attempt: number, error: SleeperError): number {
  if (error instanceof RateLimitError && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

/**
 * Pull the operation name out of a GraphQL document.
 *
 * Sleeper's server keys responses by operation name, and having it available for
 * error context makes failures much easier to read.
 */
export function extractOperationName(document: string): string {
  const named = document.match(/\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (named?.[1]) return named[1];
  const anonymous = document.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/);
  return anonymous?.[1] ?? 'anonymous';
}

/**
 * Obtain a session token from Sleeper's credentials.
 *
 * `login` is a query rather than a mutation, accepts an optional captcha token, and
 * returns a bare `{ token }`. Two-factor accounts surface a code in the error's
 * `originalErrors`; the caller retries with `otp`.
 */
export async function loginToSleeper(
  client: GraphQLClient,
  input: { identifier: string; password: string; captcha?: string; otp?: string },
): Promise<{ token: string; requiresOtp: boolean }> {
  const document = `
    query login($email_or_phone_or_username: String!, $password: String!, $captcha: String, $otp: String) {
      login(
        email_or_phone_or_username: $email_or_phone_or_username,
        password: $password,
        captcha: $captcha,
        otp: $otp
      ) { token }
    }
  `;

  const { data, errors } = await client.queryAllowingErrors<{
    login: { token: string } | null;
  }>(document, {
    email_or_phone_or_username: input.identifier,
    password: input.password,
    captcha: input.captcha ?? null,
    otp: input.otp ?? null,
  });

  if (data?.login?.token) {
    client.setToken(data.login.token);
    return { token: data.login.token, requiresOtp: false };
  }

  // An account with 2FA reports a specific error code rather than a null token.
  const otpRequested = (errors ?? []).some(
    (e) => e.code === 'mfa_required' || /otp|two.?factor|2fa|verification code/i.test(e.message),
  );
  if (otpRequested) {
    throw new MfaError('Sleeper requires a two-factor code for this account');
  }
  if ((errors ?? []).some((e) => /captcha/i.test(e.message))) {
    throw new CaptchaError();
  }

  throw new RejectedError(summarise(errors ?? []) || 'Login failed', { errors });
}
