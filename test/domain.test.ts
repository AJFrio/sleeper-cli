/**
 * Domain-layer guards.
 *
 * These cover the pre-flight checks that exist to turn a confusing Sleeper-side
 * rejection into a precise local message. A mutation that gets past these and still
 * fails is a Sleeper-side problem; one that fails here named the actual mistake.
 */

import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/core/errors.js';
import type { MatchupLeg, Roster, Transaction } from '../src/core/types.js';
import {
  addDropForRoster,
  buildAddDropOperation,
  describeTransaction,
} from '../src/domain/adddrop.js';
import {
  buildSetLineupOperation,
  expectedStarterCount,
  validateLineup,
} from '../src/domain/lineup.js';
import { buildStandings, pairMatchups } from '../src/domain/matchups.js';
import { parseStatField, sumStat } from '../src/domain/stats.js';
import { buildProposeTradeOperation } from '../src/domain/trades.js';
import { involvingRoster, pendingForRoster, viewForRoster } from '../src/domain/transactions.js';
import {
  buildSubmitWaiverOperation,
  buildWaiverSettings,
  suggestedBid,
} from '../src/domain/waivers.js';

describe('buildAddDropOperation', () => {
  it('sends a single add as parallel arrays', () => {
    const { variables } = buildAddDropOperation({
      leagueId: 'L1',
      type: 'free_agent',
      adds: { 486: 1 },
      drops: {},
    });
    expect(variables.k_adds).toEqual(['486']);
    expect(variables.v_adds).toEqual([1]);
    expect(variables).not.toHaveProperty('k_drops');
  });

  it('rejects a transaction that changes nothing', () => {
    expect(() =>
      buildAddDropOperation({ leagueId: 'L1', type: 'free_agent', adds: {}, drops: {} }),
    ).toThrow(UsageError);
  });

  it('rejects a player appearing in both adds and drops', () => {
    expect(() =>
      buildAddDropOperation({
        leagueId: 'L1',
        type: 'free_agent',
        adds: { 486: 1 },
        drops: { 486: 1 },
      }),
    ).toThrow(/both/);
  });

  it('defaults the type to free_agent', () => {
    expect(addDropForRoster({ leagueId: 'L1', rosterId: 1, add: ['1'] }).type).toBe('free_agent');
  });
});

describe('buildSetLineupOperation', () => {
  it('passes starters through positionally', () => {
    const { variables } = buildSetLineupOperation({
      leagueId: 'L1',
      rosterId: 2,
      starters: ['1', '2'],
    });
    expect(variables.starters).toEqual(['1', '2']);
  });

  it('refuses an empty lineup, pointing at bench-all in the hint', () => {
    const error = (() => {
      try {
        buildSetLineupOperation({ leagueId: 'L1', rosterId: 2, starters: [] });
        return undefined;
      } catch (err) {
        return err as UsageError;
      }
    })();
    expect(error?.message).toMatch(/empty lineup/);
    expect(error?.hint).toMatch(/bench-all/);
  });
});

describe('validateLineup', () => {
  const roster: Roster = {
    roster_id: 1,
    owner_id: 'u1',
    players: ['1', '2', '3'],
    starters: ['1', '2'],
  };

  it('accepts a valid lineup of the right size', () => {
    expect(validateLineup(roster, ['1', '2'], 2)).toEqual({ ok: true });
  });

  it('rejects a player the roster does not own', () => {
    const result = validateLineup(roster, ['1', '9'], 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatch(/not on this roster/);
  });

  it('rejects duplicates', () => {
    const result = validateLineup(roster, ['1', '1'], undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join()).toMatch(/duplicated/);
  });

  it('rejects the wrong number of starters', () => {
    const result = validateLineup(roster, ['1'], 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join()).toMatch(/expected 2 starters/);
  });

  it('collects every problem at once rather than only the first', () => {
    const result = validateLineup(roster, ['9', '9'], 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.length).toBeGreaterThan(1);
  });

  it('derives the expected slot count from the current starters', () => {
    expect(expectedStarterCount(roster)).toBe(2);
    expect(expectedStarterCount({ ...roster, starters: [] })).toBeUndefined();
  });
});

describe('buildProposeTradeOperation', () => {
  it('encodes received players against the counterparty and sent against you', () => {
    const { variables } = buildProposeTradeOperation({
      leagueId: 'L1',
      // The kmap value is each player's current owner: the counterparty for what you
      // receive, you for what you send.
      adds: { 1309: 2 },
      drops: { 486: 1 },
    });
    expect(variables.k_adds).toEqual(['1309']);
    expect(variables.v_adds).toEqual([2]);
    expect(variables.k_drops).toEqual(['486']);
    expect(variables.v_drops).toEqual([1]);
  });

  it('rejects an empty proposal', () => {
    expect(() => buildProposeTradeOperation({ leagueId: 'L1', adds: {}, drops: {} })).toThrow(
      UsageError,
    );
  });

  it('rejects a one-sided give-away', () => {
    expect(() =>
      buildProposeTradeOperation({ leagueId: 'L1', adds: {}, drops: { 486: 1 } }),
    ).toThrow(/receives nothing/);
  });

  it('accepts a pick-only trade when the season is resolvable', () => {
    expect(() =>
      buildProposeTradeOperation({
        leagueId: 'L1',
        adds: {},
        drops: {},
        picks: [{ rosterId: 2, round: 1 }],
        defaultSeason: 2026,
      }),
    ).not.toThrow();
  });

  it('rejects a pick-only trade whose season cannot be resolved', () => {
    // The wire format has no slot for an absent season, so a malformed record that
    // Sleeper would reject opaquely is worse than a local error.
    expect(() =>
      buildProposeTradeOperation({
        leagueId: 'L1',
        adds: {},
        drops: {},
        picks: [{ rosterId: 2, round: 1 }],
      }),
    ).toThrow(/season/);
  });

  it('omits draft_picks and waiver_budget when absent rather than sending empties', () => {
    const { variables } = buildProposeTradeOperation({
      leagueId: 'L1',
      adds: { 1: 2 },
      drops: { 2: 1 },
    });
    expect(variables).not.toHaveProperty('draftPicks');
    expect(variables).not.toHaveProperty('waiverBudget');
  });
});

describe('buildSubmitWaiverOperation', () => {
  it('requires at least one player', () => {
    expect(() => buildSubmitWaiverOperation({ leagueId: 'L1', adds: {}, drops: {} })).toThrow(
      /at least one player/,
    );
  });

  it('encodes the bid as a waiver_bid setting', () => {
    const { variables } = buildSubmitWaiverOperation({
      leagueId: 'L1',
      adds: { 1309: 1 },
      drops: {},
      bid: 5,
    });
    expect(variables.k_settings).toEqual(['waiver_bid']);
    expect(variables.v_settings).toEqual([5]);
  });

  it('omits the settings kmap when there is no bid', () => {
    const { variables } = buildSubmitWaiverOperation({ leagueId: 'L1', adds: { 1: 1 }, drops: {} });
    expect(variables).not.toHaveProperty('k_settings');
  });

  it('rejects a negative bid', () => {
    expect(() =>
      buildSubmitWaiverOperation({ leagueId: 'L1', adds: { 1: 1 }, drops: {}, bid: -1 }),
    ).toThrow(/Invalid waiver bid/);
  });

  it('builds a settings map with only the bid', () => {
    expect(buildWaiverSettings({ bid: 3 })).toEqual({ waiver_bid: 3 });
    expect(buildWaiverSettings({})).toEqual({});
  });

  it('suggests one above the standing priority', () => {
    expect(suggestedBid(7)).toBe(8);
    expect(suggestedBid(undefined)).toBeUndefined();
  });
});

describe('viewForRoster', () => {
  const tx: Transaction = {
    transaction_id: 't1',
    type: 'trade',
    status: 'proposed',
    leg: 3,
    roster_ids: [1, 2],
    created: 0,
    // Player 1309 arrives on roster 1; 486 leaves it.
    adds: { 1309: 1, 486: 2 },
    drops: { 1309: 2, 486: 1 },
    draft_picks: [{ round: 1, previous_owner_id: 1, owner_id: 2 }],
    waiver_budget: [{ sender: 1, receiver: 2, amount: 4 }],
  };

  it("splits a trade from one roster's perspective", () => {
    const view = viewForRoster(tx, 1);
    expect(view.received).toEqual(['1309']);
    expect(view.sent).toEqual(['486']);
    expect(view.picksOut).toEqual([1]);
    expect(view.picksIn).toEqual([]);
    expect(view.faabOut).toBe(4);
    expect(view.faabIn).toBe(0);
  });

  it('mirrors the view for the counterparty', () => {
    const view = viewForRoster(tx, 2);
    expect(view.received).toEqual(['486']);
    expect(view.sent).toEqual(['1309']);
    expect(view.picksIn).toEqual([1]);
  });

  it('tolerates absent maps and picks', () => {
    const view = viewForRoster(
      { ...tx, adds: null, drops: null, draft_picks: null, waiver_budget: null },
      1,
    );
    expect(view).toEqual({
      received: [],
      sent: [],
      picksOut: [],
      picksIn: [],
      faabIn: 0,
      faabOut: 0,
    });
  });
});

describe('transaction filters', () => {
  const txs: Transaction[] = [
    {
      transaction_id: 'a',
      type: 'trade',
      status: 'proposed',
      leg: 1,
      roster_ids: [1, 2],
      created: 1,
    },
    {
      transaction_id: 'b',
      type: 'trade',
      status: 'complete',
      leg: 1,
      roster_ids: [1, 3],
      created: 2,
    },
    {
      transaction_id: 'c',
      type: 'trade',
      status: 'rejected',
      leg: 1,
      roster_ids: [2, 3],
      created: 3,
    },
  ];

  it("keeps only the roster's transactions", () => {
    expect(involvingRoster(txs, 2).map((t) => t.transaction_id)).toEqual(['a', 'c']);
  });

  it('treats proposed and pending as awaiting a response', () => {
    expect(pendingForRoster(txs, 2).map((t) => t.transaction_id)).toEqual(['a']);
  });
});

describe('pairMatchups', () => {
  const leg = (over: Partial<MatchupLeg>): MatchupLeg => ({
    league_id: 'L1',
    leg: 1,
    round: 1,
    matchup_id: 1,
    roster_id: 1,
    points: 0,
    starters: [],
    players: [],
    ...over,
  });

  it('pairs two sides of the same matchup', () => {
    const paired = pairMatchups(
      [leg({ roster_id: 1, points: 100 }), leg({ roster_id: 2, points: 90 })],
      new Map([
        [1, { display_name: 'Alice', team_name: null }],
        [2, { display_name: 'Bob', team_name: null }],
      ]),
    );
    const first = paired[0];
    expect(first?.opponent_roster_id).toBe(2);
    expect(first?.opponent_points).toBe(90);
    expect(first?.opponent_display_name).toBe('Bob');
  });

  it('gives a bye week a null opponent rather than dropping the row', () => {
    const paired = pairMatchups([leg({ roster_id: 1 })], new Map());
    expect(paired).toHaveLength(1);
    expect(paired[0]?.opponent_roster_id).toBeNull();
  });
});

describe('buildStandings', () => {
  it('prefers playoff seed, then win percentage, then points', () => {
    const rosters: Roster[] = [
      {
        roster_id: 1,
        owner_id: 'u1',
        players: [],
        starters: [],
        settings: { wins: 1, losses: 5, fpts: 900, playoff_seed: 2 },
      },
      {
        roster_id: 2,
        owner_id: 'u2',
        players: [],
        starters: [],
        settings: { wins: 5, losses: 1, fpts: 1500, playoff_seed: 1 },
      },
    ];
    const standings = buildStandings(rosters, new Map());
    expect(standings.map((s) => s.roster_id)).toEqual([2, 1]);
  });

  it('divides the decimal points fields, which are hundredths', () => {
    const standings = buildStandings(
      [
        {
          roster_id: 1,
          owner_id: 'u1',
          players: [],
          starters: [],
          settings: { fpts_decimal: 150055, fpts_against_decimal: 120000 },
        },
      ],
      new Map(),
    );
    expect(standings[0]?.points_for).toBeCloseTo(1500.55);
    expect(standings[0]?.points_against).toBeCloseTo(1200);
  });

  it('survives a roster with no settings at all', () => {
    const standings = buildStandings(
      [{ roster_id: 1, owner_id: null, players: [], starters: [] }],
      new Map(),
    );
    expect(standings[0]?.wins).toBe(0);
  });
});

describe('stat parsing', () => {
  it('parses a flat JSON object', () => {
    expect(parseStatField('{"pts":12.5,"rushing_yds":99}')).toEqual({ pts: 12.5, rushing_yds: 99 });
  });

  it('drops nested objects, keeping only numeric leaves', () => {
    // The return type carries numbers only. Sleeper returns a flat object for any
    // single named category, which is the shape this is used with.
    expect(parseStatField('{"pts":12.5,"rushing":{"yds":99}}')).toEqual({ pts: 12.5 });
  });

  it('parses a JSON array by taking the first entry', () => {
    expect(parseStatField('[{"pts":7}]')).toEqual({ pts: 7 });
  });

  it('treats a bare number as a total', () => {
    expect(parseStatField('9.5')).toEqual({ total: 9.5 });
  });

  it('returns an empty object rather than throwing on junk', () => {
    expect(parseStatField('not json at all')).toEqual({});
    expect(parseStatField(null)).toEqual({});
    expect(parseStatField('')).toEqual({});
  });

  it('sums a named key across lines', () => {
    expect(
      sumStat([
        { player_id: '1', stats: '{"pts":10}' },
        { player_id: '2', stats: '{"pts":5.5}' },
      ]),
    ).toBe(15.5);
  });
});

describe('describeTransaction', () => {
  it('summarises a trade', () => {
    const summary = describeTransaction({
      type: 'trade',
      status: 'complete',
      adds: { a: 1 },
      drops: { b: 1 },
      draft_picks: [{}],
      waiver_budget: [{ sender: 1, receiver: 2, amount: 3 }],
    });
    expect(summary).toEqual({ acquires: ['a'], relinquishes: ['b'], picks: 1, faab: 3 });
  });

  it('handles a plain add', () => {
    expect(
      describeTransaction({ type: 'add', status: 'complete', adds: { a: 1 }, drops: null }),
    ).toEqual({ acquires: ['a'], relinquishes: [], picks: 0, faab: 0 });
  });
});
