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
| `--forge <forge>` | `github` or `gitlab`: the CI to scaffold. Without it, `init` keeps the forge in `index.config.json`, then reads it off the repo URL, then falls back to `github` |
| `--with-skills` | Scaffold the combined layout: this repo holds its skills and its index |
| `--publish <when>` | `never`, `tag` or `default-branch`: when CI publishes this repo's own packages. Implies `--with-skills`, and defaults to `tag` in that layout |
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

`dev` is offline, like `build`: it makes no request. It publishes the root and
the enrich plane from the hand-off `enrich` left, with no retained files. It
never removes `/all.json`, so the preview searches over it whatever
`sync.legacy` says.

Without `--host` the server binds loopback only, which is Astro's own default.
That is unreachable from a dev container, a VM or a WSL guest: the port forwards
and the connection then hangs against a socket that is not listening for it.

!!! warning "`--host` puts the preview on your network"
    Bare, it binds every interface, so anyone who can reach your machine can
    read the site — and a dev server serves the index repo it is pointed at.
    Name an address (`--host 127.0.0.1`, or the guest-facing one) where that
    matters.

## `grim-indexer build`

Compile `index/**` and render the site into `dist/`. **Offline:** it makes no
network request, and it reads only the checkout and the hand-off.

| Flag | Effect |
|---|---|
| `--out-dir <dir>` | Output directory (default `dist`) |

See [Output layout](output-layout.md) for what it writes.

The hand-off is what `enrich` leaves in `.grim-index-state/out/`. It holds the
enrich plane, the root's generation, the counters for the log line, and the
files of the previous root to [retain](output-layout.md#retained-files). `build`
checks every file it copies.

With no usable hand-off it warns. That covers `ci.enrich: false`, an `enrich`
that failed before handing off, and a fresh checkout. The build then publishes
with `planes.enrich: null` and takes the generation from the build clock:

```
warn: no usable hand-off from `enrich` — publishing without an enrich plane
```

It fails with exit 65 when a file in `public/` or `theme/pages/` would publish
under [`c/` or `browse/`](output-layout.md#c-and-browse-are-reserved), and when
`index.config.json` is [invalid](config-schema.md#sync-errors).

Three things reach stderr without failing the build: a `theme/` path the
overlay [refuses](theme-overlay.md#what-the-overlay-refuses), a `theme/` path
that replaces a shipped file (named with the version it replaced), and a `nav`
or `footerLinks` href that [points at
nothing](config-schema.md#a-build-time-warning-never-a-failure).

### The build log line

When `dist/` is final, `build` prints one line to stdout. **It is log text, not a
contract.** A field can be added, renamed or removed in any release. Read it as
a person and never parse it. The sample is illustrative, with round placeholder
sizes.

```
grim-indexer: built layout=anchored legacy=true generation=1792560000 flat sha256=9f2c… bytes=40000000 gzip=7000000 stats sha256=5d9e… bytes=3000000 planes enrich=77b0… retained files=262 skipped=0 probed=17143 deep=2857 calls=42857 probe_ms_p50=300 deep_ms_p50=300 budget_min=85 throttled=0 backoff_refs=0 enrich=complete failed_buckets=0 search=4c1a… search_wire=2000000 site_bytes=700000000 site_files=100000 astro_ms=600000 astro_dir_bytes=500000000 pages_cut=2000 pages_hard_cut=20
```

| Field | Meaning |
|---|---|
| `layout`, `legacy`, `generation` | The resolved `sync` block and the root's generation |
| `flat` | Digest, inflated size and gzip size of the catalog. Reported in every layout |
| `stats` | Digest and size of the stats blob. `-` and `0` when there is none |
| `planes enrich` | Digest of the enrich plane index. `-` when there is none |
| `retained` | Files staged from the previous root, and files skipped |
| `probed`, `deep`, `calls` | Packages probed, packages enriched in full, and `grim` calls in the `enrich` run |
| `probe_ms_p50`, `deep_ms_p50` | Median latency in milliseconds of a probe call and of a full-enrichment call |
| `budget_min` | The time budget that `enrich` run had, in minutes |
| `throttled` | Registry answers of HTTP 429 |
| `backoff_refs` | Refs waiting out a failure backoff |
| `enrich` | `complete`, `budget` (the time budget ran out), or `none` (no hand-off) |
| `failed_buckets` | Buckets left out of the plane because a shard would not fit 2 MiB |
| `search`, `search_wire` | Digest of the site's search file and its gzip size. `none` and `0` when there is none |
| `site_bytes`, `site_files` | Total size and number of files in `dist/` |
| `astro_ms`, `astro_dir_bytes` | Wall time of the Astro build, and the size of its content cache |
| `pages_cut`, `pages_hard_cut` | Package pages cut to fit the 24 KiB page cap, and those that took the hard cut |

`deep_ms_p50` is the figure to read when you estimate a cold build, since a
cold build is all full-enrichment calls.

Each warning below goes to stderr on its own line. They never change the exit
status, which stays 0:

- a state file of 12 MiB or more (a state file is capped at 16 MiB);
- files of the previous root that the stage skipped;
- `all.json` at 80% of `grim`'s 128 MiB body cap, or 80% of 100,000 entries.
  Above either limit the line starts `error:` and the build still exits 0;
- `sync.legacy: false` with `site` unset or `ci.enrich: false`;
- `enrich=budget`, or any `throttled` answer;
- a budget under 85 minutes because the job timeout is short:
  "re-render required" (see [`enrich`](#grim-indexer-enrich)).
- a search file of 6 MiB or more gzipped. At 8 MiB the line starts `error:`;
- a site of 800,000,000 bytes or 160,000 files, which starts `error:`;
- a package page still over its cap after the hard cut, one line each.

## `grim-indexer enrich`

Refresh `enrich/**` from the registry: READMEs, changelogs, logos, versions,
tag lists, and the curated annotations grim reports (`revision`, `authors`,
`vendor`, `url`, `documentation`, `compatibility`, and the repository's
`support` channels).

A logo is kept only when it is a PNG, JPEG, WebP or GIF and its file extension
matches its bytes. An SVG, or any other file, is dropped and the package has no
logo.

**The online step of the build chain, and the only one that needs `grim` on
`PATH`.** It reads the registry and the published site. `state-key` and
`stats-seed` read the published site too, and `ratings` and `downloads` call
their forge or Artifactory. `build` and `dev` make no request.

**It needs grim 0.9.0 or newer, and 0.15.0 or newer when the repository has a
`marketplace.toml`.** `enrich` runs `grim --version` before any registry call
and exits 69 naming the binary when it is older. `grim-indexer ci` refuses a
`ci.grimVersion` pinned below 0.9.0.

| Flag | Effect |
|---|---|
| `--grim <path>` | Which grim binary reads the registry (default `grim`) |
| `--seed` | Start from the state published at `<site>`; this is the default whenever `site` is set, so the flag changes nothing |
| `--concurrency <n>` | Packages refreshed at once (default `8`, whole number of 1 or more; anything else exits 64) |
| `--fresh` | Ignore the published state: no entries, an empty blob store, every package enriched again with three calls. The generation still counts up from the published root. Starts a new state epoch (see [`state-key`](#grim-indexer-state-key)) |
| `--purge <ref>`, `--purge <sha256>` | Remove cached data and rebuild what held it (below), under a new state epoch. Anything but 64 lowercase hex characters or a `<host>/<repository>` ref exits 65 before the first request |

With a `marketplace.toml` at the repository root, `enrich` also runs `grim export marketplace` on it into `enrich/marketplace/export/` and writes `enrich/marketplace/meta.json`, which the site reads to render the marketplace. Past the version check it never fails the run: a failed export keeps the previous one and warns, and a `marketplace.lock` the export had to rewrite warns that it was stale. See [Marketplace](config-schema.md#marketplace) for the three site modes.

**Where it starts.** `enrich` reads `<site>/c/root.json` and restores from the
enrich plane that root names. It needs a `site` that `index.config.json` sets
itself and that is https, or http on a loopback host. Without one it warns and
every build is cold. A root it cannot read also builds cold and never fails the
run. A first deploy has no root yet, and the 404 is silent.

**Probe first, by bucket.** The pointers fall into 256 buckets by a hash of their
`ref`. Each bucket is checked once per `sync.revalidate` window (default 1 h).
The windows are staggered, so the buckets do not all fall due together. A bucket
is checked again whenever its pointers change.

A ref in a due bucket costs two cheap `grim fetch --digest-only` calls. If the
artifact digest, the description-companion digest, the pointer and the enricher
version all match what the entry was built from, nothing else happens.

Otherwise the ref takes the full path of three calls: `describe`, the
description companion and the contents. A moved digest gets there after its two
probe calls, five calls in all. A ref new to the index, and a ref whose files
are missing from the blob store, skip the probe and cost three.

Every bucket also gets a full pass once per rotation: seven windows, at most
seven days. A change no digest shows, such as a support link edited without
republishing, lands within that time. One package failing keeps its old sidecar
and never stops the others.

**A failing ref.** It keeps its last data and waits before the next attempt. The
wait is `sync.revalidate` after the first failure, doubles each time, and never
exceeds the rotation period. Its bucket is still stamped, so the other refs in
it are not held back. After 30 days of failing without a success, the ref falls
back to its pointer fields (no title, summary or README). `enrich` warns naming
it, and the next success restores it.

When half or more of the refs a build tried failed, the build was an outage
rather than a set of bad packages. Nothing is backed off, and the 30 days do not
run. No bucket holding a failed ref is stamped, so all of them are tried again
next build. The run exits 69 only when more than half of all the packages
failed.

**Bounds.** What `describe` reports is cut to the same per-field limits `all.json`
applies before it is stored, so one oversized payload cannot grow the state. A
bucket whose stored state would pass 2 MiB sheds the entries with the most data
down to pointer fields. They count as failures, and `enrich` warns naming them.
The run still deploys.

**Time budget.** `enrich` starts no new ref past 85 minutes, or past the job
timeout minus 35 minutes when `CI_JOB_TIMEOUT` (seconds) is set. The earlier
limit wins. `enrich` hands off what it reached. The buckets it left run first
next time, so a first build converges over several runs at any registry
latency. A job timeout under 120 minutes shortens the budget, and `enrich` warns
"re-render required". Render the CI again so the job gets its full timeout.

**Purging data.** `--purge <sha256>` drops that blob from the blob store.
`--purge <ref>` drops the blobs the ref's entry names. Either way, every ref
whose entry named a dropped blob is enriched again with the full three calls.
That happens before anything else, whatever the ref's failure backoff and
whatever is left of the time budget. A ref that fails that second time falls
back to its pointer fields at once, so nothing purged is kept. It is tried again
on the normal schedule. The sidecar is rewritten, so the ref's entry in
`all.json` and its search row follow it. A purge that names nothing in the
pointer walk warns and exits 0.

## `grim-indexer validate`

The contribution gate. **Exit 0 means eligible for auto-merge**; any non-zero
means manual review.

| Flag | Effect |
|---|---|
| `--root <dir>` | Trusted base checkout — the committed state |
| `--pr-tree <dir>` | Checkout of the PR head, read as data only |
| `--policy <file>` | Path to `index-policy.json` |
| `--changed-from <file>` | Read the changed paths from a file, NUL- or newline-separated, instead of from the command line. CI uses this |
| `--forge <forge>` | `github` or `gitlab`: the forge hosting the contribution. Without it, `validate` reads `GITHUB_ACTIONS` or `GITLAB_CI`, and exits 64 when neither is set |
| `--author-login`, `--author-id` | The contribution author's forge identity |

Every changed path must be `index/<host>/<namespace…>/<pkg>/metadata.json`.
Anything else — including anything under `theme/` — means manual review.

A pull request that adds a `ref` another pointer already holds also means manual
review, and the reason names the pointer that holds it. The comparison ignores
case, tag and digest. It counts the base checkout and the other new pointers in
the same change. Updating a pointer that already shares its ref is not adding
one. `all.json` and the pages keep every pointer, so a duplicate is a decision
for a maintainer. The enrich plane keeps only the last in path order.

```
index/github.com/acme/tool/metadata.json: ref "reg.example.com/acme/tool" is already held by the pointer index/github.com/acme/other/metadata.json — manual review
```

## `grim-indexer ci`

Render this repo's CI from the `ci` block of `index.config.json`.

| Flag | Effect |
|---|---|
| `--check` | Verify the committed CI matches the config; exit 65 on drift |

`--check` is what the generated `verify-ci` job runs on every push, and it is
what keeps a hand-edit from silently forking the pipeline.

The `@grimoire-rs/indexer` version in `package-lock.json` decides which CI is
rendered. A new release reaches an index only when you bump the lock, run
`npm run ci` and commit the result, and until then `--check` passes.

Only the Pages `build` job uses the Actions cache. On github.com every other
job sets `cache-mode: none`. The renderer reads that from `repoUrl` (a
github.com repository) or `site` (a `github.io` address). Any other host gets
no `cache-mode` line, because GitHub Enterprise Server does not know the key.
On GitLab, merge request jobs run with `cache: []` and every job times out
after two hours.

Once the site is live, the generated CI also runs [`probe`](#grim-indexer-probe)
against it. The probe only warns about a wrong content type, so it cannot fail a
deploy that already happened. On GitHub it is the `probe` job. It needs `deploy`,
takes the URL from the deploy job's `page_url` output, and sets
`continue-on-error`. On GitLab it is the `grim-indexer:probe` job in the
`deploy` stage, with `allow_failure`, run against `$CI_PAGES_URL`. Neither job
uses a cache. Both run the locked copy, so a `package-lock.json` that predates
`probe` fails that job and nothing else.

Unless `ci.enrich` is `false`, the generated deploy also keeps the build state
between runs. Only the default branch restores or saves it. See [Upgrade
notes](../ops/upgrade-notes.md#the-build-state-cache) for the keys and for
clearing a bad entry.

- **GitHub.** `state-key` prints the key, and the job restores exactly
  `grim-index-state-v1-<key>` with no fallback key. After `enrich` it reads
  `state-key --next` and saves the blob store under that key when no entry
  holds it. A failed run saves nothing.
- **GitLab.** The `pages` job uses the fixed key `grim-index-state-v1` with
  `pull-push`, on the default branch only.
- **Manual runs.** GitHub's `workflow_dispatch` takes `fresh` and `purge`
  inputs. GitLab's "Run pipeline" page takes `GRIM_INDEX_FRESH` and
  `GRIM_INDEX_PURGE`. They add `--fresh` and `--purge` to `enrich`. An invalid
  value exits 65 and fails the job, so a mistyped purge never deploys the data
  it was meant to remove.
- **Time budget.** The build job times out after 120 minutes. `enrich` budgets
  itself against `CI_JOB_TIMEOUT`, which GitLab sets and the GitHub job
  renders beside `timeout-minutes`.

## `grim-indexer ratings`

Tally the forge's upvote counters into `.stats.json`. Needs the `ratings`
block in `index.config.json`. The build publishes the result as `stats.json`
beside `all.json`.

Ratings are additive and absent-by-default: an index that publishes no sidecar,
a ref the sidecar omits, and a ref carrying other stats but no `rating` are the
same absence, and none of them is an error.

## `grim-indexer downloads`

Count Artifactory's own per-artifact download counters into `.stats.json`. Needs
the `downloads` block in `index.config.json`, and a credential in the
environment — `JF_ACCESS_TOKEN` (what `jfrog/setup-jfrog-cli` exports, OIDC
included) or `GRIM_DOWNLOADS_TOKEN`. Read on the listed repositories is the
whole permission: `stat.downloads` is not admin-gated.

Absent-by-default on the same terms as `rating`, and it matters more here — no
forge publishes a container download counter at all, so for most indexes the key
is on no package. An absent count means **nobody measured**, never that nobody
pulled: the command publishes no key rather than a zero.

It fails the run (69) rather than publishing an absence when the credential
cannot read a listed repository, or when no ref resolves to a readable
repository at all. Artifactory's AQL answers `HTTP 200` with no rows and no
error in that case, which is indistinguishable from "nothing has been pulled
yet", so the repository list is checked first.

Runs ahead of `ratings` in the generated `stats` job and leaves `.stats.json`
for it to seed from. See [the sidecar reference](stats-sidecar.md) for the
published shape and for why both collectors share one job.

## `grim-indexer stats-seed`

Carry the published stats into `.stats.json` when no collector left one. The
generated deploy runs it ahead of the build, so a failed or skipped `stats` job
republishes the last document instead of none.

It reads the stats blob that `<site>/c/root.json` names and checks its digest and
size. It reads `<site>/stats.json` only after a root 404, or a root that names no
stats. `ratings` and `downloads` seed the same way. Needs an explicit https
`site`.

An existing `.stats.json` is left alone. Nothing published yet writes nothing
and exits 0. An unreadable root or blob exits 69. A 200 answer that is not a
valid root, a blob that does not verify or parse, and a missing or non-https
`site` exit 65. None of them writes a file, so the deploy fails rather than
publish a site with its stats gone.

## `grim-indexer state-key`

Print the cache key of the build state: one line, `<epoch>-<blobs>`, on stdout
and nowhere else. The generated CI runs it before restoring the state cache and
writes the line to the job output. It is built to print nothing when anything is
wrong.

The generated CI calls it as `npx --no grim-indexer state-key`. `--no` makes
npx run the locked copy and never fetch one. The call also works in a
repository whose `package.json` predates the command and has no script for it.

| Flag | Effect |
|---|---|
| `--next` | Print the key of the state `enrich` handed off, read from `.grim-index-state/out/handoff.json` with no request. CI saves the cache under it |

Without `--next` it reads `<site>/c/root.json`, then the enrich plane index the
root names, and checks the index against the root's digest and size. `<epoch>`
is the plane's `state_epoch`, and `<blobs>` is its `blobs` digest. Both reads
bypass edge caches and refuse a redirect, an HTML answer and a body over the
cap. Needs an explicit https `site` (plain http only for a loopback host).

An epoch more than 7 days old is replaced by the current time. The key therefore
changes weekly, and the cold build that follows refreshes everything. `enrich
--fresh` and `--purge` start a new epoch the same way.

When nothing is published yet, it prints the current time and the digest of the
empty blob set, `sha256("")`. That covers a 404 root and a root without an
enrich plane. No saved entry carries that key, so the first build restores
nothing and still saves.

The line is checked against `^[0-9]{1,16}-[0-9a-f]{64}$` before it is printed. An
unreadable root or plane index (no answer, a refused redirect, a non-2xx status,
a digest that does not match) exits 69. A root or index that is not valid, an
epoch that is not a non-negative safe integer, and a missing or non-https `site`
exit 65. None of them prints a key, so the build runs cold and does not save.
`--next` without a usable hand-off exits 69.

## `grim-indexer probe`

Check that a deployed site answers with the content types browsers need. A
static host picks them by file extension, and a wrong one breaks the site in the
browser while every build step still passes.

```sh
npx --no grim-indexer probe https://acme.github.io/index/
```

It takes the site URL as its one argument. A path is kept, so a project site
works as well as a root one. It asks the live site for five things:

- `c/root.json`, as `application/json`;
- the `c/f` blob the root names under `stats`, else `flat`, as
  `application/gzip`, `application/x-gzip`, or `application/json` with
  `Content-Encoding: gzip`;
- the search file the root names under `search`, as the same gzip types;
- one package logo, as the image type its extension names;
- one `/p/<namespace>/<name>/` page, as `text/html`.

The logo and the page are the first ones the search file lists. A
`; charset=…` parameter is ignored when comparing types. Only headers are read
for the logo, the blob and the page, so nothing large is downloaded.

Each problem prints one line on stderr, and the command still exits 0:

```
warn: https://acme.github.io/index/p/acme/tool/: expected text/html, got application/octet-stream
```

These count as a problem:

- a wrong type, or a non-2xx answer;
- no answer within 15 seconds;
- a body over its size cap, or a search file that does not decode;
- a root with no `search` member.

A redirect is followed only while it stays on the site's origin. A redirect to
another origin is a problem and is not followed.

A root that names neither `stats` nor `flat` has no blob to check, and a catalog
with no logo has none to ask for. Both are skipped without a warning.

Only a bad invocation exits non-zero, with 64. That covers a missing or extra
argument, a URL that is not `http` or `https`, and a URL that carries
credentials.

## Exit codes

Aligned with BSD `sysexits.h`, the same way `grim` itself is — semantic codes
start at 64 so they collide with neither the shell-reserved 1–2 nor the
signal-derived 128+.

| Code | Name | Meaning |
|---|---|---|
| 0 | ok | Success. For `validate`: eligible for auto-merge |
| 1 | failure | Generic failure — only when nothing more specific applies |
| 64 | usage | Bad invocation: unknown flag, missing argument, bad enum value |
| 65 | data | Input malformed. See the list below |
| 69 | unavailable | A required resource is missing. See the list below |

Exit 65 covers:

- an unparseable or invalid `metadata.json`;
- an `index.config.json` the loader rejects, the `sync` block included;
- a file in `public/` or `theme/pages/` under `c/` or `browse/`;
- CI drift under `--check`;
- a `--purge` value that is neither 64 lowercase hex characters nor a
  `<host>/<repository>` ref;
- a published root, plane index or stats blob that does not parse or verify;
- a `site` that is missing or not https where a command needs one.

Exit 69 covers:

- `grim` absent or too old;
- more than half the packages failing in `enrich`;
- a published root or blob that cannot be read;
- `state-key --next` with no usable hand-off.
