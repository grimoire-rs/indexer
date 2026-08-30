# CLI

```sh
npx @grimoire-rs/indexer <command> [dir]
```

Inside a scaffolded index the commands are wired as npm scripts, and running
them that way uses the version that repo locked:

```sh
npm run dev
npm run build
npm run enrich
npm run validate
npm run ci
npm run ci:check
```

## `grim-indexer init`

Scaffold an index repo: the `index/**` content tree, `index.config.json`, a
`theme/` holding a `README.md` that states where a page goes and which parts of
the overlay are promised, an editor `tsconfig.json`, a `package.json` pinning
this package, and the CI its forge runs.

`theme/pages/` is not created — make it when you add your first page.

| Flag | Effect |
|---|---|
| `--quick` | Skip every prompt and take defaults (for CI) |
| `--name`, `--title`, `--base-url` | Identity, display title, deployment URL |
| `--registry <alias>`, `--registry-host <host>` | Registry alias and OCI host (default `ghcr.io`) |
| `--logo <path>` | Brand logo path or URL |
| `--repo-url <url>` | This repo's own URL — what `--announce` targets |
| `--no-git`, `--no-install` | Skip `git init` / `npm install` |
| `--force` | Overwrite user-owned scaffold files |

Re-running is safe: a file whose content already matches is `unchanged`, one
you have edited is `skipped` unless `--force`, and `index-policy.json` and
`publish.toml` are never overwritten at all — they hold data no scaffold can
regenerate.

## `grim-indexer dev`

Serve the index locally through the same renderer `build` uses.

| Flag | Effect |
|---|---|
| `--out-dir <dir>` | Output directory (default `dist`) |
| `--port <n>` | Port to listen on |
| `--host [addr]` | Bind beyond loopback. Bare, every interface; with a value, that address |

Mirrors `theme/**` edits into the running server. See
[Preview locally](../how-to/preview-locally.md).

Without `--host` the server binds loopback only, which is Astro's own default.
That is unreachable from a dev container, a VM or a WSL guest: the port forwards
and the connection then hangs against a socket that is not listening for it.

!!! warning "`--host` puts the preview on your network"
    Bare, it binds every interface, so anyone who can reach your machine can
    read the site — and a dev server serves the index repo it is pointed at.
    Name an address (`--host 127.0.0.1`, or the guest-facing one) where that
    matters.

## `grim-indexer build`

Compile `index/**` and render the site into `dist/`.

| Flag | Effect |
|---|---|
| `--out-dir <dir>` | Output directory (default `dist`) |

See [Output layout](output-layout.md) for what it writes.

Three things reach stderr without failing the build: a `theme/` path the
overlay [refuses](theme-overlay.md#what-the-overlay-refuses), a `theme/` path
that replaces a shipped file (named with the version it replaced), and a `nav`
or `footerLinks` href that [points at
nothing](config-schema.md#a-build-time-warning-never-a-failure).

## `grim-indexer enrich`

Refresh `enrich/**` from the registry: READMEs, changelogs, logos, versions,
tag lists, and the curated annotations grim reports (`revision`, `authors`,
`vendor`, `url`, `documentation`, `compatibility`, and the repository's
`support` channels).

**The only step that goes online, and the only one that needs `grim` on
`PATH`.**

| Flag | Effect |
|---|---|
| `--grim <path>` | Which grim binary reads the registry (default `grim`) |
| `--seed` | Restore `enrich/` from `<site>/enrich.json` first, so a pipeline that commits nothing still only downloads what moved |

## `grim-indexer validate`

The contribution gate. **Exit 0 means eligible for auto-merge**; any non-zero
means manual review.

| Flag | Effect |
|---|---|
| `--root <dir>` | Trusted base checkout — the committed state |
| `--pr-tree <dir>` | Checkout of the PR head, read as data only |
| `--policy <file>` | Path to `index-policy.json` |
| `--author-login`, `--author-id` | The contribution author's forge identity |

Every changed path must be `index/<host>/<namespace…>/<pkg>/metadata.json`.
Anything else — including anything under `theme/` — means manual review.

## `grim-indexer ci`

Render this repo's CI from the `ci` block of `index.config.json`.

| Flag | Effect |
|---|---|
| `--check` | Verify the committed CI matches the config; exit 65 on drift |

`--check` is what the generated `verify-ci` job runs on every push, and it is
what keeps a hand-edit from silently forking the pipeline.

## `grim-indexer ratings`

Tally the forge's upvote counters into `.stats.json`. Needs the `ratings`
block in `index.config.json`. The build publishes the result as `stats.json`
beside `all.json`.

Ratings are additive and absent-by-default: an index that publishes no sidecar,
a ref the sidecar omits, and a ref carrying other stats but no `rating` are the
same absence, and none of them is an error.

## Exit codes

Aligned with BSD `sysexits.h`, the same way `grim` itself is — semantic codes
start at 64 so they collide with neither the shell-reserved 1–2 nor the
signal-derived 128+.

| Code | Name | Meaning |
|---|---|---|
| 0 | ok | Success. For `validate`: eligible for auto-merge |
| 1 | failure | Generic failure — only when nothing more specific applies |
| 64 | usage | Bad invocation: unknown flag, missing argument, bad enum value |
| 65 | data | Input malformed: unparseable or invalid `metadata.json`, or CI drift under `--check` |
| 69 | unavailable | A required resource is missing |
