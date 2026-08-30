# Grimoire Indexer

`@grimoire-rs/indexer` runs your own [Grimoire](https://github.com/grimoire-rs/grimoire)
package index: a static site listing the skills, rules, agents, MCP servers and
bundles available in one or more OCI registries, with search, per-package
pages, install commands and an optional ratings sidecar.

An index stores nothing but **pointers** — a ref and who owns it. Everything a
reader looks at lives in the registry, which is why `enrich` exists and why an
index that never runs it renders a catalogue of names.

## Start here

<div class="grid cards" markdown>

- **[Quickstart](how-to/quickstart.md)** — scaffold an index, add a package,
  publish it to Pages.
- **[Add your own pages](how-to/add-pages.md)** — a setup guide, a publish
  guide, anything else your organization needs in the site.
- **[Config schema](reference/config-schema.md)** — every key
  `index.config.json` accepts.
- **[Theme overlay](reference/theme-overlay.md)** — what `theme/` can replace,
  and what is contract.

</div>

## What is frozen

Two things are safe to build on: the published URL layout
(`/p/<namespace>/<name>/` and `/all.json`) and the per-record `schema` field.
Everything else may still move — including `/enrich.json`, which is this
package's own checkpoint and not a read contract.

The customization surface has its own tiers, listed in
[Theme overlay](reference/theme-overlay.md#stability): page routes and the
`@grim/*` specifier are contract; component paths and props are not yet.

## Status

Pre-1.0. The end-to-end loop was proven against live GitHub repositories on
2026-07-28: `init` → push → Pages → `grim publish --announce` → PR → gate →
auto-merge → Pages → `grim config registry add` → `grim search` → `grim add`.
The gate accepted a genuine pointer and refused all five hostile variants.

Not yet proven live: the GitLab leg (hermetic unit tests only — no live GitLab
pipeline has run the rendered CI), and the cross-repository announce, which
needs a credential beyond the CI token. See
[Known limitations](ops/known-limitations.md).
