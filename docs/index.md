# Grimoire Indexer

`@grimoire-rs/indexer` runs your own [Grimoire](https://github.com/grimoire-rs/grimoire)
package index: a static site listing the skills, rules, agents, MCP servers,
bundles and hooks available in one or more OCI registries, with search, per-package
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

Three things are safe to build on. The first is the page URL layout
(`/p/<namespace>/<name>/`). The second is the data files `/all.json` and
`/stats.json`, with the per-record `schema` field. The third is the root
`/c/root.json` and the `/c/f/sha256/` blobs it names. `/all.json` and
`/stats.json` are frozen only while `sync.legacy` is true, which is the default.
Everything else may still move. See
[Output layout](reference/output-layout.md#frozen).

The customization surface has its own tiers, listed in
[Theme overlay](reference/theme-overlay.md#stability): page routes and the
`@grim/*` specifier are contract. Routes under the reserved `c/` and `browse/`
are the exception. Component paths and props are not yet contract.

## Status

Pre-1.0. The end-to-end loop was proven against live GitHub repositories on
2026-07-28: `init` → push → Pages → `grim publish --announce` → PR → gate →
auto-merge → Pages → `grim config registry add` → `grim search` → `grim add`.
The gate accepted a genuine pointer and refused all five hostile variants.

Not yet proven live: the GitLab leg (hermetic unit tests only — no live GitLab
pipeline has run the rendered CI), and the cross-repository announce, which
needs a credential beyond the CI token. See
[Known limitations](ops/known-limitations.md).
