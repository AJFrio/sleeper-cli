/**
 * Safety gates for state-changing operations.
 *
 * A tool that can propose trades and drop players needs a deliberate default. Three
 * modes, selected by flags rather than inferred from whether a TTY happens to be
 * attached, so an agent's behaviour is the same whether or not it is interactive:
 *
 *  - `--dry-run`  compute and print the change, send nothing
 *  - `--yes`      send the change without asking
 *  - neither      ask on a TTY, refuse with exit code 8 otherwise
 *
 * The refusal rather than a silent prompt in non-interactive mode is deliberate: an
 * agent that forgot `--yes` should get a distinct, catchable exit code, not a hang.
 */

import { createInterface } from 'node:readline';
import { ConfirmationRequiredError, UsageError } from '../core/errors.js';

export interface SafetyOptions {
  /** Proceed without asking. */
  yes: boolean;
  /** Compute the change and report it without sending anything. */
  dryRun: boolean;
  /** Skip the TTY prompt even when attached. */
  assumeYes: boolean;
}

/** True when stdin is an interactive terminal. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Read one line from stdin. Resolves to undefined when stdin is closed. */
function readLine(prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => resolve(undefined));
  });
}

/** Accept the usual affirmative spellings, case-insensitively. */
function isAffirmative(answer: string | undefined): boolean {
  if (!answer) return false;
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

/**
 * Gate a state-changing action.
 *
 * `summary` describes what is about to happen and is shown both to the user and, via
 * the thrown error's hint, to an agent that hit the refusal.
 */
export async function confirmAction(summary: string, options: SafetyOptions): Promise<'confirmed'> {
  if (options.dryRun) return 'confirmed';
  if (options.yes || options.assumeYes) return 'confirmed';

  if (!isInteractive()) {
    throw new ConfirmationRequiredError(
      `Refusing to apply a league change without confirmation: ${summary}`,
      'Re-run with --yes to apply, or --dry-run to preview without changing anything.',
    );
  }

  process.stderr.write(`\nAbout to ${summary}\nProceed? [y/N] `);
  const answer = await readLine('');
  process.stderr.write('\n');

  if (!isAffirmative(answer)) {
    throw new ConfirmationRequiredError(
      'Cancelled. No changes were made.',
      'Re-run with --yes to skip this prompt.',
    );
  }
  return 'confirmed';
}

/**
 * Reject a state change that is internally inconsistent, before any network call.
 *
 * Catching these locally turns a confusing Sleeper-side rejection into a precise
 * message, and avoids burning a mutation on a request that cannot succeed.
 */
export function assertNonEmpty(label: string, values: readonly unknown[]): void {
  if (values.length === 0) {
    throw new UsageError(`${label} must not be empty`, 'Pass at least one value.');
  }
}

/** Guard a non-negative integer roster id. */
export function assertRosterId(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`Invalid roster id: ${value}`, 'Roster ids are positive integers.');
  }
}
