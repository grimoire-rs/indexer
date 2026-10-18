---
paths:
  - 'src/**/*.ts'
  - 'test/**/*.ts'
---

# grim compatibility markers

The indexer spawns `grim` in one place (`src/enrich/index.ts`) and decides which
grim it accepts in one place (`src/grim.ts`):

- `MINIMUM_GRIM_VERSION` is the floor. `grim-indexer enrich` probes
  `grim --version` once, before any registry call, and exits 69 below it
  (`checkGrim` in `src/cli/enrich.ts`). `validateCi` (`grim-indexer ci`) refuses a
  `ci.grimVersion` pinned below it.
- A feature that needs a newer grim gets its own constant above the floor and a
  `supports<Feature>()` check (today: `MARKETPLACE_GRIM_VERSION`,
  `supportsMarketplaceExport`). It never moves the floor: an index that does not
  use the feature keeps working with an older grim.

Standing policy is **no compat shims**: target the current grim and let a stale
binary surface its real error. This rule is not a licence to add them. It is the
price of the rare approved one, so that it expires on schedule instead of
rotting into permanent code nobody dares delete.

## Syntax

One line, directly above the branch it guards:

```ts
// grim-polyfill<X.Y.Z: <what an older grim does at the CLI level, and why this branch exists>
```

`X.Y.Z` is the first grim release where the branch is **dead**. Delete the
branch when `MINIMUM_GRIM_VERSION` reaches `X.Y.Z`.

Find every marker:

```sh
grep -rn 'grim-polyfill<' src test
```

## When to use it

Only for **CLI-surface** compatibility, a difference at the process boundary
that cannot be detected from the payload:

- a flag or subcommand an older grim rejects with exit 64 (a clap usage error),
  such as the `supportsMarketplaceExport` gate in `checkGrim`
- a behavioural difference in exit codes or stream handling

## When NOT to use it

**Never on additive or nullable JSON-field handling.** grim's JSON interface is
frozen and additive: never assume a field exists, and treat nullable as null.
`describe`'s curated annotations are the standing example (`META_KEYS` in
`src/enrich/index.ts`): an older grim reports fewer of them, and absent is
written as absent. That is permanent doctrine, not a shim. It does not expire,
and marking it would queue correct code for deletion at every floor bump. An
absent field needs a read-site guard, never a version gate.

Never match grim's error text to detect an old grim (clap's "unrecognized
subcommand"). Gate on the probed version; the wording is not a contract.

Never mark `MINIMUM_GRIM_VERSION`, `grimTooOld` or `checkGrim`'s floor check.
They are the floor, not compatibility with something below it.

## Before tagging one

Confirm the branch is reachable **only** on a grim below `X.Y.Z`: every caller
must have passed `checkGrim` first. A new entry point that spawns grim without
it makes "safe to delete at X.Y.Z" false, and the marker lies.

## Don't land it empty

The marker ships in the same commit as its degradation branch, never
speculatively. A marker with no paired branch means it is being used
prematurely. The expiry check is `test/grim-compat-markers.test.ts`: it fails
when the floor reaches a marker's version, and on any `grim-polyfill<` that is
not exactly `X.Y.Z:`, so a typo cannot exempt itself from the sweep.

## Raising the floor

1. Bump `MINIMUM_GRIM_VERSION` to a **released** grim, never an unreleased one.
2. Run `npx vitest run test/grim-compat-markers.test.ts`. Each red line names a
   branch that is now dead: delete it and its marker.
3. A feature constant the floor has reached goes too, with its `supports*()`
   check and its callers' guards.
4. Update the stated requirement in `README.md`, `docs/reference/cli.md`
   (`grim-indexer enrich`) and `docs/how-to/quickstart.md`.

Adding a feature that needs a newer grim is the same list in reverse: a
constant above the floor, a `supports*()` check, a marked guard in `checkGrim`,
and a row in the cli.md requirement line.
