/**
 * Types for Sleeper's public read-only REST API.
 *
 * These shapes are looser than the GraphQL equivalents on purpose: the REST API
 * omits fields depending on league settings, and many are `null` rather than
 * absent. Everything optional here reflects an observed omission, not laziness.
 */

/** A manager in a league. */
export interface SleeperUser {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar: string | null;
  metadata: { team_name?: string | null; [key: string]: unknown } | null;
  is_owner?: boolean;
}

/** A league, as returned by both the REST and GraphQL layers. */
export interface League {
  league_id: string;
  name: string;
  avatar: string | null;
  total_rosters?: number;
  status?: 'pre_draft' | 'drafting' | 'in_season' | 'complete';
  sport?: string;
  season?: string;
  season_type?: string;
  previous_league_id?: string | null;
  draft_id?: string | null;
  roster_positions?: string[];
  settings?: Record<string, unknown>;
  scoring_settings?: Record<string, unknown>;
  /** Present on GraphQL responses only. */
  current_week?: number | null;
  leg?: number | null;
  member_count?: number | null;
}

/** Per-roster standings and settings. */
export interface RosterSettings {
  wins?: number;
  losses?: number;
  ties?: number;
  division?: number;
  fpts?: number;
  fpts_decimal?: number;
  fpts_against?: number;
  fpts_against_decimal?: number;
  waiver_position?: number;
  waiver_budget_used?: number;
  total_moves?: number;
  playoff_seed?: number;
  has_playoff_odds?: boolean;
  [key: string]: unknown;
}

/** A roster: the players a manager owns and how they are deployed. */
export interface Roster {
  roster_id: number;
  league_id?: string;
  owner_id: string | null;
  players: string[];
  starters: string[];
  reserve?: string[];
  taxi?: string[];
  co_owners?: string[] | null;
  metadata?: Record<string, unknown> | null;
  settings?: RosterSettings | null;
  /** Convenience fields the CLI attaches after joining users to rosters. */
  display_name?: string;
  team_name?: string;
}

/** One side of a matchup. */
export interface MatchupLeg {
  league_id: string;
  leg: number;
  round: number;
  matchup_id: number;
  roster_id: number;
  points: number | null;
  proj_points?: number | null;
  max_points?: number | null;
  custom_points?: number | null;
  starters: string[];
  players: string[];
  subs?: string[];
}

/** A player in Sleeper's index. Sparse by design. */
export interface Player {
  player_id: string;
  first_name: string | null;
  last_name: string | null;
  full_name?: string;
  position?: string | null;
  fantasy_positions?: string[] | null;
  team?: string | null;
  status?: string | null;
  injury_status?: string | null;
  age?: number | null;
  college?: string | null;
  height?: string | null;
  weight?: string | null;
  years_exp?: number | null;
  headshot_url?: string | null;
  sport?: string;
}

/** A single line of a transaction. */
export interface Transaction {
  transaction_id: string;
  type: 'add' | 'drop' | 'trade' | 'free_agent' | 'waiver' | 'draft';
  /** `proposed` is what GraphQL reports for a trade awaiting a response. */
  status:
    | 'pending'
    | 'proposed'
    | 'accepted'
    | 'declined'
    | 'complete'
    | 'error'
    | 'cancelled'
    | 'rejected'
    | 'vetoed';
  leg: number | null;
  roster_ids: number[];
  created: number;
  status_updated?: number;
  creator?: string | null;
  consenter_ids?: number[];
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
  draft_picks?: unknown[] | null;
  waiver_budget?: { sender: number; receiver: number; amount: number }[] | null;
  metadata?: Record<string, unknown> | null;
  settings?: Record<string, unknown> | null;
  type_details?: Record<string, unknown> | null;
}

/** A draft, including dynasty history where applicable. */
export interface Draft {
  draft_id: string;
  league_id: string;
  type: string | null;
  status: string | null;
  start_time: number | null;
  season: string;
  season_type: string;
  sport: string;
  settings: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  draft_order?: Record<string, number> | null;
  slot_to_roster_id?: Record<string, number> | null;
  previous_draft_id?: string | null;
}

/** One selection on a draft board. */
export interface DraftPick {
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number | null;
  picked_by: string | null;
  player_id: string | null;
  draft_id: string;
  metadata?: Record<string, unknown> | null;
  is_keeper?: boolean | null;
}

/** Current week and season, used to resolve "this week" defaults. */
export interface NflState {
  week: number;
  display_week: number;
  leg: number;
  season: string;
  previous_season: string;
  season_type: string;
  season_start_date: string;
  league_season: string;
  season_has_scores: boolean;
}

/** Full-size avatar URL for an avatar id. */
export function avatarUrl(avatarId: string | null | undefined): string | null {
  return avatarId ? `https://sleepercdn.com/avatars/${avatarId}` : null;
}

/** Thumbnail avatar URL. */
export function avatarThumbUrl(avatarId: string | null | undefined): string | null {
  return avatarId ? `https://sleepercdn.com/avatars/thumbs/${avatarId}` : null;
}

/** Render a player's name, falling back through the fields Sleeper may omit. */
export function playerName(player: Player | undefined): string {
  if (!player) return 'Unknown';
  if (player.full_name) return player.full_name;
  const first = player.first_name ?? '';
  const last = player.last_name ?? '';
  const joined = `${first} ${last}`.trim();
  return joined || `Player ${player.player_id}`;
}
