/**
 * The confirmation gate, output formatting, and the player cache.
 *
 * The gate is the reason a tool like this is safe to hand to an agent, so it gets
 * the most attention here: a mutation must never proceed without either an explicit
 * `--yes` or an interactive confirmation, and must never proceed at all in
 * non-interactive mode.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerCache } from '../src/cache/players.js';
import { ConfirmationRequiredError, EXIT } from '../src/core/errors.js';
import {
  formatAge,
  formatBytes,
  jsonFailure,
  jsonSuccess,
  ordinal,
  renderRecord,
  renderTable,
  resolveFormat,
} from '../src/output/format.js';
import { confirmAction, isInteractive } from '../src/output/safety.js';

const SILENT = { yes: false, dryRun: false, assumeYes: false };

describe('confirmAction', () => {
  let tty: boolean | undefined;

  beforeEach(() => {
    tty = process.stdin.isTTY;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
  });

  function setTty(value: boolean | undefined): void {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
  }

  it('proceeds with --yes without prompting', async () => {
    setTty(false);
    await expect(confirmAction('do a thing', { ...SILENT, yes: true })).resolves.toBe('confirmed');
  });

  it('proceeds with --assume-yes without prompting', async () => {
    setTty(false);
    await expect(confirmAction('do a thing', { ...SILENT, assumeYes: true })).resolves.toBe(
      'confirmed',
    );
  });

  it('proceeds under --dry-run without prompting', async () => {
    setTty(false);
    await expect(confirmAction('do a thing', { ...SILENT, dryRun: true })).resolves.toBe(
      'confirmed',
    );
  });

  it('refuses in non-interactive mode, with the needs-confirmation exit code', async () => {
    setTty(false);
    const error = await confirmAction('drop three players', SILENT).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    expect((error as ConfirmationRequiredError).exitCode).toBe(EXIT.NEEDS_CONFIRMATION);
    // The message must name what would have happened, so an agent can decide.
    expect((error as ConfirmationRequiredError).message).toContain('drop three players');
    expect((error as ConfirmationRequiredError).hint).toContain('--yes');
  });

  it('reports interactivity accurately', () => {
    setTty(true);
    expect(isInteractive()).toBe(true);
    setTty(false);
    expect(isInteractive()).toBe(false);
  });
});

describe('renderTable', () => {
  interface Row {
    name: string;
    n: number;
    note: string | null;
  }

  const rows: Row[] = [
    { name: 'Alice', n: 3, note: 'x' },
    { name: 'Bob', n: 12, note: null },
  ];

  const table = (): string =>
    renderTable({
      columns: [
        { header: 'name', value: (r: Row) => r.name },
        { header: 'n', value: (r: Row) => r.n, align: 'right' },
        { header: 'note', value: (r: Row) => r.note },
      ],
      rows,
    });

  it('upper-cases headers and draws a rule', () => {
    const out = table();
    expect(out.split('\n')[0]).toContain('NAME');
    expect(out.split('\n')[1]).toMatch(/─/);
  });

  it('renders null as an em dash rather than "null"', () => {
    expect(table()).toContain('—');
    expect(table()).not.toContain('null');
  });

  it('right-aligns numeric columns', () => {
    // Identical name lengths keep the numeric column at the same offset in both rows,
    // so the digits' end position is a valid check of alignment.
    const out = renderTable({
      columns: [
        { header: 'name', value: (r: Row) => r.name },
        { header: 'n', value: (r: Row) => r.n, align: 'right' },
      ],
      rows: [
        { name: 'A', n: 3, note: null },
        { name: 'B', n: 12, note: null },
      ],
    });
    const lines = out.split('\n');
    // The column is two wide, so "12" fills it and " 3" is padded on the left.
    expect(lines[3]).toMatch(/B\s+12$/);
    expect(lines[2]).toMatch(/A\s+3$/);
  });

  it('shows the empty message when there are no rows', () => {
    expect(
      renderTable({
        columns: [{ header: 'a', value: () => 'x' }],
        rows: [],
        emptyMessage: 'nothing here',
      }),
    ).toBe('nothing here');
  });

  it('truncates to the column width with an ellipsis', () => {
    const out = renderTable({
      columns: [{ header: 'long', value: (r: Row) => r.name, maxWidth: 3 }],
      rows: [{ name: 'Alexander', n: 0, note: null }],
    });
    // maxWidth 3 leaves room for two characters plus the ellipsis.
    expect(out).toContain('Al…');
    expect(out).not.toContain('Alexander');
  });
});

describe('renderRecord', () => {
  it('aligns keys and renders values', () => {
    const out = renderRecord({ a: 1, longer_key: 'x', empty: null });
    expect(out).toContain('a');
    expect(out).toContain('longer_key');
    expect(out).toContain('—');
  });
});

describe('json envelopes', () => {
  it('emits a single compact line with ok true', () => {
    const line = jsonSuccess('sleeper test', { n: 1 });
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ ok: true, command: 'sleeper test', data: { n: 1 } });
  });

  it('emits a failure with the exit code and omits absent fields', () => {
    const parsed = JSON.parse(
      jsonFailure('sleeper test', {
        code: 'rejected',
        message: 'nope',
        exitCode: EXIT.REJECTED,
      }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.error.exit_code).toBe(5);
    expect(parsed.error).not.toHaveProperty('hint');
  });

  it('prefers an explicit flag over the configured default', () => {
    expect(resolveFormat('json', 'table')).toBe('json');
    expect(resolveFormat(undefined, 'json')).toBe('json');
    expect(resolveFormat(undefined, 'table')).toBe('table');
  });
});

describe('format helpers', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('formats relative ages', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(5 * 60_000)).toBe('5m ago');
    expect(formatAge(3 * 3_600_000)).toBe('3h ago');
    expect(formatAge(undefined)).toBe('—');
  });

  it('formats ordinals, including the teens', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(21)).toBe('21st');
  });
});

describe('PlayerCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sleeper-cache-test-'));
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const player = { player_id: '1', first_name: 'A', last_name: 'B' };

  it('returns undefined when absent', () => {
    const cache = new PlayerCache({ filePath: join(dir, 'players.json') });
    expect(cache.read()).toBeUndefined();
    expect(cache.has()).toBe(false);
  });

  it('round-trips a written map', () => {
    const path = join(dir, 'players.json');
    const cache = new PlayerCache({ filePath: path });
    cache.write({ 1: player });

    const reloaded = new PlayerCache({ filePath: path });
    expect(reloaded.read()?.['1']).toEqual(player);
    expect(reloaded.has()).toBe(true);
  });

  it('expires an entry past the TTL', () => {
    const path = join(dir, 'players.json');
    const cache = new PlayerCache({ filePath: path, ttlHours: 1 });
    cache.write({ 1: player });

    const later = new PlayerCache({
      filePath: path,
      ttlHours: 1,
      now: () => Date.now() + 2 * 3_600_000,
    });
    expect(later.read()).toBeUndefined();
  });

  it('keeps an entry inside the TTL', () => {
    const path = join(dir, 'players.json');
    new PlayerCache({ filePath: path, ttlHours: 20 }).write({ 1: player });

    const later = new PlayerCache({
      filePath: path,
      ttlHours: 20,
      now: () => Date.now() + 19 * 3_600_000,
    });
    expect(later.read()).toBeDefined();
  });

  it('ignores a cache written for a different sport', () => {
    const path = join(dir, 'players.json');
    new PlayerCache({ filePath: path }).write({ 1: player }, 'nba');

    expect(new PlayerCache({ filePath: path }).read('nfl')).toBeUndefined();
  });

  it('treats a corrupt cache as a miss rather than throwing', () => {
    const path = join(dir, 'players.json');
    new PlayerCache({ filePath: path }).write({ 1: player });
    writeFileSync(path, '{ truncated');

    expect(new PlayerCache({ filePath: path }).read()).toBeUndefined();
  });

  it('clears the file and the memo', () => {
    const path = join(dir, 'players.json');
    const cache = new PlayerCache({ filePath: path });
    cache.write({ 1: player });
    cache.clear();

    expect(cache.has()).toBe(false);
    expect(cache.read()).toBeUndefined();
  });
});
