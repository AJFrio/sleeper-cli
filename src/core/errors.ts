/**
 * Typed error hierarchy and the process exit codes that go with it.
 *
 * Exit codes are part of the public contract. Agents branch on them, so they are
 * stable and deliberately fine-grained: an agent that sees EXIT_SESSION can
 * re-authenticate on its own, and one that sees EXIT_REJECTED knows its request
 * reached Sleeper and was refused on the merits rather than failing in transit.
 */

/** Stable exit codes. Documented in the README; do not renumber. */
export const EXIT = {
  OK: 0,
  /** Something went wrong with no more specific classification. */
  ERROR: 1,
  /** The command line itself was wrong: unknown flag, missing argument. */
  USAGE: 2,
  /** No valid session. Re-run `sleeper auth login`. */
  SESSION: 3,
  /** A league, roster, player or transaction id does not exist. */
  NOT_FOUND: 4,
  /** Sleeper understood the request and refused it. */
  REJECTED: 5,
  /** Sleeper is rate limiting us. */
  RATE_LIMITED: 6,
  /** Could not reach Sleeper at all. */
  NETWORK: 7,
  /** The action would change state but was not confirmed. */
  NEEDS_CONFIRMATION: 8,
  /** A captcha challenge must be solved before login can proceed. */
  CAPTCHA: 9,
  /** Two-factor code required or rejected. */
  MFA: 10,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class SleeperError extends Error {
  readonly exitCode: ExitCode;
  /** Machine-readable discriminator, mirrored in `--json` output. */
  readonly code: string;
  /** Actionable next step for the operator or agent. */
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(
    message: string,
    options: {
      exitCode?: ExitCode;
      code?: string;
      hint?: string;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SleeperError';
    this.exitCode = options.exitCode ?? EXIT.ERROR;
    this.code = options.code ?? 'error';
    this.hint = options.hint;
    this.details = options.details;
  }
}

/** Bad command line. Commander normally catches these, but we raise our own for parsing. */
export class UsageError extends SleeperError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: EXIT.USAGE, code: 'usage', hint });
    this.name = 'UsageError';
  }
}

/** No usable session, or the session is no longer accepted. */
export class SessionError extends SleeperError {
  constructor(message = 'Not signed in to Sleeper', hint?: string) {
    super(message, {
      exitCode: EXIT.SESSION,
      code: 'unauthenticated',
      hint: hint ?? 'Run `sleeper auth login` to create a session.',
    });
    this.name = 'SessionError';
  }
}

/** A referenced entity does not exist. */
export class NotFoundError extends SleeperError {
  constructor(what: string, id: string | number, hint?: string) {
    super(`${what} not found: ${id}`, {
      exitCode: EXIT.NOT_FOUND,
      code: 'not_found',
      ...(hint ? { hint } : {}),
    });
    this.name = 'NotFoundError';
  }
}

/** Sleeper parsed the request and refused it: illegal roster move, bad slot, stale pick. */
export class RejectedError extends SleeperError {
  constructor(message: string, details?: unknown) {
    super(message, { exitCode: EXIT.REJECTED, code: 'rejected', details });
    this.name = 'RejectedError';
  }
}

/** Transport-level failure: DNS, TLS, timeout, connection reset. */
export class NetworkError extends SleeperError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      exitCode: EXIT.NETWORK,
      code: 'network',
      hint: 'Check connectivity and try again.',
      cause,
    });
    this.name = 'NetworkError';
  }
}

/** Sleeper is throttling us. Carries the server's hint about when to retry. */
export class RateLimitError extends SleeperError {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message, {
      exitCode: EXIT.RATE_LIMITED,
      code: 'rate_limited',
      hint: retryAfterMs
        ? `Retry in about ${Math.ceil(retryAfterMs / 1000)}s.`
        : 'Slow down and retry shortly.',
      details: { retry_after_ms: retryAfterMs },
    });
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** The mutation would change league state but was not confirmed. */
export class ConfirmationRequiredError extends SleeperError {
  constructor(message: string, hint?: string) {
    super(message, {
      exitCode: EXIT.NEEDS_CONFIRMATION,
      code: 'needs_confirmation',
      hint: hint ?? 'Re-run with --yes to apply, or --dry-run to preview.',
    });
    this.name = 'ConfirmationRequiredError';
  }
}

/** A captcha blocks login. Not retryable without human or browser help. */
export class CaptchaError extends SleeperError {
  constructor(message = 'Sleeper requires a captcha to complete this login') {
    super(message, {
      exitCode: EXIT.CAPTCHA,
      code: 'captcha_required',
      hint: 'Solve the CAPTCHA in a browser and retry with --captcha <token>, or use an existing Sleeper API session token through SLEEPER_TOKEN. Browser cookies alone are not accepted by the GraphQL API.',
    });
    this.name = 'CaptchaError';
  }
}

/** Sleeper explicitly reported a multi-factor verification challenge. */
export class MfaError extends SleeperError {
  constructor(message: string) {
    super(message, {
      exitCode: EXIT.MFA,
      code: 'mfa_required',
      hint: 'The current password login API does not accept a one-time code. Complete sign-in on sleeper.com and provide an existing API session token through SLEEPER_TOKEN.',
    });
    this.name = 'MfaError';
  }
}

/**
 * Normalise anything thrown into a SleeperError.
 *
 * Commander and Node both throw shapes that are not ours; routing every failure
 * through here means `main` can rely on a single exit-code path.
 */
export function toSleeperError(err: unknown): SleeperError {
  if (err instanceof SleeperError) return err;
  if (err instanceof Error) {
    if (err.name === 'CommanderError') {
      return new UsageError(err.message);
    }
    return new SleeperError(err.message, { cause: err });
  }
  return new SleeperError(String(err));
}
