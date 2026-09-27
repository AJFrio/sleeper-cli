/**
 * The kmap/vmap encoding used by Sleeper's write mutations.
 *
 * See docs/INTERNAL-API.md section 4. In short: several mutations refuse a
 * structured object and instead accept two positionally-zipped flat arrays. The
 * data itself is the familiar `{ player_id: roster_id }` map, so callers build a
 * plain object and let `toKmap` do the splitting.
 *
 * Getting this wrong is the most likely cause of a silently rejected mutation, so
 * it lives in one place with tests rather than being repeated at each call site.
 */

/** A player id mapped to the roster it is involved with. */
export type RosterMap = Record<string, number>;

/** A settings/metadata key mapped to a value. */
export type SettingMap = Record<string, number | string | boolean | null>;

/** The split form Sleeper expects. */
export interface Kmap {
  keys: string[];
  values: (number | string | boolean | null)[];
}

/**
 * Split a plain object into the `keys`/`values` pair Sleeper expects.
 *
 * An empty object yields empty arrays, but Sleeper rejects empty arrays on these
 * arguments, so `toGraphQLKmapArgs` omits them instead.
 */
export function toKmap(input: SettingMap): Kmap {
  const keys = Object.keys(input);
  return { keys, values: keys.map((k) => input[k] as number | string | boolean | null) };
}

/**
 * Build the `k_*`/`v_*` argument pairs for a mutation call.
 *
 * Empty maps are omitted entirely rather than sent as empty arrays, matching the
 * web client's `keys.length ? keys : undefined` guard.
 */
export function toGraphQLKmapArgs(input: {
  adds?: RosterMap;
  drops?: RosterMap;
  settings?: SettingMap;
  metadata?: SettingMap;
}): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  if (input.adds && Object.keys(input.adds).length > 0) {
    const { keys, values } = toKmap(input.adds);
    args.k_adds = keys;
    args.v_adds = values as number[];
  }
  if (input.drops && Object.keys(input.drops).length > 0) {
    const { keys, values } = toKmap(input.drops);
    args.k_drops = keys;
    args.v_drops = values as number[];
  }
  if (input.settings && Object.keys(input.settings).length > 0) {
    const { keys, values } = toKmap(input.settings);
    args.k_settings = keys;
    args.v_settings = values;
  }
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    const { keys, values } = toKmap(input.metadata);
    args.k_metadata = keys;
    args.v_metadata = values;
  }

  return args;
}

/**
 * Express a player list as an `{ id: roster_id }` map.
 *
 * This is the shape every call site wants to think in, and it keeps roster ids out
 * of the command layer.
 */
export function toRosterMap(playerIds: readonly string[], rosterId: number): RosterMap {
  const map: RosterMap = {};
  for (const id of playerIds) {
    map[id] = rosterId;
  }
  return map;
}

/** The inverse: pull the player ids back out of a roster map. */
export function rosterMapKeys(map: RosterMap): string[] {
  return Object.keys(map);
}
