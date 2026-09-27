/**
 * kmap/vmap encoding.
 *
 * This is the most load-bearing piece of the whole client: getting it wrong
 * produces a mutation that fails opaquely at Sleeper rather than locally, so the
 * cases below are pinned to the exact wire shape the web client sends.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDraftPickPayload,
  parseDraftPicks,
  rosterMapKeys,
  toGraphQLKmapArgs,
  toKmap,
  toRosterMap,
} from '../src/core/kmap.js';

describe('toKmap', () => {
  it('splits keys and values positionally', () => {
    expect(toKmap({ a: 1, b: 2 })).toEqual({ keys: ['a', 'b'], values: [1, 2] });
  });

  it('returns empty arrays for an empty object', () => {
    expect(toKmap({})).toEqual({ keys: [], values: [] });
  });

  it('preserves value types', () => {
    const { values } = toKmap({ bid: 5, note: 'injury', keeper: true, none: null });
    expect(values).toEqual([5, 'injury', true, null]);
  });
});

describe('toGraphQLKmapArgs', () => {
  it('emits parallel k_/v_ arrays', () => {
    expect(toGraphQLKmapArgs({ adds: { 486: 3 } })).toEqual({
      k_adds: ['486'],
      v_adds: [3],
    });
  });

  it('handles a swap as one argument set', () => {
    expect(toGraphQLKmapArgs({ adds: { 1309: 1 }, drops: { 486: 3 } })).toEqual({
      k_adds: ['1309'],
      v_adds: [1],
      k_drops: ['486'],
      v_drops: [3],
    });
  });

  it('zips multiple players in order', () => {
    const args = toGraphQLKmapArgs({ adds: { '956': 2, '8577': 2 } });
    expect(args.k_adds).toEqual(['956', '8577']);
    expect(args.v_adds).toEqual([2, 2]);
  });

  it('omits empty maps entirely, matching the web client guard', () => {
    // Sleeper rejects empty arrays on these arguments, so they must be absent rather
    // than sent as [].
    expect(toGraphQLKmapArgs({ adds: {}, drops: {} })).toEqual({});
  });

  it('omits an absent map but keeps a populated sibling', () => {
    expect(toGraphQLKmapArgs({ adds: { 1: 1 }, drops: {} })).toEqual({
      k_adds: ['1'],
      v_adds: [1],
    });
  });

  it('encodes waiver settings and metadata', () => {
    expect(
      toGraphQLKmapArgs({ settings: { waiver_bid: 7 }, metadata: { note: 'bye week' } }),
    ).toEqual({
      k_settings: ['waiver_bid'],
      v_settings: [7],
      k_metadata: ['note'],
      v_metadata: ['bye week'],
    });
  });
});

describe('toRosterMap', () => {
  it('maps every player to one roster', () => {
    expect(toRosterMap(['486', '1309'], 3)).toEqual({ 486: 3, 1309: 3 });
  });

  it('returns an empty map for no players', () => {
    expect(toRosterMap([], 1)).toEqual({});
  });
});

describe('rosterMapKeys', () => {
  it('round-trips a roster map', () => {
    const map = toRosterMap(['486', '1309'], 3);
    expect(rosterMapKeys(map).sort()).toEqual(['1309', '486']);
  });
});

describe('draft pick payloads', () => {
  it('encodes pairs', () => {
    expect(buildDraftPickPayload([{ rosterId: 2, round: 1 }])).toBe('[[2,1]]');
  });

  it('parses pairs back', () => {
    expect(parseDraftPicks('[[2,1],[3,4]]')).toEqual([
      { rosterId: 2, round: 1 },
      { rosterId: 3, round: 4 },
    ]);
  });

  it('returns an empty list for malformed input rather than throwing', () => {
    expect(parseDraftPicks('not json')).toEqual([]);
    expect(parseDraftPicks('{"a":1}')).toEqual([]);
    expect(parseDraftPicks('')).toEqual([]);
    expect(parseDraftPicks(null)).toEqual([]);
  });

  it('skips entries of the wrong shape', () => {
    expect(parseDraftPicks('[["a",1],[2]]')).toEqual([]);
  });
});
