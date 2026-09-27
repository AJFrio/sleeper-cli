/**
 * The single place results leave the CLI.
 *
 * Routing every command's output through one object is what makes the JSON contract
 * trustworthy: there is exactly one code path that writes a success envelope, one
 * that writes a failure envelope, and one that renders a table. A command handler
 * supplies data and a table renderer and never touches stdout itself.
 *
 * The stdout/stderr split is deliberate. JSON goes to stdout and nothing else does,
 * so `sleeper ... --json | jq` works even when the command also prints warnings.
 */

import type { SleeperError } from '../core/errors.js';
import type { GlobalContext } from './context.js';
import {
  type Column,
  jsonFailure,
  jsonSuccess,
  renderTable,
  type UntypedTableOptions,
} from './format.js';

/**
 * What a table renderer may return: a pre-rendered string, a table spec, or a table
 * spec with a heading above it.
 *
 * The untitled form is a bare spec rather than `{ table: spec }` because a heading is
 * the exception, and making every call site wrap its table to satisfy the common case
 * would be noise.
 */
export type RenderedTable =
  | string
  | UntypedTableOptions
  | { table: UntypedTableOptions; title?: string };

/** Write to stdout without a trailing newline concern for machine consumers. */
function writeOut(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Write to stderr, keeping stdout clean for JSON consumers. */
function writeErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export interface EmitOptions<T> {
  /** Dotted path used as the `command` field of the JSON envelope. */
  command: string;
  /** Structured payload for `--json` mode. */
  data: T;
  /** Human rendering for table mode. */
  table: (data: T) => RenderedTable;
}

export class Emitter {
  readonly #context: GlobalContext;

  constructor(context: GlobalContext) {
    this.#context = context;
  }

  get json(): boolean {
    return this.#context.json;
  }

  get context(): GlobalContext {
    return this.#context;
  }

  /** Emit a successful result in whichever format is active. */
  emit<T>(options: EmitOptions<T>): void {
    if (this.#context.json) {
      writeOut(jsonSuccess(options.command, options.data));
      return;
    }

    const rendered = options.table(options.data);
    if (typeof rendered === 'string') {
      if (rendered.length > 0) writeOut(rendered);
      return;
    }

    if ('table' in rendered) {
      if (rendered.title) writeOut(`\n${rendered.title}`);
      writeOut(renderTable(rendered.table));
      return;
    }

    writeOut(renderTable(rendered));
  }

  /** Emit a table explicitly, ignoring the active format. Used by `--explain`. */
  emitRaw(text: string): void {
    writeOut(text);
  }

  /** Print a JSON payload verbatim, for `--explain` and debug output. */
  emitJsonPayload(payload: unknown): void {
    writeOut(JSON.stringify(payload, null, 2));
  }

  /** Note for the operator. Suppressed by `--quiet` and by JSON mode. */
  note(message: string): void {
    if (this.#context.quiet || this.#context.json) return;
    writeErr(message);
  }

  /** Warning. Always shown, on stderr, even in quiet or JSON mode. */
  warn(message: string): void {
    writeErr(`warning: ${message}`);
  }

  /** Informational line shown only in verbose human mode. */
  info(message: string): void {
    if (this.#context.json || this.#context.quiet) return;
    writeErr(message);
  }

  /** Report a failure and return the process exit code. */
  fail(command: string, error: SleeperError): number {
    if (this.#context.json) {
      writeOut(
        jsonFailure(command, {
          code: error.code,
          message: error.message,
          exitCode: error.exitCode,
          ...(error.hint ? { hint: error.hint } : {}),
          ...(error.details === undefined ? {} : { details: error.details }),
        }),
      );
    } else {
      writeErr(`error: ${error.message}`);
      if (error.hint) writeErr(`hint: ${error.hint}`);
      if (this.#context.debug && error.details !== undefined) {
        writeErr(`details: ${JSON.stringify(error.details, null, 2)}`);
      }
    }
    return error.exitCode;
  }
}

/** Convenience for declaring a table column without repeating the type parameter. */
export function column<T>(
  header: string,
  value: (row: T) => string | number | null | undefined,
  options: { align?: 'left' | 'right'; maxWidth?: number } = {},
): Column<T> {
  return { header, value, ...options };
}
