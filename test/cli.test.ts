/**
 * End-to-end behaviour of the `sleeper` binary.
 *
 * The JSON envelope shape and the exit-code mapping are the two things an agent
 * depends on, so they are tested through the real entry point rather than a unit.
 *
 * Every case here is offline. The commands chosen are ones that either need no
 * session or fail before any network call, and `SLEEPER_CLI_HOME` is redirected to a
 * temp directory so the developer's real credentials can never be read.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(ROOT, 'src', 'index.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI through tsx, with state redirected away from the real home directory. */
async function sleeper(
  args: string[],
  home: string,
  env: Record<string, string> = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec('npx', ['tsx', ENTRY, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        SLEEPER_CLI_HOME: home,
        SLEEPER_CLI_CACHE_DIR: join(home, 'cache'),
        // Ensure no ambient token leaks into the test.
        SLEEPER_TOKEN: '',
        SLEEPER_USERNAME: '',
        SLEEPER_PASSWORD: '',
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('sleeper CLI', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sleeper-cli-test-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe('help and version', () => {
    it('prints help and exits 0', async () => {
      const result = await sleeper(['--help'], home);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Manage Fantasy Football teams on Sleeper');
    });

    it('lists every command group', async () => {
      const result = await sleeper(['--help'], home);
      for (const command of [
        'auth',
        'leagues',
        'roster',
        'lineup',
        'add',
        'drop',
        'trade',
        'waiver',
        'players',
        'matchups',
        'stats',
        'transactions',
        'draft',
        'config',
        'doctor',
      ]) {
        expect(result.stdout).toContain(command);
      }
    });

    it('prints the version and exits 0', async () => {
      const result = await sleeper(['--version'], home);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('gives per-command help', async () => {
      const result = await sleeper(['trade', 'propose', '--help'], home);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('--receive');
      expect(result.stdout).toContain('--dry-run');
    });
  });

  describe('exit codes', () => {
    it('returns 2 for an unknown flag', async () => {
      const result = await sleeper(['leagues', 'list', '--not-a-flag'], home);
      expect(result.code).toBe(2);
    });

    it('returns 2 when no league is selected', async () => {
      const result = await sleeper(['roster', 'show'], home);
      expect(result.code).toBe(2);
    });

    it('returns 3 for a write with no session', async () => {
      const result = await sleeper(['add', '9221'], home);
      expect(result.code).toBe(3);
    });

    it('returns 3 rather than 2 when a session is required but absent', async () => {
      // Order matters: the session check must come before league resolution, or an
      // agent cannot tell "not signed in" from "no league chosen".
      const result = await sleeper(['add', '9221', '--json'], home);
      const payload = JSON.parse(result.stdout);
      expect(result.code).toBe(3);
      expect(payload.error.code).toBe('unauthenticated');
    });
  });

  describe('json contract', () => {
    it('wraps a success in a single-line envelope', async () => {
      const result = await sleeper(['auth', 'status', '--offline', '--json'], home);
      expect(result.code).toBe(0);
      // A single line, so a `| jq -c` consumer is not surprised by pretty printing.
      expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);

      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(true);
      expect(payload.command).toBe('sleeper auth status');
      expect(payload.data).toHaveProperty('authenticated');
    });

    it('wraps a failure with a code and an exit_code', async () => {
      const result = await sleeper(['roster', 'show', '--json'], home);
      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe('usage');
      expect(payload.error.exit_code).toBe(2);
      expect(payload.error.hint).toBeTruthy();
    });

    it('keeps stdout clean for jq when a failure is reported', async () => {
      const result = await sleeper(['roster', 'show', '--json'], home);
      // Every line on stdout must be parseable, so nothing is interleaved.
      for (const line of result.stdout.trim().split('\n')) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('names the full command path in the envelope', async () => {
      const result = await sleeper(['config', 'paths', '--json'], home);
      expect(JSON.parse(result.stdout).command).toBe('sleeper config paths');
    });

    it('forces table output with --table even when config prefers json', async () => {
      await sleeper(['config', 'set', 'output', 'json'], home);
      const asJson = await sleeper(['config', 'paths'], home);
      const asTable = await sleeper(['config', 'paths', '--table'], home);

      expect(() => JSON.parse(asJson.stdout)).not.toThrow();
      expect(asTable.stdout).toContain('config_dir');
    });
  });

  describe('config', () => {
    it('persists a setting across invocations', async () => {
      await sleeper(['config', 'set', 'output', 'json'], home);
      const result = await sleeper(['config', 'get', 'output', '--json'], home);
      expect(JSON.parse(result.stdout).data.value).toBe('json');
    });

    it('rejects an invalid value with a helpful hint', async () => {
      const result = await sleeper(['config', 'set', 'output', 'yaml', '--json'], home);
      const payload = JSON.parse(result.stdout);
      expect(result.code).toBe(2);
      expect(payload.error.hint).toContain('table');
    });

    it('rejects an unknown key and lists the valid ones', async () => {
      const result = await sleeper(['config', 'get', 'nope', '--json'], home);
      const payload = JSON.parse(result.stdout);
      expect(result.code).toBe(2);
      expect(payload.error.hint).toContain('active_league_id');
    });

    it('reports the paths it resolved', async () => {
      const result = await sleeper(['config', 'paths', '--json'], home);
      const paths = JSON.parse(result.stdout).data;
      expect(paths.config_dir).toContain(home);
    });
  });

  describe('session reporting', () => {
    it('reports no session offline and exits 0', async () => {
      const result = await sleeper(['auth', 'status', '--offline', '--json'], home);
      const payload = JSON.parse(result.stdout);
      expect(result.code).toBe(0);
      expect(payload.data.authenticated).toBe(false);
    });

    it('never prints a token without --reveal', async () => {
      await sleeper(['config', 'set', 'output', 'json'], home);
      const result = await sleeper(['auth', 'token', '--json'], home);
      const payload = JSON.parse(result.stdout);
      // The key must be absent entirely, so an agent piping --json cannot capture a
      // bearer credential by accident.
      expect(payload.data.token).toBeUndefined();
      expect(payload.data.revealed).toBe(false);
      expect(payload.data.available).toBe(false);
    });
  });

  describe('doctor', () => {
    it('reports a structured summary and does not abort on the first failure', async () => {
      const result = await sleeper(['doctor', '--json'], home);
      const payload = JSON.parse(result.stdout);

      expect(payload.data.checks.length).toBeGreaterThan(4);
      expect(payload.data.summary).toHaveProperty('ok');
      expect(payload.data).toHaveProperty('healthy');

      // No league and no session are skipped rather than fatal, so the summary is
      // present even on a fresh machine.
      expect(
        payload.data.checks.some((c: { name: string }) => c.name === 'sleeper reachable'),
      ).toBe(true);
    });

    it('exits 0 when only warnings are present', async () => {
      const result = await sleeper(['doctor', '--json'], home);
      const payload = JSON.parse(result.stdout);
      if (payload.data.summary.fail === 0) {
        expect(result.code).toBe(0);
      }
    });
  });

  describe('mutations are gated', () => {
    it('refuses a mutation with a fake token instead of calling Sleeper', async () => {
      // The session check passes, then league resolution fails before any write, so
      // this exercises the ordering without a real account.
      const result = await sleeper(['add', '9221', '--json', '--yes'], home, {
        SLEEPER_TOKEN: 'not-a-real-token',
      });
      expect(result.code).toBeGreaterThan(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(false);
      // It must never report success.
      expect(payload.data?.dry_run).toBeUndefined();
    });

    it('fails cleanly rather than transmitting when preconditions are unmet', async () => {
      const result = await sleeper(
        ['trade', 'propose', '--with', '2', '--receive', '1309', '--explain', '--json'],
        home,
        { SLEEPER_TOKEN: 'not-a-real-token' },
      );
      // No league is configured, so this stops at resolution. What matters is that it
      // stops: nothing was sent, and the failure is reported rather than swallowed.
      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe('usage');
      expect(result.stdout).not.toContain('propose_trade');
    });
  });
});
