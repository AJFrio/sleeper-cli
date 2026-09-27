# Sleeper CLI

A command-line tool for managing Fantasy Football teams on [Sleeper](https://sleeper.com),
built for agents.

```bash
sleeper leagues list
sleeper lineup recommend --week 8
sleeper trade propose --with 3 --receive 1309 --send 486 --dry-run
sleeper waiver add 9221 --bid 12 --yes
```

## Why this exists

Sleeper publishes a read-only REST API. It covers leagues, rosters, drafts, matchups and
transactions, and it needs no authentication. It cannot do any of the things a manager
actually wants an agent to do: no trades, no adds and drops, no lineup changes, no
waivers.

Those operations live behind the internal GraphQL API that `sleeper.com` itself uses. This
tool drives that API directly. **No headless browser is involved** — Sleeper's `login` is
an ordinary HTTPS call that returns a bearer token, and every operation is a single
`POST` to `https://api.sleeper.app/graphql`. The browser is only ever relevant if Sleeper
presents a captcha, which it does not during a normal login.

The full set of findings, all verified against the live server, is in
[`docs/INTERNAL-API.md`](docs/INTERNAL-API.md).

## Install

Requires Node 22.12 or newer and Git.

```bash
git clone https://github.com/AJFrio/sleeper-cli.git
cd sleeper-cli
npm install
npm run build
npm link
sleeper --help
```

`npm link` makes the `sleeper` command available globally from this checkout, so keep
the cloned directory in place. To update it later, run `git pull`, `npm install`, and
`npm run build` from the clone.

## Sign in

```bash
sleeper auth login --identifier you@example.com
```

The password is read from `--password`, from `SLEEPER_PASSWORD`, or from an
unechoed prompt, in that order. It is never written to disk. The resulting session token
is stored at `~/.config/sleeper-cli/credentials.json` with mode `0600`.
If Sleeper requests a two-factor code, an interactive login prompts for it and retries.
For non-interactive runs, pass it with `--otp` or set `SLEEPER_OTP` for one invocation.

For CI or one-shot agent runs, skip the file entirely:

```bash
SLEEPER_TOKEN=... sleeper auth status
```

`SLEEPER_TOKEN` takes precedence over any stored credential, and nothing is written.
For a browser-authenticated session, provide Sleeper's session token through
`SLEEPER_TOKEN`; the API uses that token in its `Authorization` header, not a browser cookie.

## Commands

| Group | What it does |
| --- | --- |
| `auth` | `login`, `status`, `whoami`, `logout`, `token` |
| `leagues` | `list`, `use`, `current`, `settings`, `standings`, `rosters` |
| `roster` | `show` — starters, reserve, taxi, bench |
| `lineup` | `show`, `set`, `ir`, `taxi`, `recommend`, `bench-all` |
| `add` / `drop` | Free-agent moves, combined into one transaction |
| `trade` | `propose`, `accept`, `reject`, `list`, `show` |
| `waiver` | `add`, `edit`, `cancel`, `list`, `priority` |
| `players` | `search`, `get`, `available`, `cache` |
| `matchups` | `show`, `week`, `bracket` |
| `stats` | `player`, `league`, `leaders` |
| `transactions` | `list`, `show`, `traded-picks` |
| `draft` | `list`, `board` |
| `config` | `show`, `get`, `set`, `unset`, `paths`, `disk`, `reset` |
| `doctor` | One-shot diagnostic; exits 1 if anything is broken |

Every command takes an optional league id and falls back to the active league set with
`sleeper leagues use <id>`.

Run `sleeper <group> --help` or `sleeper <group> <command> --help` for the full list.
Command help includes worked examples.

## Built for agents

### Machine-readable output

`--json` on any command emits a single line on stdout:

```json
{"ok":true,"command":"sleeper lineup show","data":{ ... }}
```

Failures use the same envelope, with a machine-readable `code` and the numeric exit code:

```json
{"ok":false,"command":"sleeper add","error":{"code":"unauthenticated","message":"Not signed in to Sleeper","exit_code":3,"hint":"Run `sleeper auth login` to create a session."}}
```

Nothing but JSON is ever written to stdout in this mode, so `sleeper ... --json | jq` is
safe even when the command also emits warnings — those go to stderr.

### Stable exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unclassified error |
| 2 | Bad command line or usage error |
| 3 | Not signed in, or the session expired |
| 4 | League, roster, player or transaction not found |
| 5 | Sleeper understood the request and refused it |
| 6 | Rate limited |
| 7 | Could not reach Sleeper |
| 8 | State change needed confirmation but `--yes` was absent |
| 9 | Captcha required |
| 10 | Two-factor code required or rejected |

An agent can branch on these rather than parsing prose.

### Nothing changes without consent

Every state-changing command supports three modes:

- `--dry-run` computes the change, prints exactly what would be sent, and sends nothing.
- `--explain` prints the GraphQL document and variables and exits, also sending nothing.
- `--yes` applies the change without prompting.

With none of them, the CLI prompts on a terminal. **In a non-interactive context it
refuses and exits 8** rather than hanging or proceeding unasked. An agent that forgot
`--yes` gets a distinct, catchable exit code.

```bash
sleeper waiver add 9221 --bid 12 --dry-run   # preview
sleeper waiver add 9221 --bid 12 --explain   # see the exact request
sleeper waiver add 9221 --bid 12 --yes       # apply
```

### Players can be named

Numeric ids are error-prone to type and agents often hold a name instead. Wherever a
player is accepted, an exact Sleeper name works too:

```bash
sleeper lineup set "Josh Allen" "Stefon Diggs" --dry-run
```

A name that matches nothing, or more than one player, is an error rather than a guess.
Silently dropping a player from a waiver claim is the failure this tool exists to avoid.

## A note on trades

Trade proposals encode two positionally-zipped array pairs, and the value attached to
each player is that player's **current owner**: the counterparty's roster for a player
you receive, and yours for a player you send. This is the single easiest thing to get
backwards, and getting it backwards silently reverses the trade, so it is stated once in
[`src/commands/trade.ts`](src/commands/trade.ts) and pinned by tests.

Draft picks and FAAB travel in the same mutation as *lists of delimited strings*, not as
JSON objects:

```
draft_picks[i]   = originalOwnerRoster,season,round,fromRoster,toRoster
waiver_budget[i] = fromRoster-toRoster-amount
```

This is the least certain part of the whole tool. It is consistent with the schema type
and with the public REST `traded_picks` payload, but it has not been observed on the
wire. **Check a pick trade with `--explain` before you rely on it.** The reasoning is
written up in [`docs/INTERNAL-API.md`](docs/INTERNAL-API.md).

## Caching

Sleeper's player index is about 5MB of JSON and Sleeper asks that it be fetched at most
once a day. It is cached under `~/.cache/sleeper-cli` with a 20-hour TTL, which turns
subsequent commands from a 5MB download into a 14MB local read.

```bash
sleeper players cache            # report
sleeper players cache --refresh  # re-download
sleeper players cache --clear    # delete
sleeper config set player_cache_ttl_hours 6
```

## Configuration

| Key | Default | Purpose |
| --- | --- | --- |
| `active_league_id` | `null` | League commands default to |
| `sport` | `nfl` | Sleeper supports NFL only |
| `season` | `null` | `null` asks Sleeper for the current season |
| `output` | `table` | Default output format |
| `player_cache_ttl_hours` | `20` | Player cache lifetime |
| `default_roster_id` | `null` | Roster commands default to |

Files, all overridable by environment variable:

| Path | Override |
| --- | --- |
| `~/.config/sleeper-cli/` | `SLEEPER_CLI_HOME` |
| `~/.cache/sleeper-cli/` | `SLEEPER_CLI_CACHE_DIR` |

`sleeper config paths` prints the resolved locations.

## Troubleshooting

Run `sleeper doctor`. It checks the Node version, config permissions, credential file
permissions, session validity, the active league, the player cache, and connectivity,
then reports everything at once rather than stopping at the first problem. It exits 1 if
any check failed, so it works as a CI gate.

```bash
sleeper doctor
sleeper doctor --json | jq '.data.healthy'
```

When something is wrong, this is the first thing to include in a bug report, along with
`sleeper --version` and `sleeper config paths`.

### Expired session

```bash
sleeper auth status   # says "present but rejected"
sleeper auth login
```

### Captcha demanded

Sleeper occasionally challenges a login. Sign in at `sleeper.com` in a browser, then
move the token across:

```bash
sleeper auth token --reveal
export SLEEPER_TOKEN=...
```

## Development

```bash
npm install
npm run check     # typecheck, lint, and test
npm run dev -- leagues list
```

The test suite is entirely offline: the GraphQL and REST clients accept an injected
`fetch`, so transport behaviour is tested without touching the network.

## Scope

This tool covers what an agent needs to run a league: read everything, and change
rosters, lineups, trades and waivers. It deliberately does not pick players in a live
draft — a wrong pick in a timed draft is very hard to walk back, and that judgement
belongs to a person. Drafts are readable (`sleeper draft board`) but not writable.

## Legal

Not affiliated with or endorsed by Sleeper, Inc. Sleeper's public API is free for
non-commercial use; commercial use requires a licence from Sleeper. Using a personal
account to manage your own team is what this tool is for.

## License

MIT — see [LICENSE](LICENSE).
