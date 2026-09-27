/**
 * kmap/vmap encoding.
 *
 * This is the most load-bearing piece of the whole client: getting it wrong
 * produces a mutation that fails opaquely at Sleeper rather than locally, so the
 * cases below are pinned to the exact wire shape the web client sends.
 */

import { describe, expect, it } from 'vitest';
import { rosterMapKeys, toGraphQLKmapArgs, toKmap, toRosterMap } from '../src/core/kmap.js';
import {
  buildProposeTradeOperation,
  decodeDraftPicks,
  encodeDraftPicks,
  encodeWaiverBudget,
} from '../src/domain/trades.js';

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

describe('draft pick encoding', () => {
  it('emits one comma-separated record per pick, not a JSON blob', () => {
    // `draft_picks` is [String], not String, per full wrapper introspection of the live
    // schema. A single JSON string here is silently wrong, which is how this started.
    expect(encodeDraftPicks([{ rosterId: 7, round: 1, season: 2026 }], undefined)).toEqual([
      '7,2026,1,7,7',
    ]);
  });

  it('carries the original owner separately from the current holder', () => {
    expect(
      encodeDraftPicks(
        [{ rosterId: 7, round: 1, season: 2026, originalOwnerRosterId: 3, toRosterId: 8 }],
        undefined,
      ),
    ).toEqual(['3,2026,1,7,8']);
  });

  it('emits one record per pick', () => {
    expect(
      encodeDraftPicks(
        [
          { rosterId: 1, round: 1, season: 2026 },
          { rosterId: 2, round: 2, season: 2026 },
        ],
        undefined,
      ),
    ).toEqual(['1,2026,1,1,1', '2,2026,2,2,2']);
  });

  it('inherits the league season when a pick omits one', () => {
    expect(encodeDraftPicks([{ rosterId: 4, round: 3 }], 2027)).toEqual(['4,2027,3,4,4']);
  });

  it('refuses a pick with no resolvable season', () => {
    expect(() => encodeDraftPicks([{ rosterId: 4, round: 3 }], undefined)).toThrow(/season/);
  });

  it('round-trips through decode', () => {
    const encoded = encodeDraftPicks(
      [{ rosterId: 7, round: 1, season: 2026, originalOwnerRosterId: 3, toRosterId: 8 }],
      undefined,
    );
    expect(decodeDraftPicks(encoded)).toEqual([
      { originalOwnerRosterId: 3, season: 2026, round: 1, fromRosterId: 7, toRosterId: 8 },
    ]);
  });

  it('skips malformed records when decoding', () => {
    expect(decodeDraftPicks(['1,2,3', 'a,b,c,d,e', '1,2,3,4,5'])).toEqual([
      { originalOwnerRosterId: 1, season: 2, round: 3, fromRosterId: 4, toRosterId: 5 },
    ]);
  });
});

describe('waiver budget encoding', () => {
  it('emits a dash-separated triple', () => {
    expect(encodeWaiverBudget({ fromRosterId: 1, toRosterId: 2, amount: 5 })).toEqual(['1-2-5']);
  });

  it('is absent when there is no FAAB', () => {
    expect(encodeWaiverBudget(undefined)).toBeUndefined();
  });
});

describe('propose_trade operation', () => {
  it('types draftPicks and waiverBudget as lists in the document', () => {
    const { document, variables } = buildProposeTradeOperation({
      leagueId: 'L1',
      adds: { 1309: 2 },
      drops: { 486: 1 },
      picks: [{ rosterId: 2, round: 1, season: 2026 }],
      faab: { fromRosterId: 1, toRosterId: 2, amount: 3 },
    });

    expect(document).toContain('$draftPicks: [String]');
    expect(document).toContain('$waiverBudget: [String]');
    expect(Array.isArray(variables.draftPicks)).toBe(true);
    expect(Array.isArray(variables.waiverBudget)).toBe(true);
    expect(variables.draftPicks).toEqual(['2,2026,1,2,2']);
    expect(variables.waiverBudget).toEqual(['1-2-3']);
  });
});
