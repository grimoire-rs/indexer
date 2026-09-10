# The `stats.json` sidecar

An index may publish `stats.json` beside `all.json`. It carries per-artifact
signals that are not part of a package's own metadata — today three: `rating`,
the upvote count on the forge thread that owns that artifact; `downloads`, how
often the artifact was pulled; and `updated`, when that artifact last moved. It
is the read contract every client shares: `grim`, this renderer, and the VS Code
extension all read the same file, and none of them writes it.

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
| `generated_at` | string | RFC 3339, UTC. |
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
image path are both derived from each ref (the first path segment and the rest),
so there is no map to configure and nothing contributor-supplied ever becomes a
URL. A ref on some other host is skipped.

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

Re-rendering with either block present adds one job to the generated pipeline
(`stats` on GitHub, `grim-indexer:stats` on GitLab), an hourly schedule, and a
seed step in the deploy. The seed step is what keeps a failed collector from
emptying a published stat: it reads the currently published `stats.json` and
carries it forward per stat key, and it fails the job rather than treating an
unreadable seed as an empty one.

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

## The enrichment checkpoint

`enrich` skips work by digest, and every one of those comparisons reads
`enrich/<namespace>/<name>/data.json` off disk. The scaffolded CI never has
that file — the sidecars live only in the deploy job's workspace and are
committed nowhere — so without help every deploy re-downloads every README,
changelog, logo and payload, and re-dates every artifact that carries no
`created` of its own.

So `build` publishes `enrich.json` beside `all.json`, and
`grim-indexer enrich --seed` reads it back from `<site>/enrich.json` before
refreshing. The live site is the checkpoint, the same arrangement the ratings
sidecar already uses. The generated CI passes `--seed`; re-render with
`npm run ci` to pick it up.

Unlike `stats.json`, **this is not a read contract.** Nothing outside this
package reads it, its shape may change without notice, and no client should
code against it.

Failure is never fatal: an unreachable, oversized, unparseable or
unrecognised checkpoint warns and seeds nothing, and the run does the full
download it would have done anyway. A checkpoint that disagrees with itself —
claiming a README it does not carry — has the digest that guards that file
dropped, so the next run fetches it rather than trusting a stale flag.

`describe` still runs once per package and is never skipped, so CI still
installs `grim` and still makes one round trip each. The checkpoint saves the
downloads, not the probe.
