/**
 * Output rendering.
 *
 * Two modes, and the split matters for the stated audience:
 *
 *  - `table` is for humans reading a terminal. It truncates aggressively and never
 *    emits anything a script would have to strip.
 *  - `json` is for agents. It is always a single object with an `ok` field, and it is
 *    emitted on stdout only, so a caller can parse it without filtering stderr.
 *
 * Every command supports both, and `--json` wins over the config default. The
 * `ok` discriminator plus a stable error `code` is what lets an agent branch on the
 * result without string-matching prose.
 */

import type { ExitCode } from '../core/errors.js';

export type OutputFormat = 'table' | 'json';

export interface Column<T> {
  header: string;
  /** Cell content. A number or string is coerced; null renders as the em dash. */
  value: (row: T) => string | number | null | undefined;
  /** Right-align numeric columns. */
  align?: 'left' | 'right';
  /** Hard cap on rendered width. Content is truncated with an ellipsis. */
  maxWidth?: number;
}

export interface TableOptions<T> {
  columns: Column<T>[];
  rows: T[];
  /** Shown when `rows` is empty. */
  emptyMessage?: string;
  /** Indent every line, for embedding a table inside a larger report. */
  indent?: number;
}

const EM_DASH = '—';
const ELLIPSIS = '…';

/** Visible width, ignoring ANSI escapes. */
function visibleLength(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI requires matching ESC
  return text.replace(/\[[0-9;]*m/g, '').length;
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  const fill = Math.max(0, width - visibleLength(text));
  return align === 'right' ? ' '.repeat(fill) + text : text + ' '.repeat(fill);
}

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0 || visibleLength(text) <= maxWidth) return text;
  if (maxWidth === 1) return ELLIPSIS;
  return `${text.slice(0, maxWidth - 1).trimEnd()}${ELLIPSIS}`;
}

function cell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH;
  const text = String(value);
  return text.length === 0 ? EM_DASH : text;
}

/**
 * A table whose columns are not tied to one row type.
 *
 * TypeScript cannot express "a list of columns, each valid for the row type it was
 * written against" without generics, so the emitter needs a way to accept a fully
 * concrete table from a caller that built it with its own row type. This overload is
 * that seam, and the cast inside it is the single place the loss of that link is
 * acknowledged.
 */
export interface UntypedTableOptions {
  columns: readonly Column<never>[];
  rows: readonly unknown[];
  emptyMessage?: string;
  indent?: number;
}

/** Render an aligned text table. */
export function renderTable(options: UntypedTableOptions): string;
export function renderTable<T>(options: TableOptions<T>): string;
export function renderTable(options: UntypedTableOptions | TableOptions<never>): string {
  const { columns, rows, emptyMessage = 'No rows.', indent = 0 } = options as UntypedTableOptions;
  const pad_ = ' '.repeat(indent);

  if (rows.length === 0) {
    return `${pad_}${emptyMessage}`;
  }

  const body = rows.map((row) =>
    columns.map((col) => {
      const raw = cell((col.value as (row: unknown) => string | number | null | undefined)(row));
      return truncate(raw, col.maxWidth ?? 60);
    }),
  );

  const widths = columns.map((col, i) => {
    const headerWidth = visibleLength(col.header);
    const contentWidth = body.reduce(
      (max, cells) => Math.max(max, visibleLength(cells[i] ?? '')),
      0,
    );
    return Math.max(headerWidth, contentWidth);
  });

  const header = columns
    .map((col, i) => pad(col.header.toUpperCase(), widths[i] ?? 0, col.align ?? 'left'))
    .join('  ')
    .trimEnd();

  const divider = widths.map((w) => '─'.repeat(w)).join('  ');

  const lines = body.map((cells) =>
    cells
      .map((text, i) => pad(text ?? '', widths[i] ?? 0, columns[i]?.align ?? 'left'))
      .join('  ')
      .trimEnd(),
  );

  return [header, divider, ...lines].map((line) => `${pad_}${line}`).join('\n');
}

/** A labelled key/value block, used for single-record output. */
export function renderRecord(
  record: Record<string, string | number | boolean | null | undefined>,
  options: { indent?: number } = {},
): string {
  const pad_ = ' '.repeat(options.indent ?? 0);
  const entries = Object.entries(record);
  if (entries.length === 0) return `${pad_}(empty)`;

  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  return entries
    .map(([key, value]) => `${pad_}${pad(key, width, 'left')}  ${cell(value)}`)
    .join('\n');
}

/** A simple section heading. */
export function heading(text: string): string {
  return `\n${text}\n${'─'.repeat(text.length)}`;
}

/** The envelope written to stdout in `--json` mode. */
export interface JsonSuccess<T> {
  ok: true;
  command: string;
  data: T;
}

export interface JsonFailure {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    exit_code: ExitCode;
    hint?: string;
    details?: unknown;
  };
}

export type JsonEnvelope<T> = JsonSuccess<T> | JsonFailure;

/**
 * Render a success envelope.
 *
 * Always a single line. A pretty-printed envelope is friendlier to read but breaks
 * `| jq -c` consumers, and a stable compact form is worth more here.
 */
export function jsonSuccess<T>(command: string, data: T): string {
  return JSON.stringify({ ok: true, command, data } satisfies JsonSuccess<T>);
}

/** Render a failure envelope. */
export function jsonFailure(
  command: string,
  error: { code: string; message: string; exitCode: ExitCode; hint?: string; details?: unknown },
): string {
  const envelope: JsonFailure = {
    ok: false,
    command,
    error: {
      code: error.code,
      message: error.message,
      exit_code: error.exitCode,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  return JSON.stringify(envelope);
}

/**
 * Resolve the effective output format.
 *
 * An explicit flag beats the config default, so an agent can force JSON for one
 * call without changing stored state.
 */
export function resolveFormat(
  flag: OutputFormat | undefined,
  configured: OutputFormat,
): OutputFormat {
  return flag ?? configured;
}

/** Format a byte count for display. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return EM_DASH;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a relative age, e.g. "3h ago". */
export function formatAge(ms: number | undefined): string {
  if (ms === undefined) return EM_DASH;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Format a Sleeper epoch-milliseconds timestamp as an ISO date. */
export function formatTimestamp(epochMs: number | null | undefined): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) return EM_DASH;
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 16);
}

/** Ordinal suffix, for "1st", "2nd", "3rd". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
