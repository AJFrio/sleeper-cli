/**
 * GraphQL transport behaviour.
 *
 * The cases here cover the three things that were established by probing the live
 * server rather than from documentation, and that a future refactor could plausibly
 * regress:
 *
 *  - the session token goes in a bare `Authorization` header, not `Bearer <token>`;
 *  - an unauthenticated call returns HTTP 200 with an `errors` array, so a
 *    status-only check would report success;
 *  - `unauthorized` has to be classified as a session failure so the operator is told
 *    to log in again rather than shown a generic rejection.
 *
 * Everything is served by a fake fetch, so the suite never touches the network.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CaptchaError,
  EXIT,
  MfaError,
  NetworkError,
  RateLimitError,
  RejectedError,
  SessionError,
} from '../src/core/errors.js';
import { extractOperationName, GraphQLClient, loginToSleeper } from '../src/core/graphql.js';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: unknown, status = 200) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof response === 'string' ? response : JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(impl: typeof fetch, token?: string) {
  return new GraphQLClient({
    fetchImpl: impl,
    sleepImpl: async () => {},
    maxRetries: 0,
    ...(token ? { onToken: () => {} } : {}),
  });
}

describe('Authorization header', () => {
  it('sends a bare token, with no Bearer prefix', async () => {
    const { impl, calls } = fakeFetch({ data: { me: { user_id: '1' } } });
    const c = client(impl);
    c.setToken('raw-token-value');

    await c.query('{ me { user_id } }');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('raw-token-value');
    expect(headers.Authorization).not.toMatch(/^Bearer/);
  });

  it('omits the header entirely when unauthenticated', async () => {
    const { impl, calls } = fakeFetch({ data: { login: { token: 't' } } });
    await client(impl).query('query login { login { token } }');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('identifies itself as the web client, without a CSRF token', async () => {
    const { impl, calls } = fakeFetch({ data: { me: { user_id: '1' } } });
    const c = client(impl);
    c.setToken('t');

    await c.query('query me { me { user_id } }');

    const headers = calls[0]?.init.headers as Record<string, string>;
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

    // No anti-forgery header exists; Sleeper's current client sends none.
    expect(Object.keys(lower).some((k) => k.includes('hash') || k.includes('csrf'))).toBe(false);

    // These three are sent by Sleeper's own client and reported as required by
    // independent third-party implementations.
    expect(lower.origin).toBe('https://sleeper.com');
    expect(lower.referer).toBe('https://sleeper.com/');
    expect(lower['x-sleeper-graphql-op']).toBe('me');
  });

  it('sends the operation name even for an unauthenticated query', async () => {
    const { impl, calls } = fakeFetch({ data: { me: null } });
    await client(impl).query('{ me { user_id } }');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['X-Sleeper-GraphQL-Op']).toBe('me');
  });
});

describe('error handling', () => {
  it('treats a 200 carrying an unauthorized error as a session failure', async () => {
    const { impl } = fakeFetch({
      data: { me: null },
      errors: [{ code: 'unauthorized', message: 'Unauthorized', path: ['me'] }],
    });

    const error = await client(impl)
      .query('{ me { user_id } }')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SessionError);
    expect((error as SessionError).exitCode).toBe(EXIT.SESSION);
    expect((error as SessionError).hint).toContain('auth login');
  });

  it('classifies other errors as rejections, not transport failures', async () => {
    const { impl } = fakeFetch({
      data: { roster_update_starters: null },
      errors: [{ message: 'Roster is full', path: ['roster_update_starters'] }],
    });

    const error = await client(impl)
      .query('mutation x { roster_update_starters { roster_id } }')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RejectedError);
    expect((error as RejectedError).exitCode).toBe(EXIT.REJECTED);
    expect((error as RejectedError).message).toContain('Roster is full');
  });

  it('joins several error messages', async () => {
    const { impl } = fakeFetch({
      data: null,
      errors: [{ message: 'first problem' }, { message: 'second problem' }],
    });

    const error = await client(impl)
      .query('mutation x { y { z } }')
      .catch((err: unknown) => err);

    expect((error as RejectedError).message).toBe('first problem; second problem');
  });

  it('maps HTTP 429 to a rate-limit error and reads Retry-After', async () => {
    const calls: Call[] = [];
    const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{}', { status: 429, headers: { 'retry-after': '3' } });
    });

    const error = await client(impl as unknown as typeof fetch)
      .query('{ me { user_id } }')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(3000);
  });

  it('maps a transport failure to a network error', async () => {
    const impl = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    });

    const error = await client(impl as unknown as typeof fetch)
      .query('{ me { user_id } }')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).toContain('DNS');
  });

  it('maps a non-JSON body to a network error', async () => {
    const impl = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));

    const error = await client(impl as unknown as typeof fetch)
      .query('{ me { user_id } }')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NetworkError);
  });

  it('does not retry an unauthorized response', async () => {
    const { impl, calls } = fakeFetch({
      data: null,
      errors: [{ code: 'unauthorized', message: 'Unauthorized' }],
    });
    const c = new GraphQLClient({
      fetchImpl: impl,
      sleepImpl: async () => {},
      maxRetries: 3,
    });

    await c.query('{ me { user_id } }').catch(() => undefined);
    expect(calls).toHaveLength(1);
  });
});

describe('queryAllowingErrors', () => {
  it('returns field errors instead of throwing', async () => {
    const { impl } = fakeFetch({
      data: { get_league: null },
      errors: [{ message: 'nope', path: ['get_league'] }],
    });

    const result = await client(impl).queryAllowingErrors('{ get_league { league_id } }');
    expect(result.data).toEqual({ get_league: null });
    expect(result.errors).toHaveLength(1);
  });

  it('still throws on unauthorized', async () => {
    const { impl } = fakeFetch({
      data: { league_rosters: null },
      errors: [{ code: 'unauthorized', message: 'Unauthorized' }],
    });

    await expect(
      client(impl).queryAllowingErrors('{ league_rosters { roster_id } }'),
    ).rejects.toBeInstanceOf(SessionError);
  });
});

describe('extractOperationName', () => {
  it('reads a named operation', () => {
    expect(extractOperationName('query me { me { user_id } }')).toBe('me');
  });

  it('reads a named mutation', () => {
    expect(extractOperationName('mutation roster_update_starters { x }')).toBe(
      'roster_update_starters',
    );
  });

  it('falls back to the first field for an anonymous query', () => {
    expect(extractOperationName('{ me { user_id } }')).toBe('me');
  });

  it('reports unknown for an unrecognisable document', () => {
    expect(extractOperationName('not graphql')).toBe('anonymous');
  });
});

describe('loginToSleeper', () => {
  it('returns the token and installs it on the client', async () => {
    const { impl, calls } = fakeFetch({ data: { login: { token: 'issued-token' } } });
    const c = client(impl);

    const result = await loginToSleeper(c, { identifier: 'me@example.com', password: 'hunter2' });

    expect(result.token).toBe('issued-token');
    expect(result.requiresOtp).toBe(false);
    expect(c.token).toBe('issued-token');

    // The password must be in the variables; nothing else should leak it.
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.variables.password).toBe('hunter2');
  });

  it('reports a captcha requirement distinctly', async () => {
    const { impl } = fakeFetch({
      data: { login: null },
      errors: [{ message: 'captcha required' }],
    });

    const error = await loginToSleeper(client(impl), {
      identifier: 'me@example.com',
      password: 'x',
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CaptchaError);
  });

  it('detects a two-factor requirement', async () => {
    const { impl } = fakeFetch({
      data: { login: null },
      errors: [{ code: 'mfa_required', message: 'two-factor code needed' }],
    });

    const error = await loginToSleeper(client(impl), {
      identifier: 'me@example.com',
      password: 'x',
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MfaError);
  });

  it('surfaces a plain rejection', async () => {
    const { impl } = fakeFetch({
      data: { login: null },
      errors: [{ message: 'Incorrect username or password' }],
    });

    await expect(
      loginToSleeper(client(impl), { identifier: 'me@example.com', password: 'wrong' }),
    ).rejects.toThrow(/Incorrect username or password/);
  });
});
