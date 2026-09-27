# Sleeper internal API — verified findings

Everything on this page was verified **directly** against the live Sleeper backend on
2026-09-26, either by GraphQL introspection or by reading Sleeper's own shipped
JavaScript bundle. Nothing here is inferred from third-party docs.

## 1. Two APIs

| API | Base URL | Auth | Can write? |
| --- | --- | --- | --- |
| Public REST | `https://api.sleeper.app/v1/...` | none | **No** — read-only by design |
| Internal GraphQL | `https://api.sleeper.app/graphql` | `Authorization: <token>` | **Yes** |

The public REST API is officially read-only. Sleeper states plainly:
> "No API Token is necessary, as you **cannot modify** contents via this API."

Everything an agent needs to *do* (adds, drops, trades, waivers, lineups) exists only on
the GraphQL endpoint. That is the endpoint `sleeper.com` itself uses.

## 2. Introspection is enabled

Full schema introspection works, using **snake_case** introspection field names.
This is unusual and worth knowing — the common camelCase spellings fail:

```graphql
# works
{ __schema { query_type { name fields { name args { name } } } } }

# fails: "Cannot query field \"queryType\" on type \"__Schema\". Did you mean \"query_type\"?"
{ __schema { queryType { name } } }

# fails: "Cannot query field \"ofType\" on type \"__Type\". Did you mean \"of_type\"?"
{ __schema { query_type { fields { type { ofType { name } } } } } }
```

Totals as of 2026-09-26: **244 queries**, **355 mutations**, **154 types**.

Note that introspection is currently enabled. An independent schema dump published in
October 2025 states that introspection is disabled and that mutations must be recovered by
observing network traffic; that was true of the older dump but is no longer true of the
live endpoint, so a fresh introspection is worth more than a cached schema file.

## 3. Authentication

`login` is a **query**, not a mutation, and takes no auth:

```graphql
query login($email_or_phone_or_username: String!, $password: String!, $captcha: String) {
  login(email_or_phone_or_username: $email_or_phone_or_username, password: $password, captcha: $captcha) {
    token
  }
}
```

It returns a bare `{ token }`. That token is then sent on every authenticated call as a
**raw `Authorization` header — with no `Bearer ` prefix**:

```js
// verbatim from the shipped bundle
headers: {
  "Content-Type": "application/json",
  Accept: "application/json",
  ...this.headers,
  ...(opts.withAuth && this.token ? { Authorization: `${this.token}` } : {}),
  ...opts.requestInit?.headers,
},
body: JSON.stringify({ query, variables }),
```

Consequences, all of which this tool relies on:

- **No CSRF token and no anti-forgery hash.** There is no `x-sleeper-hash` header in the
  current web client. Older third-party guides describe one; that is stale.
- **No cookies required.** The GraphQL path is pure bearer auth, so `credentials: "include"`
  is irrelevant. A plain HTTPS client is fully sufficient.
- **No headless browser needed for API access.** A browser is only ever needed to solve an
  hCaptcha challenge, and only if one is presented.

Verify the session with `{ me { user_id username display_name } }`.

### Two-factor

The login response signals OTP through GraphQL `originalErrors` rather than a separate
field. The web client tests for the presence of any original error and switches the form to
an OTP prompt. The OTP is submitted through the same `login` operation.

### Captcha

`login` accepts an optional `captcha: String`. The web client uses hCaptcha. It is not
required for ordinary logins, so the CLI treats it as an escape hatch: when a login is
challenged, the CLI reports that a captcha is needed and the user can solve it in a real
browser and paste the resulting token. See `sleeper auth login --help`.

## 4. The kmap/vmap encoding

This is the single most important quirk, and it is undocumented.

Many mutations do not take a structured object. They take **parallel flat arrays**: a
`k_*` array of string keys and a matching `v_*` array of values, positionally zipped by the
server. Sleeper generates these with `Object.keys` / `Object.values`.

The underlying data is the familiar `{ player_id: roster_id }` map seen in the public REST
transaction payloads, so **build a plain object in your code and let the helper split it.**

From the bundle:

```js
createLeagueTransaction({ leagueId: e, type: t = "free_agent", adds: r = {}, drops: s = {} }, a) {
  return this.graphqlFetchClient.query(`
    mutation league_create_transaction(
      $leagueId: String!  $type: String!
      $k_adds: [String]  $v_adds: [Int]  $k_drops: [String]  $v_drops: [Int]
    ) {
      league_create_transaction(
        league_id: $leagueId, type: $type,
        k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops
      ) { transaction_id type status leg adds drops roster_ids }
    }`,
    {
      leagueId: e,
      type: t,
      k_adds: Object.keys(r), v_adds: Object.values(r),
      k_drops: Object.keys(s), v_drops: Object.values(s),
    },
    { schema: P, validate: true, withAuth: true, ...a });
}
```

So a single add of player `486` to roster `3` is sent as:

```json
{ "k_adds": ["486"], "v_adds": [3] }
```

A trade where you send `486` and receive `1309` is:

```json
{ "k_adds": ["1309"], "v_adds": [2], "k_drops": ["486"], "v_drops": [1] }
```

because the *value* is the **destination roster** for adds and the **source roster** for
drops. Both are relative to the authenticated user, which is why the same mutation can
express both halves of a trade with no extra parameters.

### Introspection flattens wrapper types — read them carefully

A naive introspection query that prints only the innermost type name reports `k_adds` as
`String` and `k_adds` as `String`. Both are wrong: the true types are `[String]` and
`[Int]`. The `NON_NULL` and `LIST` wrappers are only visible if you follow the chain:

```graphql
{ __schema { mutation_type { fields {
  name
  args { name type { kind name of_type { kind name of_type { kind name } } } }
} } } }
```

Rendering that chain with `NON_NULL -> !` and `LIST -> [...]` gives the real picture:

| Operation | Argument | True type |
| --- | --- | --- |
| `league_create_transaction` | `k_adds` / `v_adds` | `[String]` / `[Int]` |
| `propose_trade` | `k_adds` / `v_adds` | `[String]` / `[Int]` |
| `propose_trade` | **`draft_picks`** | **`[String]`** |
| `propose_trade` | **`waiver_budget`** | **`[String]`** |
| `submit_waiver_claim` | `k_settings` / `v_settings` | `[String]` / `[Int]` |
| `roster_update_starters` | `starters` | `[String]` |
| `roster_update_reserve` | `reserve` | `[String]` |
| `roster_update_taxi` | `taxi` | `[String]` |
| `update_matchup_leg` | `starters` | `[String]` |

`draft_picks` and `waiver_budget` being *lists* is not a detail: it means each entry is
its own string, not a JSON document. See section 5.

## 5. Write operations

| Goal | Operation | Arguments |
| --- | --- | --- |
| Add / drop player | `league_create_transaction` | `type`, `league_id`, kmap adds/drops. `type` is `free_agent` or `waiver` |
| Set weekly lineup | `roster_update_starters` | `league_id`, `roster_id`, `starters` |
| Submit waiver | `submit_waiver_claim` | `league_id`, kmap adds/drops + kmap `settings` |
| Edit waiver | `update_waiver_claim` | `leg`, `league_id`, `transaction_id`, kmap metadata/settings |
| Cancel waiver | `cancel_waiver_claim` | `leg`, `league_id`, `transaction_id` |
| Propose trade | `propose_trade` | `league_id`, `expires_at`, kmap adds/drops + `draft_picks` + `waiver_budget` |
| Set IR / reserve | `roster_update_reserve` | `league_id`, `roster_id`, `reserve` |
| Set taxi squad | `roster_update_taxi` | `league_id`, `roster_id`, `taxi`, `force` |
| Accept trade | `accept_trade` | `leg`, `league_id`, `transaction_id` |
| Reject trade | `reject_trade` | `leg`, `league_id`, `transaction_id` |
| Commissioner lineup | `update_matchup_leg` | `round`, `leg`, `league_id`, `roster_id`, `starters`, `subs` |
| Rescore week | `recalculate_matchup_scoring` | `round`, `league_id` |
| Draft a player | `draft_pick_player` | `sport`, `player_id`, `draft_id`, `pick_no` |

Verbatim lineup mutation:

```graphql
mutation roster_update_starters($leagueId: String! $rosterId: Int! $starters: [String]) {
  roster_update_starters(league_id: $leagueId, roster_id: $rosterId, starters: $starters) {
    roster_id league_id owner_id starters players reserve taxi co_owners metadata settings
  }
}
```

`starters` is a flat array of player ids in slot order. Sleeper works out which slot each
player lands in from the position, so the caller does not name slots.

Waiver settings are a kmap too. The only key the web client sends is `waiver_bid`:

```js
k_settings: keys.length ? keys : undefined,
v_settings: keys.length ? Object.values(settings) : undefined
```

Note the guard: when the settings object is empty both sides are omitted rather than sent
empty, because Sleeper rejects empty arrays on these arguments.

### draft_picks and waiver_budget are lists of encoded strings

Neither is a JSON document. Each entry is a delimited record of integers:

```
draft_picks[i]  = originalOwnerRoster,season,round,fromRoster,toRoster
waiver_budget[i] = fromRoster-toRoster-amount
```

The five `draft_picks` fields appear in exactly the order the public REST `traded_picks`
payload uses (`roster_id`, `season`, `round`, `previous_owner_id`, `owner_id`), which is
the strongest available corroboration that this is the right shape: the two encodings
describe the same object. `originalOwnerRoster` is the pick's slot owner and `fromRoster`
is who holds it now, so they diverge once a pick has been traded onward.

Treat this one as the least certain thing in the document. It is consistent with the
schema type and with the REST shape, but it has not been observed on the wire. Verify
with `--explain` against a league before relying on a pick trade.

### Other mutations worth knowing about

Not reachable from this CLI yet, but present in the schema:

| Mutation | Purpose |
| --- | --- |
| `roster_update_reserve` | IR and reserve slots (exposed as `sleeper lineup ir`) |
| `roster_update_taxi` | taxi squad (exposed as `sleeper lineup taxi`) |
| `process_transaction` | commissioner: force a pending waiver or trade to process |
| `force_cancel_transaction` | commissioner: cancel a pending transaction |
| `update_matchup_leg_custom_points` | commissioner: override a manager's score |
| `recalculate_matchup_scoring` | commissioner: rescore a week |
| `league_update_settings` | commissioner: change league settings |
| `roster_change_owner` | commissioner: transfer a roster |
| `update_draft_status` | change draft status |

### Headers

Sleeper's own client sends three headers beyond the obvious ones, and independent
third-party implementations report the first two as required:

```
Origin: https://sleeper.com
Referer: https://sleeper.com/
X-Sleeper-GraphQL-Op: <operationName>
```

`X-Sleeper-GraphQL-Op` is not enforced — at least two working clients omit it — but it
costs nothing to send and matches the real client. There is still no CSRF token.

Trade proposals and draft actions do **not** appear in the public page bundle — they load
only for authenticated users. Their signatures come from introspection, and their argument
shapes follow the same kmap convention as the mutations that are visible in the bundle.

## 6. Read operations worth knowing

The public REST API covers most reads, but these GraphQL queries are better because they
are scoped to the authenticated user and return richer objects:

| Query | Returns |
| --- | --- |
| `me` | the logged-in user |
| `league_user_by_user(sport, season, season_type)` | **every league you belong to, in one call** |
| `get_league(league_id)` | full league with settings and scoring |
| `league_rosters(league_id)` | all rosters, fully hydrated |
| `league_users(league_id)` | managers and team names |
| `league_user(league_id)` | your own membership in one league |
| `matchup_legs(league_id, round)` | matchups with `points`, `proj_points`, `starters`, `subs` |
| `league_transactions(league_id, ...)` | trades, waivers, adds, drops |
| `league_playoff_bracket(league_id)` | bracket |
| `get_player(sport, player_id)` | one player, with news and outlook |
| `get_player_stats(sport, player_id, season, ...)` | a player's stats |
| `game_stats(sport, season, ...)` | league-wide stat lines |
| `drafts_by_league_id(league_id)` | drafts, including dynasty history |
| `draft_picks(draft_id)` | draft board |
| `league_players(league_id)` | your watched players and notes |

`get_player_stats` and `game_stats` are the answer to "pull stats". The public REST player
map carries no statistics at all, so stats require GraphQL.

## 7. Errors

Unauthenticated calls do not fail at the HTTP layer. They return **HTTP 200** with a null
field and an error object:

```json
{"data":{"me":null},
 "errors":[{"code":"unauthorized","message":"Unauthorized","path":["me"]}]}
```

So the client must inspect `errors` even on a 200. The `path` array tells you which field
failed, and `code` is the machine-readable discriminator — `unauthorized` in particular is
how an expired token surfaces, and should be reported as "run `sleeper auth login`" rather
than as a generic failure.

## 8. Rate limits

The public REST API documents a ceiling of **1000 requests per minute** before an IP ban.
No published limit exists for the GraphQL endpoint. The CLI rate-limits conservatively and
retries on `429` with backoff rather than probing the boundary.
