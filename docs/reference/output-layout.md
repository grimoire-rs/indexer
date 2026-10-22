# Output layout

What `grim-indexer build` writes into `dist/`.

```
dist/
  index.html                                   the catalog
  p/<namespace>/<name>/index.html              one per package
  all.json                                     every record (while sync.legacy is true)
  all.json.gz                                  the same bytes, gzipped (while sync.legacy is true)
  stats.json                                   ratings + updated dates (while sync.legacy is true)
  stats.json.gz                                the same bytes, gzipped (while sync.legacy is true)
  c/root.json                                  the root: which files are current
  c/f/sha256/<digest>.json.gz                  the catalog and stats blobs
  c/p/sha256/<digest>.json                     the enrich plane index
  c/s/sha256/<digest>.json                     one enrich shard per bucket
  index/<host>/<ns>/<pkg>/metadata.json        the pointer tree, served as data
  favicon.svg                                  and everything else from public/
  _astro/…                                     hashed CSS and island bundles
  setup/index.html                             any page you added under theme/pages/
```

## Frozen

| Path | Promise |
|---|---|
| `/p/<namespace>/<name>/` | Frozen, whatever `sync.legacy` says. `grim` resolves against it, the VS Code deep link points at it, and search engines index it |
| `/all.json`, `/stats.json`, and the per-record `schema` field | Frozen while `sync.legacy` is true, which is the default |
| `/c/root.json` and `/c/f/sha256/` | The client contract. Permanent once an index emits them. An index built by an older indexer publishes neither |

Everything else may still move. The enrich plane under `c/p/` and `c/s/` is
pipeline-private and not a contract either.

## The root

`c/root.json` is the one mutable file under `c/`. Every file it names is
immutable, because each is named by the digest of its own bytes.

The sample below is illustrative. Its digests are elided, and its sizes are
round placeholders, not measurements.

```json
{
  "flat": { "sha256": "…", "size": 40000000 },
  "generated_at": "2026-10-21T05:20:00Z",
  "generation": 1792560000,
  "planes": { "catalog": null, "enrich": { "sha256": "…", "size": 100000 } },
  "schema": 1,
  "search": null,
  "stats": { "sha256": "…", "size": 3000000 }
}
```

| Field | Meaning |
|---|---|
| `schema` | `1`. Fields are added and never repurposed |
| `generation` | UNIX seconds. With a hand-off, the number `enrich` chose: the clock, or the published generation plus one if that is larger, so it only moves forward. A published value more than a day ahead of the clock is ignored. Without a hand-off, the build clock |
| `generated_at` | The build time, RFC 3339, UTC |
| `flat` | `null` under `sync.layout: flat`. Under `anchored`, the catalog blob |
| `stats` | The stats blob, or `null` when the build has no `stats.json` |
| `planes.enrich` | The enrich plane index. `null` when the build had no hand-off from `enrich`, or when the hand-off's plane was not whole |
| `planes.catalog` | Always `null`. Reserved |
| `search` | Reserved for the site's search file. `null` today |

Each blob reference is `{sha256, size}` over the **inflated** JSON, not over the
file on disk.

The build writes the root after every file it names, so a reader that finds a
root finds all of them. The order is:

1. The enrich plane, `c/p/` and `c/s/`, copied from the hand-off.
2. The `c/f/` blobs, then `all.json.gz` and `stats.json.gz` while `sync.legacy`
   is true, then `c/root.json`.
3. With `sync.legacy: false`, the removal of `all.json` and `stats.json`.
4. The [retained files](#retained-files), copied after the root.

A deploy target that uploads file by file should upload `c/root.json` and
`index.html` after everything else.

## The `c/f/` blobs

`c/f/sha256/<digest>.json.gz` holds one gzip member with a zero mtime, no name
and a fixed level, so the same JSON always gives the same bytes. A blob exists
only as `.json.gz`. The catalog blob inflates to the bytes of `all.json`, and
the stats blob to the bytes of `stats.json`.

While `sync.legacy` is true, `all.json.gz` and `stats.json.gz` are
byte-identical to the blob files of the same JSON. With `layout: flat` the
folder holds the stats blob only.

## The enrich plane

`c/p/sha256/<digest>.json` is the plane index. It names one shard per bucket
under `c/s/sha256/<digest>.json`, and records `state_epoch` and the digest of
the blob set. Each shard holds the entries of the refs that hash into its
bucket, already cut to the [record bounds](#bounded-record-fields).

The plane is published so the next `enrich` can start from it. Only the indexer
reads it. A shard stays under 2 MiB, and `enrich` warns at 1.5 MiB. A shard
that would pass 2 MiB turns its entries with the most data into pointer-only
entries until it fits, and `enrich` warns naming them.

Two pointers can share one `ref`. `all.json` and the pages keep both. The plane
keeps the last in sorted path order, and a warning names both paths.

## Retained files

`dist/c/` holds the new root's files and the live root's files, and nothing
older. A reader that fetched the live root a moment before the deploy can
still fetch every file it names. Debian's `by-hash` keeps the previous
`Release` files the same way.

- **`enrich` stages them.** For each file of the live root, it takes the file
  from the blob store by digest. Otherwise it fetches the file from `site`.
  Either way it checks the sha256 and the size, and writes the file under
  `.grim-index-state/out/retained/`. Staging stops 10 minutes after the enrich
  time budget ends.
- **`build` copies them.** Each staged file that the new root lacks is checked
  again and copied into `dist/c/`. `build` makes no request.
- **It is best-effort.** A file that is missing, or that fails its check, is
  skipped with a warning. It costs a reader holding the old root a 404 and a
  fall back to `all.json`, and never wrong data.
- **Some runs stage nothing.** `ci.enrich: false`, `dev` and a failed stage
  deploy the new files alone. So does an outage run, where `enrich` exits 69
  because more than half the refs failed.

`site` is read only when `index.config.json` sets it, because the built-in
default names another index. A cold blob store fetches the live root's files
from `site`, about 260 files at 20,000 entries. `enrich --purge <sha256>`
removes a digest from staging, the blob store and the next deploy.

## `c/` and `browse/` are reserved

`c/` and `browse/` belong to the catalog in every layout, `flat` included.
Before it renders, the build scans your `public/` and `theme/pages/`. If any
file would publish under either directory, it fails with exit 65 and names
each file and the fix:

```
public/c/notes.txt: c/ and browse/ are reserved for the catalog in every layout — move this file to another directory
```

It lists up to ten files and then `…and N more`. A page's route is its path
without the extension, so `theme/pages/c.astro` is the reserved route `c`.
Names compare in lowercase, because the build may run on a filesystem where
`C/` is `c/`. A `public/c.txt` is not affected.

The scan does not cover this package's own files, and it does not cover the
output the build writes. Pointer data lives under `index/`, so a package cannot
collide with either name. See [Theme overlay](theme-overlay.md#stability) for
the stability tier this amends.

## Bounded record fields

When it writes `all.json`, the build cuts every record to the bounds below. It
also removes control and invisible code points from every text value. A key is
never dropped or reordered. A value that is too long is cut at a character
boundary, and a listed field of the wrong shape becomes `null`. The record keys
`schema`, `name`, `kind`, `ref` and `namespace` are never cut, only stripped of
those code points. `owner` is bounded like an unlisted object under an 8 KiB
budget of its own, so the other unlisted keys cannot displace it.

| Field | Bound |
|---|---|
| `description` | 16 KiB |
| `summary`, `deprecated` | 1 KiB |
| `title`, `license`, `vendor` | 256 B |
| `version`, `revision` | 128 B |
| `created` | 64 B |
| `replacedBy`, `replaced_by` | 512 B |
| `url`, `documentation`, `compatibility`, `repository` | 2 KiB each |
| `support.issues`, `support.chat`, `support.contact`, `support.security` | 2 KiB each |
| `keywords` | 32 items of 64 B |
| `tags` | 128 items of 64 B |
| `authors` | 16 items of 256 B. One string is cut to the same total |
| Any other key | A string 1 KiB, a list of strings 32 items of 256 B, and 8 KiB across all such keys together |

Bounds count UTF-8 bytes. Past the shared 8 KiB, an unlisted value is cut to
what fits, down to `""` or `[]`, and any other unlisted value becomes `null`.
So does an object or list nested more than 16 levels deep.

These code points are removed:

- the C0 controls, DEL and the C1 controls
- U+061C, U+180E, U+200B and U+FEFF
- U+2060–2064 and U+FFF9–FFFB
- the bidirectional overrides and isolates, U+202A–202E and U+2066–2069
- the tag block, U+E0001 and U+E0020–E007F

Tab and line feed stay in `description` and `deprecated`. The zero-width
joiners, the left-to-right and right-to-left marks, and a well-formed flag tag
sequence stay too.

The set matches what `grim`'s plain output escapes, so a record reads the same
either way. The stored enrich entries are cut by the same bounds when `enrich`
ingests them, so a rebuild from the plane gives the same bytes.

## `enrich.json` is no longer written {#enrich-json}

Earlier releases published `enrich.json`, a checkpoint of the sidecars. This
release does not write it, whatever `sync.legacy` says, and nothing reads it.
`enrich` starts from the enrich plane instead. A copy committed to an index
repository is inert and can be deleted.

## `public/` is three layers

Later wins: this package's own defaults, then your repo's `public/`, then
whatever the data compile already wrote into the output directory. That last
layer is why `all.json` survives Astro emptying `dist/` before it builds.

## Base paths

A site on project Pages is served from a subdirectory, and `site` is the only
place that fact is recorded. Its path becomes the build's base prefix — which
covers everything Astro emits itself, and reaches hand-written URLs through
`withBase()`. A domain-rooted site yields `/`, so nothing about it moves.

If you write site-root URLs in a page you added, pass them through
`withBase()` from `@grim/lib/base` or they will 404 on a subpath deployment.
`nav` and `footerLinks` hrefs are prefixed for you.
