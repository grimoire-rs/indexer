# The `stats.json` sidecar

An index may publish `stats.json` beside `all.json`. It carries per-artifact
signals that are not part of a package's own metadata — today three: `rating`,
the upvote count on the forge thread that owns that artifact; `downloads`, how
often the artifact was pulled; and `updated`, when that artifact last moved. It
is the read contract every client shares: `grim`, this renderer, and the VS Code
extension all read the same file, and none of them writes it.

The build publishes the document twice. `stats.json` is the frozen path, and it
exists while `sync.legacy` is true. The same bytes also sit in a gzip blob at
`c/f/sha256/<digest>.json.gz`. `c/root.json` names it in its `stats` field, with
the digest and size of the inflated JSON. The root's `stats` is `null` when the
build has no stats. See [Output layout](output-layout.md#the-root).

```json
{
  "schema_version": 1,
  "generated_at": "2026-08-18T09:30:00Z",
  "providers": {
    "rating": "github",
    "rating_host": "api.github.com",
    "downloads": "artifactory",
    "updated": "indexer"
  },
  "entries": {
    "ghcr.io/acme/code-review": {
      "rating": {
        "up": 12,
        "target": "DIC_kwDOAbc123",
        "url": "https://github.com/acme/index/discussions/42"
      },
      "downloads": {
        "total": 8241,
        "versions": { "1.2.3": 7100, "1.1.0": 1141 },
        "as_of": "2026-09-10T12:41:37Z"
      },
      "updated": { "at": "2026-07-01T10:00:00+00:00" }
    }
  }
}
```

| Key | Type | Meaning |
|---|---|---|
| `schema_version` | int | Monotonic. Currently `1`. |
| `generated_at` | string | RFC 3339, UTC. When no ratings job ran, the newest `updated` across the index's packages, or the Unix epoch when none of them parses. |
| `providers` | object | Which backend produced each signal, keyed by stat name. `providers.rating` is `"github"` or `"gitlab"`. |
| `providers.rating_host` | string | The forge host those threads live on — host authority only (`host` or `host:port`), no scheme and no path. Derived from the GraphQL endpoint the tally run actually used, so a GHES or self-managed GitLab index publishes its own instance with no extra configuration. Absent ⇒ the consumer's built-in default for `providers.rating`. |
| `entries` | object | Keyed by artifact ref, **exactly as that ref appears in `all.json`**. |
| `entries[ref]` | object | One key per signal. |
| `entries[ref].rating.up` | int | Upvotes, `0` included. A thread that exists but has no votes is published as `0`, so its `url` is there to vote at. |
| `entries[ref].rating.target` | string | The forge's own id for the thread. **Opaque.** |
| `entries[ref].rating.url` | string | Where a human goes to vote. **Opaque.** |
| `entries[ref].downloads.total` | int | Every pull the producer could attribute to the artifact, releases and channel tags alike. |
| `entries[ref].downloads.versions` | object | Optional. Per-release counts, keyed by the **release tag exactly as it appears in that artifact's `tags`**, so a client looks one up directly. A floating tag (`latest`, `1.35`) is deliberately absent: it aliases a release whose count is already here, and a figure of its own would read as a second, separate one. Absent ⇒ no release carried a count. |
| `entries[ref].downloads.as_of` | string | RFC 3339, UTC. When the counters were read. |
| `entries[ref].updated.at` | string | RFC 3339. When the artifact last moved. |

`target` and `url` are opaque: no client parses one and no client constructs
one. They differ per forge and may change shape without a `schema_version`
bump, which is exactly what "opaque" buys.

**`rating_host` is the one `providers` key that is not carried forward.**
Every other key survives a run that did not produce it; this one is
replaced or dropped on each tally, because it names an endpoint a consumer
will send a credential to and a seeded value may describe an instance the
index no longer uses. Consumers apply their own rules to it — `grim`
accepts it only as a bare host, refuses a loopback form from a remote
index, and requires `--token-host` before it will send an injected
credential there.

**`entries[ref]` is a bag of stats, not a record.** A ref may carry `updated`
and no `rating`, or the reverse. A further signal arrives as a sibling key
with a sibling entry in `providers`; that is additive and needs no version
bump.

`downloads.versions` does not sum to `downloads.total`, and that is not a bug.
A pull of a tag no release owns — a channel tag like `canary`, or a tag the
publisher has since moved — is real traffic with no release to attribute it to,
so it counts toward the total and gets no row. Treat `total` as the figure and
`versions` as the breakdown of the part that could be attributed.

Some fixtures under `test/ratings/fixtures/` carry a `stars` key. It is there as
an *unknown* key — the thing a reader must carry forward without understanding —
and is **not a specification**. No producer writes it, its shape is not fixed,
and a client must not code against it.

## Absent is first-class

Five distinct levels of absence. None of them is an error, a warning above
`debug`, or a failed build:

| Absent | Means |
|---|---|
| The file (404) | This index publishes no stats |
| `entries` | Nothing is rated yet |
| A ref within `entries` | That artifact has no stats at all |
| `rating` on a ref that is present | No rating thread exists for it — not the same as a thread with `up: 0`. Any other stat on that ref is unaffected |
| `downloads` on a ref that is present | Nobody measured this artifact's pulls — **not** that nobody pulled it. Most registries expose no counter at all, so this is the normal case rather than the exception, and a consumer must never render it as `0` |
| `rating` on a rendered catalog entry | Unrated. No consumer may assume the field is there |

## Reading a document you do not fully understand

A client that understands version *N* accepts any document declaring `≤ N`,
ignoring fields it does not know. A document declaring `> N` may degrade to
"no rating", but must never be a parse error. So fields are added and never
repurposed, and `schema_version` rises only when an existing field changes
meaning.

`test/ratings/fixtures/` holds one document per rule above — the minimal valid
v1, unknown fields at two levels, an unrecognised `providers.rating` value, the
absence levels, and a document from the future. They are the reference
documents for every client's parser tests, in this repository and outside it.

## Producing it

`updated` needs no configuration and no forge. `enrich` already runs `describe`
per package, so it writes the date into the sidecar — the artifact's own
`created` (a commit date, so a re-publish of the same commit keeps the same
answer) or, for an artifact published outside a repository, the first build
that saw its current digest. `build` joins that onto the document it
publishes. An index that runs `enrich` gets it whether or not it wants
ratings.

`rating` and `downloads` are each opt-in, and each has its own block in
`index.config.json`. Re-render CI (`npm run ci`) after adding one; without the
block nothing is collected.

```jsonc
"ratings": {
  "provider": "github",   // "github" | "gitlab"
  "container": "Ratings", // GitHub: Discussions category. GitLab: work item type.
  "createBudget": 400,    // threads created per run; default 400
  "lockThreads": false    // default FALSE - a locked thread cannot be voted on
}
```

`provider` and `container` are required; the other two have the defaults shown.
Unknown keys are ignored. There is deliberately **no `botIds` key** — the
author allowlist is `index-policy.json`'s `trustedBots[].id`, and a second copy
of the same ids in a second file is a consistency hazard rather than a
convenience.

`lockThreads` defaults to `false`, and did not always. A lock looks like the
low-moderation default — a rating signal without a comment forum to moderate —
but on GitLab it also stops the voting. The work-item UI draws the thumbs-up
control on a locked item and ignores the click, guarding on `discussionLocked`
without sending the mutation, while REST and GraphQL both accept a reaction on
that same item and read it back. So nothing warns you: the tally runs, the
threads look healthy, and every one of them is unvotable by the only means most
people have.

Setting it costs nothing in marker authority — R-1 reads the thread body and
never a comment, so a reply cannot forge a marker either way. Turn it on if you
would rather moderate nothing and have checked that your forge still lets a
human react; GitHub Discussions are untested here.

`downloads` needs Artifactory. No forge publishes a container download counter
at all — GHCR shows exact per-version figures on its HTML package page and in
no API, GitLab has none either — so this is a backend for a self-hosted index
whose artifacts live on Artifactory, and scraping a web page was rejected as a
data source. An index on `ghcr.io` gets no `downloads` key, and that absence is
how the feature stays off.

```jsonc
"downloads": {
  "baseUrl": "https://artifactory.example.com/artifactory",
  "oidcProvider": "github-grim"  // optional; GitHub only
}
```

`baseUrl` is the Artifactory **REST** root and is required, https only. It is
the only host the collector ever dials: the Artifactory repository key and the
image path are both derived from each ref, so there is no map to configure and
nothing contributor-supplied ever becomes a URL. A ref on the `baseUrl` host is
read with Artifactory's *repository path* method
(`artifactory.example.com/<repo-key>/<image>`); a ref on any other host with the
*sub domain* method (`<repo-key>.registry.example.com/<image>`), and is skipped
when that first label names no repository the credential can read — which is
how a ref on `ghcr.io` stays out of the count. A run in which **no** ref
resolves fails rather than publishing a sidecar that claims Artifactory counted
nothing.

The credential comes from the job, never from this file. With `oidcProvider`
set, the generated GitHub job exchanges the workflow's own id-token for a
short-lived Artifactory token — create the identity mapping in the JFrog
platform under Administration → Identity and Access → OIDC and name it here.
Without it, the job reads `GRIM_DOWNLOADS_TOKEN` from a secret. GitLab always
takes the secret route. Either way the token needs **read** and nothing more:
`stat.downloads` is not admin-gated.

Grant that read on every repository the index lists. A missing read permission
is silent in Artifactory's AQL — it answers `HTTP 200` with no rows and no
error, which is indistinguishable from "nothing has been pulled yet" — so the
collector cross-checks `GET /api/repositories` and fails the run rather than
publishing a zero that looks like a fact.

Re-rendering with either block present adds a job to the generated pipeline
(`stats` on GitHub, `grim-indexer:stats` on GitLab). It also adds an hourly
schedule and a seed step in the deploy. The seed step is what keeps a failed
collector from emptying a published stat. It runs `grim-indexer stats-seed`,
which reads the stats the site currently publishes and carries them forward per
stat key. It fails the job rather than treating an unreadable seed as an empty
one.

### Seeds read through the root

Every seed reads `<site>/c/root.json` first, then the stats blob it names, and
checks the blob's digest and size over the inflated bytes. The `ratings` and
`downloads` collectors seed the same way, so a site with `sync.legacy: false`,
which serves no `stats.json`, seeds too. A shell fetch of `/stats.json` would
read that 404 as a first run and publish with every rating gone.

| What the seed finds | Result |
|---|---|
| A root that names a stats blob | The blob is the seed. A blob that cannot be read fails the seed with exit 69. One that does not inflate, verify or parse fails it with exit 65 |
| A root 404, or a valid root with `stats: null` | The seed falls back to `<site>/stats.json`. A 404 there too means nothing is published yet, and the seed is empty |
| A root that cannot be read by any answer but 404 | The seed fails with exit 69 and publishes nothing |
| A 200 answer that is not a valid root | The seed fails with exit 65 |

An on-disk `.stats.json` from an earlier producer in the same job still wins.
Each collector writes a whole fresh document, so the second one seeds from the
file the first left, never from the site. See
[`stats-seed`](cli.md#grim-indexer-stats-seed) for the flags and exit codes.

**One job for both collectors, not one each**, and that is correctness rather
than thrift. Each collector writes a *whole fresh* document seeded from the
published one, so two jobs both seeding from the published copy would each drop
the other's key. In one job they run in series and each seeds from the file the
one before it left.

## Turning it off

Two steps, and the first alone is not enough:

1. Remove the `ratings` (or `downloads`) block and re-render CI. That stops the
   collection.
2. **Delete the published `stats.json` from the deploy.** Until it is gone the
   last document keeps being served, frozen, forever.

After both, clients read a 404 and every artifact shows as unrated on its next
refresh — unless the index still runs `enrich`, in which case the next build
republishes a `stats.json` carrying `updated` and nothing else. The sidecar is
never committed — it is a build input the deploy publishes — so there is no
history to unwind either way.

## The enrichment state

`enrich` skips work by digest. Every comparison reads a package's entry from
the enrich plane. The scaffolded CI commits nothing, so `enrich/` is empty on
every run. Without the plane, every deploy would download every README,
changelog, logo and payload again. It would also re-date every artifact that
carries no `created` of its own.

So `enrich` starts from the plane the live site publishes. It reads
`<site>/c/root.json` and takes `planes.enrich`. It loads the plane index and the
shards from the blob store in `.grim-index-state/b` when that holds the digest.
Otherwise it fetches them from `<site>/c/p/` and `<site>/c/s/`. Every file is
checked by sha256 and size. `build` publishes the plane `enrich` hands off, so
the next run finds it.

Unlike `stats.json`, **this is not a read contract.** Nothing outside this
package reads the plane. Its shape may change without notice, and no client
should code against it.

Failure is never fatal. A shard that is missing or fails its check makes only
its bucket cold, and its packages are enriched in full. A root that cannot be
read, or a `site` that is unset or not https, makes the whole run cold. A cold
run does the full download it would have done anyway. A package whose stored
files are missing from the blob store is enriched in full too. A stale flag
therefore never stands in for a file that is gone.

A warm run makes two probe calls per due package. A new or cold package costs
three calls. A changed warm package costs five: its two probes, then three more
for the full path. See [`enrich`](cli.md#grim-indexer-enrich) for the buckets,
the backoff and the time budget.
