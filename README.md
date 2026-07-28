# grim-indexer

CLI + Astro integration for running your own [Grimoire](https://github.com/grimoire-rs/grimoire)
package index — a static site that lists the skills, rules, agents, mcp
servers, and bundles available in one or more OCI registries.

## Subcommands

- `grim-indexer init` — scaffold a new index repo (`index/**` content
  tree, Astro site config, CI workflow).
- `grim-indexer build` — render `index/**` into a static site.
- `grim-indexer validate` — CI gate for contribution PRs/MRs against an
  index repo.

## Install

```sh
npm install --save-dev @grimoire-rs/indexer
```

## Usage

```sh
npx @grimoire-rs/indexer init
npx @grimoire-rs/indexer build
npx @grimoire-rs/indexer validate
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

## Status

Pre-1.0. The end-to-end loop was proven against live GitHub repositories
on 2026-07-28: `init` → push → Pages → `grim publish --announce` → PR →
gate → auto-merge → Pages → `grim config registry add` → `grim search` →
`grim add`. The gate accepted a genuine pointer and refused all five
hostile variants (author not the namespace owner, path outside the
pointer layout, registry host outside the committed allowlist,
unreachable OCI ref, unowned namespace).

Two things that trial settled, both worth knowing before you scaffold:

- **Requiring the gate needs the check named `validate / validate`**, not
  `validate`. Requiring a context that never reports blocks every PR
  forever and looks exactly like the gate rejecting your contribution.
- **In the combined (`--with-skills`) layout the gate does not cover your
  own CI's announce.** GitHub runs no workflows on a PR opened with
  `secrets.GITHUB_TOKEN`, so that PR arrives ungated — review it by hand.
  It also needs "Allow GitHub Actions to create and approve pull
  requests" enabled, which is off by default and which also lets
  workflows approve PRs.

Not yet proven live: the GitLab leg (hermetic tests only; the
`include: remote:` URL is verified to resolve), and the cross-repository
announce, which needs a credential beyond the CI token.

Two things are frozen and safe to build on: the published URL layout
(`/p/<namespace>/<name>/` and `/all.json`) and the per-record `schema`
field. Everything else may still move.

Theming is CSS custom properties, defined for both light and dark. There
is deliberately no component-override API yet — publishing one would
freeze a prop contract per slot, and that is not a promise worth making
this early.

> **Use `0.1.4` or later.** `0.1.0` installs without an executable — npm
> silently stripped its `bin` entry at publish time. `0.1.1` and `0.1.2`
> scaffold CI that points at reusable workflows those tags do not contain,
> so the first push to a scaffolded index fails before any job runs. An
> index already scaffolded against `0.1.1`/`0.1.2` is fixed by bumping the
> `@v0.1.x` refs in `.github/workflows/{pages,validate}.yml` — no
> re-scaffold needed.
>
> Through `0.1.3`, `init --with-skills` wrote a `publish.toml` with no
> `[announce]` table, so `grim publish --announce` in a combined-layout
> repo proposed its packages into the **public** first-party index rather
> than the one beside them. If you scaffolded that layout on `0.1.3` or
> earlier, add an `[announce]` table naming your own repository before
> announcing.

## License

Apache-2.0
