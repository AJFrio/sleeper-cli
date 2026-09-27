# Contributing

## Getting set up

```bash
npm install
npm run check    # typecheck + lint + test
npm run dev -- --help
```

Node 20.12 or newer.

## Working against Sleeper

`docs/INTERNAL-API.md` documents the internal GraphQL API, including the encoding quirks
that are not discoverable from the public documentation. Read it before touching
`src/core/graphql.ts`, `src/core/kmap.ts`, or anything in `src/domain/`.

Every fact in that document was verified against the live server. If you find one that is
no longer true, that is a bug worth reporting — the document is load-bearing for anyone
maintaining this.

The test suite is entirely offline. Both clients accept an injected `fetch` and `sleep`,
so you should never need a real account to run it. If you find yourself adding a test
that hits the network, extract the logic instead.

## Verifying a change against the live API

Some things cannot be unit-tested: whether a mutation's argument shape is still what
Sleeper expects. For those:

```bash
sleeper <command> --explain      # prints the exact GraphQL request, sends nothing
sleeper <command> --dry-run      # shows the resolved change, sends nothing
sleeper <command> --json         # machine-readable result
```

`--explain` and `--dry-run` are the two you want. Never test a write by just running it.

## Style

- Biome formats and lints. `npm run lint:fix` applies fixes; `npm run check` is the gate.
- No `any`, no `@ts-ignore`, no non-null assertions. Fix the types instead.
- Comments explain *why*, not *what*. The kmap encoding and the auth scheme each have one
  explanatory comment at the point of use; do not scatter restatements of the code.
- Keep files focused. A module that needs a comment explaining what it is probably two
  modules.

## Adding a command

1. Put the request logic in `src/domain/`, as a `build*Operation` (for `--explain` and
   `--dry-run`) plus an async executor.
2. Put the Commander wiring in `src/commands/`, exporting a single
   `register*Commands(program, deps)`.
3. Register it in `src/index.ts`.
4. Never write to stdout or stderr directly — go through `deps.emit()`. That is what keeps
   the JSON contract intact.
5. Any mutation goes through `confirmAction`. No exceptions.
6. Add tests, including the JSON envelope and the exit code on failure.

## Safety

This tool can propose trades and drop players. Treat every mutation path as load-bearing:

- Validate locally before sending, so a mistake becomes a precise message rather than an
  opaque rejection.
- Name the affected players in the confirmation prompt.
- Never make a mutation reachable without passing the confirmation gate.
