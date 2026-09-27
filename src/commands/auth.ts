/**
 * `sleeper auth` — establishing and inspecting a session.
 *
 * Sleeper's `login` is a GraphQL query returning a bare token, which is then sent as
 * a raw `Authorization` header. No captcha and no browser are involved in the normal
 * path, so a session is a single HTTPS call. See docs/INTERNAL-API.md.
 *
 * The token is a bearer credential equivalent to a password, so its handling is the
 * main design constraint in this file: it is never written to stdout by default, and
 * never included in a JSON envelope unless explicitly revealed.
 */

import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import {
  clearCredentials,
  describeSession,
  resolveIdentifier,
  resolveOtp,
  resolvePassword,
  saveCredentials,
} from '../config/credentials.js';
import { MfaError, SessionError, UsageError } from '../core/errors.js';
import { loginToSleeper } from '../core/graphql.js';
import { avatarUrl } from '../core/types.js';
import { buildContext } from '../output/context.js';
import { renderRecord } from '../output/format.js';
import { confirmAction, isInteractive } from '../output/safety.js';
import type { CommandDeps } from './deps.js';

interface AuthOptions {
  identifier?: string;
  password?: string;
  otp?: string;
  captcha?: string;
  save?: boolean;
  offline?: boolean;
  reveal?: boolean;
  yes?: boolean;
  json?: boolean;
  table?: boolean;
  quiet?: boolean;
  debug?: boolean;
  explain?: boolean;
  dryRun?: boolean;
}

/**
 * Read a secret without echoing it.
 *
 * `readline` cannot suppress echo, so this drives stdin directly: raw mode is
 * enabled, printable characters are accumulated but never written, and only a
 * newline is echoed. Without this a password would land in terminal scrollback, in a
 * screen share, and in any session recording.
 *
 * Works with piped input too, since a non-TTY stdin has no echo to suppress and the
 * same byte handling applies.
 */
function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;

    process.stdout.write(prompt);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let buffered = '';

    const finish = (value: string): void => {
      stdin.off('data', onData);
      stdin.pause();
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      process.stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');

      // Ctrl-C: abandon the prompt rather than treating it as input.
      if (text.includes('\u0003')) {
        finish('');
        process.exitCode = 130;
        return;
      }
      if (text.includes('\n') || text.includes('\r') || text.includes('\u0004')) {
        finish(buffered);
        return;
      }
      if (text.includes('\u007f') || text.includes('\b')) {
        buffered = buffered.slice(0, -1);
        return;
      }
      // Drop remaining control characters so a stray escape sequence cannot end up
      // inside the password and silently corrupt it.
      // biome-ignore-start lint/suspicious/noControlCharactersInRegex: matching control characters is the point
      buffered += text.replace(/[\u0000-\u001f\u007f]/g, '');
      // biome-ignore-end lint/suspicious/noControlCharactersInRegex: matching control characters is the point
    };

    stdin.on('data', onData);
  });
}

/** Prompt for a plain visible value. */
function promptText(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function loginWithOtpPrompt(
  client: Parameters<typeof loginToSleeper>[0],
  input: Omit<Parameters<typeof loginToSleeper>[1], 'otp'>,
  otp?: string,
): Promise<string> {
  try {
    return (
      await loginToSleeper(client, {
        ...input,
        ...(otp ? { otp } : {}),
      })
    ).token;
  } catch (error) {
    if (!(error instanceof MfaError) || otp || !isInteractive()) throw error;

    const challengeOtp = await promptSecret('Two-factor code sent by Sleeper: ');
    if (!challengeOtp) throw error;

    return (await loginToSleeper(client, { ...input, otp: challengeOtp })).token;
  }
}

export function registerAuthCommands(program: Command, deps: CommandDeps): void {
  const auth = program.command('auth').description('Sign in, inspect the session, and sign out');

  // ---------------------------------------------------------------- login
  auth
    .command('login')
    .description('Exchange a Sleeper password for a session token')
    .option('--identifier <id>', 'email, phone number, or username')
    .option('--password <pw>', 'password (prefer the env var or the prompt)')
    .option('--otp <code>', 'two-factor code, when the account requires one')
    .option('--captcha <token>', 'captcha token, if Sleeper challenges the login')
    .option('--no-save', 'do not persist the token to disk')
    .addHelpText(
      'after',
      [
        '',
        'The password can come from --password, the SLEEPER_PASSWORD environment',
        'variable, or an interactive prompt. It is never written to disk.',
        'Interactive logins prompt for a two-factor code when Sleeper requests one.',
        'For non-interactive runs, pass --otp or set SLEEPER_OTP.',
        '',
        'Examples:',
        '  sleeper auth login --identifier me@example.com',
        '  SLEEPER_PASSWORD=... sleeper auth login --identifier me@example.com',
        '  sleeper auth login --identifier me@example.com --otp 123456',
      ].join('\n'),
    )
    .action(async (options: AuthOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();

      const identifier =
        options.identifier ??
        resolveIdentifier() ??
        (await promptText('Sleeper email or username: '));
      if (!identifier)
        throw new UsageError(
          'No identifier supplied',
          'Pass --identifier or set SLEEPER_USERNAME.',
        );

      const password =
        options.password ??
        resolvePassword() ??
        (isInteractive() ? await promptSecret('Password: ') : undefined);
      if (!password) {
        throw new UsageError(
          'No password supplied and no terminal to prompt on',
          'Pass --password, set SLEEPER_PASSWORD, or run interactively.',
        );
      }

      const otp = options.otp ?? resolveOtp();

      if (context.explain) {
        emit.emitRaw(
          JSON.stringify(
            {
              operation: 'login',
              variables: { email_or_phone_or_username: identifier, otp: otp ?? null },
            },
            null,
            2,
          ),
        );
        return;
      }

      const loginInput = {
        identifier,
        password,
        ...(options.captcha ? { captcha: options.captcha } : {}),
      };

      const token = await loginWithOtpPrompt(client.graphql, loginInput, otp);

      client.graphql.setToken(token);

      if (options.save !== false) {
        saveCredentials({ token, identifier, obtained_at: Date.now() });
      }

      // Validate immediately so a login that "succeeded" but cannot read anything is
      // reported now rather than on the next command.
      const me = await client.me({ refresh: true });

      emit.emit({
        command: deps.commandPath(),
        data: {
          authenticated: true,
          persisted: options.save !== false,
          user: {
            user_id: me.user_id,
            username: me.username,
            display_name: me.display_name,
            avatar: avatarUrl(me.avatar),
          },
        },
        table: () =>
          [
            `Signed in as ${me.display_name ?? me.username ?? me.user_id}`,
            `  user id:   ${me.user_id}`,
            `  persisted: ${options.save !== false ? 'yes' : 'no (session only)'}`,
          ].join('\n'),
      });
    });

  // --------------------------------------------------------------- status
  auth
    .command('status')
    .description('Show whether a session exists and whether Sleeper still accepts it')
    .option('--offline', 'report local state only, without contacting Sleeper')
    .addHelpText(
      'after',
      '\nExits 0 even when no session exists: "not signed in" is a valid answer here.',
    )
    .action(async (options: AuthOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const client = deps.client();
      const summary = describeSession();

      if (options.offline || !summary.source.match(/env|file/)) {
        emit.emit({
          command: deps.commandPath(),
          data: { authenticated: false, checked: 'offline', ...summary },
          table: () =>
            renderRecord(
              {
                session: 'not present',
                source: summary.source,
                credentials_file: summary.file,
              },
              { indent: 2 },
            ),
        });
        return;
      }

      try {
        const me = await client.me({ refresh: true });
        emit.emit({
          command: deps.commandPath(),
          data: {
            authenticated: true,
            user: { user_id: me.user_id, username: me.username, display_name: me.display_name },
            ...summary,
          },
          table: () =>
            renderRecord(
              {
                session: 'valid',
                user_id: me.user_id,
                username: me.username ?? null,
                display_name: me.display_name ?? null,
                source: summary.source,
                obtained: summary.obtained_at ? new Date(summary.obtained_at).toISOString() : null,
                credentials_file: summary.file,
              },
              { indent: 2 },
            ),
        });
      } catch (err) {
        // A rejected token is a valid answer to "what is my session state?", so this
        // reports rather than failing, and still exits 0.
        const reason = err instanceof SessionError ? err.message : String(err);
        emit.emit({
          command: deps.commandPath(),
          data: { authenticated: false, reason, checked: 'online', ...summary },
          table: () =>
            renderRecord(
              { session: 'present but rejected', reason, source: summary.source },
              { indent: 2 },
            ),
        });
      }
    });

  // --------------------------------------------------------------- whoami
  auth
    .command('whoami')
    .description('Print the identity behind the current session')
    .action(async (options: AuthOptions) => {
      buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const me = await deps.client().me();
      emit.emit({
        command: deps.commandPath(),
        data: {
          user_id: me.user_id,
          username: me.username,
          display_name: me.display_name,
          avatar: avatarUrl(me.avatar),
        },
        table: () =>
          renderRecord(
            {
              user_id: me.user_id,
              username: me.username ?? null,
              display_name: me.display_name ?? null,
              avatar: avatarUrl(me.avatar),
            },
            { indent: 2 },
          ),
      });
    });

  // --------------------------------------------------------------- logout
  auth
    .command('logout')
    .description('Delete the stored session token')
    .action(async (options: AuthOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const summary = describeSession();

      if (summary.source === 'none') {
        emit.emit({
          command: deps.commandPath(),
          data: { removed: false, reason: 'no stored session' },
          table: () => 'No stored session to remove.',
        });
        return;
      }

      await confirmAction('delete the stored Sleeper session token', context);
      clearCredentials();
      deps.client().graphql.setToken(undefined);

      emit.emit({
        command: deps.commandPath(),
        data: { removed: true, source: summary.source },
        table: () => 'Signed out. The stored token has been deleted.',
      });
    });

  // ---------------------------------------------------------------- token
  auth
    .command('token')
    .description('Print the session token, for use as SLEEPER_TOKEN elsewhere')
    .option('--reveal', 'actually print the token')
    .addHelpText(
      'after',
      [
        '',
        'The token is a bearer credential equivalent to a password. Without --reveal',
        'this command reports only that a token exists, and the value is never',
        'included in --json output.',
      ].join('\n'),
    )
    .action(async (options: AuthOptions) => {
      const context = buildContext(options, deps.client().config.output);
      const emit = deps.emit();
      const summary = describeSession();
      const token = deps.client().graphql.token;

      if (summary.source === 'none' || !token) {
        emit.emit({
          command: deps.commandPath(),
          data: { available: false, revealed: false },
          table: () => 'No session token stored. Run `sleeper auth login` first.',
        });
        return;
      }

      if (!options.reveal) {
        emit.emit({
          command: deps.commandPath(),
          data: {
            available: true,
            revealed: false,
            hint: 're-run with --reveal to print the token',
          },
          table: () =>
            [
              'A session token is available.',
              'Re-run with --reveal to print it.',
              '',
              'This is a bearer credential equivalent to a password. Redirect it to a',
              'secure store, not a log.',
            ].join('\n'),
        });
        return;
      }

      // Deliberately stderr: a token on stdout would be captured by any `> file` or
      // pipe, and in JSON mode stdout is a machine contract that must stay clean.
      process.stderr.write(`${token}\n`);

      if (context.json) {
        emit.emitRaw(
          JSON.stringify({
            ok: true,
            command: deps.commandPath(),
            data: { available: true, revealed: true, token },
          }),
        );
      }
    });
}
