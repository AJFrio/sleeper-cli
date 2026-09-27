/**
 * `sleeper doctor` — a single diagnostic covering everything that can be wrong.
 *
 * Written so each check runs independently and a failure in one never prevents the
 * rest from reporting. A diagnostic that stops at the first problem hides the
 * second problem, which is the opposite of its purpose.
 *
 * Exits 0 when healthy, 1 when any check failed, 0 when only warnings fired, so it
 * works as a CI gate.
 */

import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { describeSession } from '../config/credentials.js';
import { describePaths } from '../config/paths.js';
import { SessionError } from '../core/errors.js';
import { buildContext } from '../output/context.js';
import { formatAge, formatBytes } from '../output/format.js';
import type { CommandDeps } from './deps.js';

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

/**
 * Must track `engines.node` in package.json. Node 20.12 is the floor because the test
 * toolchain imports `util.styleText`, added in that release, so nothing below it can
 * run the suite.
 */
const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 12;

function checkNodeVersion(): Check {
  const [rawMajor, rawMinor] = process.versions.node.split('.');
  const major = Number(rawMajor);
  const minor = Number(rawMinor);
  const version = process.versions.node;
  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);

  return {
    name: 'node version',
    status: ok ? 'ok' : 'fail',
    detail: version,
    ...(ok ? {} : { hint: `Requires Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.` }),
  };
}

function checkConfigDir(): Check {
  const paths = describePaths();
  try {
    accessSync(paths.config_dir, constants.W_OK);
    return { name: 'config dir writable', status: 'ok', detail: paths.config_dir };
  } catch (err) {
    // A missing directory is the normal first-run state, not a fault: the CLI creates
    // it on first write. Only an existing-but-unwritable directory is a real problem,
    // so create it and re-test before reporting a failure.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        mkdirSync(paths.config_dir, { recursive: true, mode: 0o700 });
        return {
          name: 'config dir writable',
          status: 'ok',
          detail: `${paths.config_dir} (created)`,
        };
      } catch (mkdirErr) {
        return {
          name: 'config dir writable',
          status: 'fail',
          detail: `could not create ${paths.config_dir} (${(mkdirErr as Error).message})`,
          hint: 'Set SLEEPER_CLI_HOME to a writable directory.',
        };
      }
    }
    return {
      name: 'config dir writable',
      status: 'fail',
      detail: `${paths.config_dir} (${(err as Error).message})`,
      hint: 'Set SLEEPER_CLI_HOME to a writable directory.',
    };
  }
}

function checkCredentialsFile(): Check {
  const summary = describeSession();
  if (summary.source !== 'file') {
    return {
      name: 'credentials',
      status: summary.source === 'env' ? 'ok' : 'skip',
      detail:
        summary.source === 'env'
          ? 'Provided by SLEEPER_TOKEN, nothing on disk'
          : 'No stored credentials',
      ...(summary.source === 'none' ? { hint: 'Run `sleeper auth login`.' } : {}),
    };
  }

  try {
    const mode = statSync(summary.file).mode & 0o777;
    const tooOpen = (mode & 0o077) !== 0;
    return {
      name: 'credentials',
      status: tooOpen ? 'warn' : 'ok',
      detail: `${summary.file} (mode ${mode.toString(8).padStart(4, '0')})`,
      // The file holds a bearer credential, so a readable-by-others mode is a real
      // exposure rather than a cosmetic one.
      ...(tooOpen ? { hint: `chmod 600 ${summary.file}` } : {}),
    };
  } catch (err) {
    return {
      name: 'credentials',
      status: 'fail',
      detail: `${summary.file} (${(err as Error).message})`,
    };
  }
}

async function checkSession(deps: CommandDeps): Promise<Check> {
  if (describeSession().source === 'none') {
    return { name: 'session', status: 'skip', detail: 'No session to validate' };
  }
  try {
    const me = await deps.client().me({ refresh: true });
    return {
      name: 'session',
      status: 'ok',
      detail: `valid, user ${me.display_name ?? me.username ?? me.user_id}`,
    };
  } catch (err) {
    if (err instanceof SessionError) {
      return {
        name: 'session',
        status: 'fail',
        detail: 'rejected by Sleeper',
        hint: 'Run `sleeper auth login`.',
      };
    }
    return { name: 'session', status: 'warn', detail: (err as Error).message };
  }
}

async function checkActiveLeague(deps: CommandDeps): Promise<Check> {
  const leagueId = deps.client().config.active_league_id;
  if (!leagueId) {
    return {
      name: 'active league',
      status: 'skip',
      detail: 'No league selected',
      hint: 'Run `sleeper leagues use <id>`.',
    };
  }
  try {
    const league = await deps.client().rest.getLeague(leagueId);
    return { name: 'active league', status: 'ok', detail: `${league.name} (${leagueId})` };
  } catch (err) {
    return {
      name: 'active league',
      status: 'fail',
      detail: `league ${leagueId} is not reachable (${(err as Error).message})`,
      hint: 'This league may no longer exist. Run `sleeper leagues list` and pick another.',
    };
  }
}

function checkPlayerCache(deps: CommandDeps): Check {
  const cache = deps.client().players;
  const size = cache.sizeBytes();
  const age = cache.ageMs();
  const warm = cache.has();

  if (!warm) {
    return {
      name: 'player cache',
      status: 'warn',
      detail: size === undefined ? 'absent' : `stale (${formatBytes(size)}, ${formatAge(age)})`,
      hint: 'Run `sleeper players cache --refresh`. The first command that needs names will otherwise download ~5MB.',
    };
  }
  return {
    name: 'player cache',
    status: 'ok',
    detail: `${formatBytes(size)}, updated ${formatAge(age)}`,
  };
}

async function checkSleeperReachable(deps: CommandDeps): Promise<Check> {
  try {
    const state = await deps.client().state();
    return {
      name: 'sleeper reachable',
      status: 'ok',
      detail: `${state.season} week ${state.week} (${state.season_type})`,
    };
  } catch (err) {
    return {
      name: 'sleeper reachable',
      status: 'fail',
      detail: (err as Error).message,
      hint: 'Check network connectivity and any proxy settings.',
    };
  }
}

function rateLimitNote(): Check {
  return {
    name: 'rate limit headroom',
    status: 'ok',
    detail: 'Sleeper documents a 1000 req/min ceiling on the public REST API',
  };
}

export function registerDoctorCommand(program: Command, deps: CommandDeps): void {
  program
    .command('doctor')
    .description('Diagnose configuration, session, cache and connectivity problems')
    .addHelpText('after', '\nExits 0 when healthy, 1 when any check failed. Warnings do not fail.')
    .action(
      async (options: {
        json?: boolean;
        table?: boolean;
        quiet?: boolean;
        debug?: boolean;
        explain?: boolean;
        dryRun?: boolean;
        yes?: boolean;
      }) => {
        const context = buildContext(options, deps.client().config.output);
        const emit = deps.emit();

        const checks: Check[] = [
          checkNodeVersion(),
          checkConfigDir(),
          checkCredentialsFile(),
          await checkSession(deps),
          await checkActiveLeague(deps),
          checkPlayerCache(deps),
          await checkSleeperReachable(deps),
          rateLimitNote(),
        ];

        const summary = {
          ok: checks.filter((c) => c.status === 'ok').length,
          warn: checks.filter((c) => c.status === 'warn').length,
          fail: checks.filter((c) => c.status === 'fail').length,
          skip: checks.filter((c) => c.status === 'skip').length,
        };
        const healthy = summary.fail === 0;

        if (context.json) {
          emit.emit({
            command: deps.commandPath(),
            data: { checks, summary, healthy },
            table: () => '',
          });
        } else {
          const symbol: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '·' };
          const lines = checks.flatMap((check) => {
            const head = `  ${symbol[check.status]} ${check.name.padEnd(22)} ${check.detail}`;
            return check.hint ? [head, `      → ${check.hint}`] : [head];
          });
          emit.emitRaw(
            [
              '',
              'sleeper doctor',
              ...lines,
              '',
              `  ${summary.ok} ok, ${summary.warn} warning(s), ${summary.fail} failure(s), ${summary.skip} skipped`,
              '',
            ].join('\n'),
          );
        }

        if (!healthy) process.exitCode = 1;
      },
    );
}
