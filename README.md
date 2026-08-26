# grim-indexer

CLI + Astro integration for running your own [Grimoire](https://github.com/grimoire-rs/grimoire)
package index — a static site that lists the skills, rules, agents, mcp
servers, and bundles available in one or more OCI registries.

## Subcommands

- `grim-indexer init` — scaffold a new index repo: the `index/**` content
  tree, site config, a `package.json` that pins this package, and the CI
  its forge runs.
- `grim-indexer dev` — serve the index locally, through the same renderer
  `build` uses. The review loop for an entry or a branding change.
- `grim-indexer enrich` — refresh `enrich/**` from the registry: READMEs,
  changelogs, logos, versions, tag lists, and the curated annotations grim
  reports (`revision`, `authors`, `vendor`, `url`, `documentation`,
  `compatibility` and the repository's `support` channels). The only step
  that goes online, and the only one that needs `grim` on `PATH`.
- `grim-indexer build` — render `index/**` into a static site.
- `grim-indexer validate` — CI gate for contribution PRs/MRs against an
  index repo.
- `grim-indexer ci` — render the index repo's workflows from the `ci`
  block of its `index.config.json`; `--check` verifies the committed ones
  still match and exits 65 on drift.

A scaffolded index owns its CI: the workflow files are committed in that
repository and run `npm ci` against its own lockfile, so nothing is
fetched from here at run time and the version that builds an index is the
one that repo has locked. The generated `verify-ci` job re-renders and
diffs on every push, which is what keeps a hand-edit from silently
forking the pipeline.

An index stores nothing but pointers — a ref and who owns it. Everything a
reader looks at lives in the registry, so an index that never runs `enrich`
renders a catalogue of names with *No README available* on every page. The
scaffolded CI runs it before each build; set `"enrich": false` in the `ci`
block for a pointers-only site.

## Install

```sh
npm install --save-dev @grimoire-rs/indexer
```

## Usage

```sh
npx @grimoire-rs/indexer init     # scaffold; writes package.json + lockfile
```

Or start from [`grimoire-rs/index-template`](https://github.com/grimoire-rs/index-template):
"Use this template", clone, then `npm install && npm run setup` — which is
`init` run in place, so it reads your `origin` remote and already knows the
forge and the Pages URL.

Everything after that runs through the scaffolded repo's own scripts, so it
uses the version that repo locked:

```sh
npm run dev        # local preview
npm run build      # index/** -> dist/
npm run enrich     # needs `grim` on PATH
npm run validate   # the contribution gate
npm run ci         # re-render CI after editing index.config.json
npm run ci:check   # fail on drift (what the verify-ci job runs)
```

As an Astro integration:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import grimoireIndexer from "@grimoire-rs/indexer/integration";

export default defineConfig({
  integrations: [grimoireIndexer()],
});
```

## The `stats.json` sidecar

An index may publish `stats.json` beside `all.json`. It carries per-artifact
signals that are not part of a package's own metadata — today two: `rating`,
the upvote count on the forge thread that owns that artifact, and `updated`,
when that artifact last moved. It is the read contract every client shares:
`grim`, this renderer, and the VS Code extension all read the same file, and
none of them writes it.

```json
{
  "schema_version": 1,
  "generated_at": "2026-08-18T09:30:00Z",
  "providers": { "rating": "github", "updated": "indexer" },
  "entries": {
    "ghcr.io/acme/code-review": {
      "rating": {
        "up": 12,
        "target": "DIC_kwDOAbc123",
        "url": "https://github.com/acme/index/discussions/42"
      },
      "updated": { "at": "2026-07-01T10:00:00+00:00" }
    }
  }
}
```

| Key | Type | Meaning |
|---|---|---|
| `schema_version` | int | Monotonic. Currently `1`. |
| `generated_at` | string | RFC 3339, UTC. |
| `providers` | object | Which backend produced each signal, keyed by stat name. `providers.rating` is `"github"` or `"gitlab"`. |
| `entries` | object | Keyed by artifact ref, **exactly as that ref appears in `all.json`**. |
| `entries[ref]` | object | One key per signal. |
| `entries[ref].rating.up` | int | Upvotes. A ref with zero is omitted, never written as `0`. |
| `entries[ref].rating.target` | string | The forge's own id for the thread. **Opaque.** |
| `entries[ref].rating.url` | string | Where a human goes to vote. **Opaque.** |
| `entries[ref].updated.at` | string | RFC 3339. When the artifact last moved. |

`target` and `url` are opaque: no client parses one and no client constructs
one. They differ per forge and may change shape without a `schema_version`
bump, which is exactly what "opaque" buys.

**`entries[ref]` is a bag of stats, not a record.** A ref may carry `updated`
and no `rating`, or the reverse. A further signal arrives as a sibling key
with a sibling entry in `providers`; that is additive and needs no version
bump.

Some fixtures under `test/ratings/fixtures/` carry a `downloads` key. It is
there as an *unknown* key — the thing a reader must carry forward without
understanding — and is **not a specification**. No producer writes it, its
shape is not fixed, and a client must not code against it.

### Absent is first-class

Five distinct levels of absence. None of them is an error, a warning above
`debug`, or a failed build:

| Absent | Means |
|---|---|
| The file (404) | This index publishes no stats |
| `entries` | Nothing is rated yet |
| A ref within `entries` | That artifact has no stats at all |
| `rating` on a ref that is present | Unrated — and any other stat on that ref is unaffected |
| `rating` on a rendered catalog entry | Unrated. No consumer may assume the field is there |

### Reading a document you do not fully understand

A client that understands version *N* accepts any document declaring `≤ N`,
ignoring fields it does not know. A document declaring `> N` may degrade to
"no rating", but must never be a parse error. So fields are added and never
repurposed, and `schema_version` rises only when an existing field changes
meaning.

`test/ratings/fixtures/` holds one document per rule above — the minimal valid
v1, unknown fields at two levels, an unrecognised `providers.rating` value, the
absence levels, and a document from the future. They are the reference
documents for every client's parser tests, in this repository and outside it.

### Producing it

`updated` needs no configuration and no forge. `enrich` already runs `describe`
per package, so it writes the date into the sidecar — the artifact's own
`created` (a commit date, so a re-publish of the same commit keeps the same
answer) or, for an artifact published outside a repository, the first build
that saw its current digest. `build` joins that onto the document it
publishes. An index that runs `enrich` gets it whether or not it wants
ratings.

`rating` is opt-in. Add a `ratings` block to `index.config.json` and re-render
CI (`npm run ci`). The block is optional; without it nothing is tallied.

```jsonc
"ratings": {
  "provider": "github",   // "github" | "gitlab"
  "container": "Ratings", // GitHub: Discussions category. GitLab: work item type.
  "createBudget": 400,    // threads created per run; default 400
  "lockThreads": true     // default TRUE - votes count, replies are refused
}
```

`provider` and `container` are required; the other two have the defaults shown.
Unknown keys are ignored. There is deliberately **no `botIds` key** — the
author allowlist is `index-policy.json`'s `trustedBots[].id`, and a second copy
of the same ids in a second file is a consistency hazard rather than a
convenience.

`lockThreads` defaults to `true` on purpose. It is the low-moderation default —
an operator gets a rating signal without also running a comment forum they have
to moderate — and it independently hardens the marker rule, because a locked
thread cannot receive the forged-marker reply that rule exists to reject.

Re-rendering with the block present adds one job to the generated pipeline
(`ratings` on GitHub, `grim-indexer:ratings` on GitLab), an hourly schedule, and
a seed step in the deploy. The seed step is what keeps a failed tally from
emptying a published rating set: it reads the currently published `stats.json`
and carries it forward per stat key, and it fails the job rather than treating
an unreadable seed as an empty one.

### Turning it off

Two steps, and the first alone is not enough:

1. Remove the `ratings` block and re-render CI. That stops the tally.
2. **Delete the published `stats.json` from the deploy.** Until it is gone the
   last tally keeps being served, frozen, forever.

After both, clients read a 404 and every artifact shows as unrated on its next
refresh — unless the index still runs `enrich`, in which case the next build
republishes a `stats.json` carrying `updated` and nothing else. The sidecar is
never committed — it is a build input the deploy publishes — so there is no
history to unwind either way.

## Status

Pre-1.0. The end-to-end loop was proven against live GitHub repositories
on 2026-07-28: `init` → push → Pages → `grim publish --announce` → PR →
gate → auto-merge → Pages → `grim config registry add` → `grim search` →
`grim add`. The gate accepted a genuine pointer and refused all five
hostile variants (author not the namespace owner, path outside the
pointer layout, registry host outside the committed allowlist,
unreachable OCI ref, unowned namespace).

Two things that trial settled, both worth knowing before you scaffold:

- **Require the check named `validate`.** It was `validate / validate`
  while the scaffold emitted thin callers of reusable workflows; the
  workflow is now committed in the index repo, so the context is just the
  job key. Requiring a context that never reports blocks every PR forever
  and looks exactly like the gate rejecting your contribution.
- **In the combined (`--with-skills`) layout the gate does not cover your
  own CI's announce.** GitHub runs no workflows on a PR opened with
  `secrets.GITHUB_TOKEN`, so that PR arrives ungated — review it by hand.
  It also needs "Allow GitHub Actions to create and approve pull
  requests" enabled, which is off by default and which also lets
  workflows approve PRs.

Not yet proven live: the GitLab leg (hermetic unit tests only - no live
GitLab pipeline has run the rendered CI), and the cross-repository
announce, which needs a credential beyond the CI token.

Two things are frozen and safe to build on: the published URL layout
(`/p/<namespace>/<name>/` and `/all.json`) and the per-record `schema`
field. Everything else may still move.

Theming is CSS custom properties, defined for both light and dark. There
is deliberately no component-override API yet — publishing one would
freeze a prop contract per slot, and that is not a promise worth making
this early.

> **Use `0.1.4` or later.** `0.1.0` installs without an executable - npm
> silently stripped its `bin` entry at publish time. `0.1.1` and `0.1.2`
> scaffold CI that points at reusable workflows those tags do not contain,
> so the first push to a scaffolded index fails before any job runs.
>
> An index already scaffolded against a reusable-workflow version keeps
> working as long as its pinned `uses:`/`include:` refs stay on an existing
> tag - old tags are not deleted, so that resolution does not break on its
> own. It breaks the moment something bumps the pinned ref, because `main`
> no longer defines any reusable workflow or remote include for it to
> resolve to: a Renovate update of an `@grimoire-rs/indexer` action ref
> will now fail hard. Fix it before that happens by adding a `package.json`
> pinning this package (if the old scaffold has none) and running
> `npm run ci`, which re-renders the workflow files and nothing else.
> **Not `init --force`**: that rewrites the whole scaffold from its
> templates, discarding the added scripts in `package.json`, your
> `.gitignore` rules, your `README.md`, and any `uses:` pin Renovate has
> bumped since - `npm run ci` keeps all four. `publish.toml` and
> `index-policy.json` are never rewritten, by `--force` or anything else.
>
> Through `0.1.3`, `init --with-skills` wrote a `publish.toml` with no
> `[announce]` table, so `grim publish --announce` in a combined-layout
> repo proposed its packages into the **public** first-party index rather
> than the one beside them. If you scaffolded that layout on `0.1.3` or
> earlier, add an `[announce]` table naming your own repository before
> announcing.

## Developing the renderer

Changing how the site *looks* needs a way to see it that does not cost an
npm release. `npm run dev` serves the catalog with hot reload:

```sh
npm run dev                                 # the bundled test fixture
npm run dev -- --port 4400
npm run dev -- --root /path/to/an/index     # your own index, or a checkout
                                            # of github.com/grimoire-rs/index
npm run dev -- --config ./variant.json      # try an index.config.json without
                                            # editing the index it renders
npm run dev -- --help
```

Every part of the hero is config, so `--config` is how you review the site
with a piece switched off — `{"install": []}` drops the installer buttons,
`{"registry": null}` the add-this-index ones, `{"vscodeExtension": null}`
every VS Code affordance on both pages.

It renders through the same `inlineConfig` as `grim-indexer build`, so the
preview is the release output, not an approximation. Edits under
`src/renderer/astro/` (templates, components, the token block in
`layouts/Base.astro`) reload in place; changing the renderer's own
TypeScript needs a restart, because `npm run dev` builds `dist/` on start.

The scratch index root lives in the gitignored `.dev/`, rebuilt on every
run — the repo you point `--root` at is copied, never rendered in place.

`npm run dev:smoke` boots the server, asserts the landing and detail pages
render, and checks the staged directory is cleaned up on shutdown. That
check lives here rather than in the vitest suite because Astro's dev server
does not route correctly when nested inside vitest's own Vite; the build
path is covered by `test/renderer/build.test.ts`.

To rehearse the *published* package without publishing it, `npm pack` and
install the resulting tarball into a scratch index repo.

## License

Apache-2.0
