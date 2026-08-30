# Known limitations

## Not proven live

The end-to-end loop was proven against live GitHub repositories on 2026-07-28.
Two legs were not:

- **GitLab.** Hermetic unit tests only — no live GitLab pipeline has run the
  rendered CI.
- **The cross-repository announce**, which needs a credential beyond the CI
  token.

## Require the check named `validate`

Not `validate / validate`. That was the context while the scaffold emitted thin
callers of reusable workflows; the workflow is now committed in the index repo,
so the context is just the job key. Requiring a context that never reports
blocks every PR forever, and looks exactly like the gate rejecting the
contribution.

## The combined layout's announce is ungated

See [Security and trust](../explanation/security-and-trust-model.md#known-gap).

## A dead nav or footer link warns, it does not fail

A `/`-rooted `nav` or `footerLinks` href that matches no emitted route and no
`public/` file prints one line to stderr after the build, naming the key:

```
nav[0].href "/setup/": nothing is published at that path — the link will 404
```

The build still succeeds, deliberately. Nothing here can tell a typo from a
path served by something outside this build — a redirect rule, a file another
job writes — and refusing a whole site over a footer typo is worse than the
typo. So a dead link is caught, and it is caught in output nobody has to read.

## Stopping `dev` seconds after boot can leave a scratch directory

`grim-indexer dev` stages the site in a `.index-*` directory inside your index
repo and removes it on shutdown. Interrupt the server within about a second of
it printing its URL and the directory survives — Vite's dependency optimizer is
still bundling, and it recreates
`.index-*/node_modules/.vite/deps_temp_<hash>/` *after* the removal has already
returned. Astro's `stop()` does not await that work, so this is not fixable
from inside the shutdown path.

Reproduced 2026-08-30 against the bundled dev index: interrupting on the boot
line left an 11 MB `.index-*` holding nothing but `deps_temp_<hash>`;
interrupting two and six seconds later cleaned up completely.

Harmless, and `.index-*/` is in the scaffolded `.gitignore`, so it is never
committed. Delete it by hand, or leave it — the next run stages a new one.

## The test tree is not type-checked by `task check`

`tsconfig.json` includes `src` only, and the lint is not type-aware, so no file
under `test/` is type-checked by the gate. `tsconfig.test.json` and the
`npm run typecheck:tests` script exist to run it on demand, and are deliberately
not wired into `check`: the existing tree has **95 real type errors** (measured
2026-08-30), which is its own piece of work rather than something to fix on the
way past.

## Deleting a theme file needs a dev restart

`grim-indexer dev` mirrors `theme/**` edits into the running server by copying
changed files. It does not remove deleted ones, so the shipped original does
not come back until the server restarts.

## Component overrides are unstable

Component file paths and props may move in a minor release. Only page routes
and the `@grim/*` specifier are semver-covered; see
[Stability](../reference/theme-overlay.md#stability).

## An unparseable tsconfig in the index repo breaks the build

The renderer builds in a directory inside your repo, so tsconfig resolution can
reach whatever that repo carries. A tsconfig that cannot be parsed — an
`extends` pointing into a `node_modules` that is not installed yet — makes the
build fail while rendering a page, with an error naming preact. The scaffolded
`tsconfig.json` is self-contained for this reason; a warning is printed when
the condition is detected. See [Troubleshooting](troubleshooting.md).

## Old versions

!!! danger "Use 0.1.4 or later"
    `0.1.0` installs without an executable — npm silently stripped its `bin`
    entry at publish time. `0.1.1` and `0.1.2` scaffold CI pointing at reusable
    workflows those tags do not contain, so the first push to a scaffolded
    index fails before any job runs.

    An index already scaffolded against a reusable-workflow version keeps
    working as long as its pinned `uses:`/`include:` refs stay on an existing
    tag — old tags are not deleted, so that resolution does not break on its
    own. It breaks the moment something bumps the pinned ref.
