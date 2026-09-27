/**
 * Credential storage and resolution.
 *
 * Three sources are consulted, in descending precedence:
 *
 *   1. Environment variables — for CI and one-shot agent invocations, where
 *      writing anything to disk is undesirable.
 *   2. The credentials file — the normal interactive path.
 *   3. Nothing — the caller gets a SessionError telling it to log in.
 *
 * The file is written with mode 0600 inside a 0700 directory. It holds the session
 * token, which is a bearer credential equivalent to a password, and is created
 * with owner-only permissions on the assumption it may end up in a backup.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_DIR, CREDENTIALS_FILE } from './paths.js';

export interface StoredCredentials {
  /** Session token from Sleeper's `login` query. Bearer-equivalent; treat as a password. */
  token: string;
  /** Email, phone, or username the token was obtained with. Used only for display. */
  identifier?: string;
  /** Epoch milliseconds at which the token was issued, for staleness reporting. */
  obtained_at?: number;
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Resolve the session token from the environment, falling back to disk.
 *
 * `SLEEPER_TOKEN` exists so an agent can pass a credential it already holds
 * without this CLI ever writing it to disk.
 */
export function resolveToken(): string | undefined {
  const fromEnv = process.env.SLEEPER_TOKEN;
  if (isNonEmpty(fromEnv)) return fromEnv.trim();
  return loadCredentials()?.token;
}

/** Resolve the login identifier, for commands that need to re-authenticate. */
export function resolveIdentifier(): string | undefined {
  const fromEnv = process.env.SLEEPER_USERNAME ?? process.env.SLEEPER_IDENTIFIER;
  if (isNonEmpty(fromEnv)) return fromEnv.trim();
  return loadCredentials()?.identifier;
}

/** Resolve the password, for `sleeper auth login --identifier`. */
export function resolvePassword(): string | undefined {
  const fromEnv = process.env.SLEEPER_PASSWORD;
  if (isNonEmpty(fromEnv)) return fromEnv;
  return undefined;
}

/** Read stored credentials, or undefined when absent or unparseable. */
export function loadCredentials(): StoredCredentials | undefined {
  if (!existsSync(CREDENTIALS_FILE)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const raw = parsed as Partial<StoredCredentials>;
    if (!isNonEmpty(raw.token)) return undefined;
    return {
      token: raw.token.trim(),
      ...(isNonEmpty(raw.identifier) ? { identifier: raw.identifier.trim() } : {}),
      ...(typeof raw.obtained_at === 'number' ? { obtained_at: raw.obtained_at } : {}),
    };
  } catch {
    // A corrupt credentials file should degrade to "not logged in" rather than
    // making every command fail with a parse error.
    return undefined;
  }
}

/** Write credentials atomically with owner-only permissions. */
export function saveCredentials(creds: StoredCredentials): void {
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true, mode: 0o700 });

  const temp = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, CREDENTIALS_FILE);

  // rename preserves the temp file's mode, but be explicit: on some systems an
  // existing target directory can carry a looser mode.
  try {
    chmodSync(CREDENTIALS_FILE, 0o600);
    chmodSync(CONFIG_DIR, 0o700);
  } catch {
    // Best effort. A platform that rejects chmod is not a reason to fail login.
  }
}

/** Delete stored credentials. Safe to call when nothing is stored. */
export function clearCredentials(): void {
  rmSync(CREDENTIALS_FILE, { force: true });
}

/** Where a resolved credential came from, for `sleeper auth status`. */
export type CredentialSource = 'env' | 'file' | 'none';

export interface SessionSummary {
  source: CredentialSource;
  identifier: string | undefined;
  obtained_at: number | undefined;
  /** Path to the credentials file, when one is on disk. */
  file: string;
}

/** Describe the current credential state without exposing the token. */
export function describeSession(): SessionSummary {
  const fromEnv = isNonEmpty(process.env.SLEEPER_TOKEN);
  const stored = loadCredentials();
  return {
    source: fromEnv ? 'env' : stored ? 'file' : 'none',
    identifier: isNonEmpty(process.env.SLEEPER_USERNAME)
      ? process.env.SLEEPER_USERNAME
      : stored?.identifier,
    obtained_at: stored?.obtained_at,
    file: CREDENTIALS_FILE,
  };
}
