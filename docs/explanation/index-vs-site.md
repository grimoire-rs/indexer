# Index vs. site

An **index** is a tree of pointers. One entry is a file:

```
index/<host>/<namespace>/<package>/metadata.json
```

and it holds a ref and who owns it. That is all. No README, no version list, no
logo, no description — nothing that would have to be kept in step with a
registry that changes without telling you.

A **site** is what `grim-indexer build` renders from that tree: the catalog,
the per-package pages, the search, the install commands.

## Why enrichment is a separate step

Everything a reader actually looks at lives in the registry. Fetching it is
`grim-indexer enrich`, and it is deliberately the only command that goes
online and the only one that needs `grim` on `PATH`.

The consequence is worth stating plainly: **an index that never runs `enrich`
renders a catalogue of names**, with *No README available* on every page. The
scaffolded CI runs it before each build. Set `"enrich": false` in the `ci`
block if you genuinely want a pointers-only site.

Splitting it this way buys three things:

- **A build is offline and deterministic.** Given the same `index/**` and
  `enrich/**`, it renders the same site — which is what makes the CI drift
  check meaningful.
- **A contribution PR is reviewable.** It adds one small JSON file. A PR that
  also carried a rendered README would be a PR carrying arbitrary content from
  a registry the reviewer does not control.
- **A registry change does not rewrite history.** The pointer is the committed
  fact; the prose is a cache, refreshed on a schedule.

## The checkpoint

`enrich` writes `enrich.json` into the output, and the next run's
`enrich --seed` reads it back from the deployed site before doing anything
else. A pipeline that commits nothing therefore still only downloads what
actually moved, rather than re-fetching every package every night.

That file is this package's own bookkeeping. It is published because that is
the cheapest place to put it, not because anything else should read it.

## Ratings

Upvotes live in a `stats.json` sidecar, tallied from forge counters by
`grim-indexer ratings` and joined onto packages at build time. The site is
built once for everyone, so a rating is a count and never a "you voted" state.

Absence is first-class throughout: no sidecar, a ref the sidecar omits, and a
ref carrying other stats but no `rating` are the same thing, and none of them
is an error.
