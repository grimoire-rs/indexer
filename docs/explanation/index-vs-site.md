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
`grim-indexer enrich`. It is deliberately the only command that reads the
registry and the only one that needs `grim` on `PATH`.

The build chain has two online steps, and both run ahead of `build`:

- **`enrich`** calls the registry through `grim`. It also reads the root the
  last deploy published and the state that root names, so a run starts from what
  the last deploy learned.
- **`state-key`** reads that root and the plane index, and prints the cache key
  of the state, so CI can restore the cache before `enrich` runs.

`ratings`, `downloads` and `stats-seed` go online too, to a forge, to
Artifactory or to the published stats. They feed the stats sidecar, not the
enrich state.

The consequence is worth stating plainly: **an index that never runs `enrich`
renders a catalogue of names**, with *No README available* on every page. The
scaffolded CI runs it before each build. Set `"enrich": false` in the `ci`
block if you genuinely want a pointers-only site.

Splitting it this way buys three things:

- **A build is offline and deterministic.** Given the same `index/**`,
  `enrich/**` and hand-off, it renders the same site. That is what makes the CI
  drift check meaningful. `build` and `dev` make no request at all.
- **A contribution PR is reviewable.** It adds one small JSON file. A PR that
  also carried a rendered README would be a PR carrying arbitrary content from
  a registry the reviewer does not control.
- **A registry change does not rewrite history.** The pointer is the committed
  fact; the prose is a cache, refreshed on a schedule.

## The hand-off

`enrich` keeps its state in `.grim-index-state/` and hands the finished enrich
plane to the offline `build`, which publishes it. The hand-off is the only thing
`build` reads from `enrich`. It holds the plane, the generation for the root, the
counters for the log line, and the files of the previous root to keep. With
none, `build` warns and publishes without a plane.

The next `enrich` reads the published root before it does anything else, and
restores from the state it names. A pipeline that commits nothing therefore
still downloads only what moved. `state-key` lets CI restore the matching cache
before `enrich` runs.

That state is this package's own bookkeeping. It is published because that is
the cheapest place to put it, not because anything else should read it.

## Ratings

Upvotes live in a `stats.json` sidecar, tallied from forge counters by
`grim-indexer ratings` and joined onto packages at build time. The site is
built once for everyone, so a rating is a count and never a "you voted" state.

Absence is first-class throughout: no sidecar, a ref the sidecar omits, and a
ref carrying other stats but no `rating` are the same thing, and none of them
is an error.
