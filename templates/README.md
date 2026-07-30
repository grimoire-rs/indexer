# {{title}}

A [Grimoire](https://github.com/grimoire-rs/grimoire) package index - a
static site listing the skills, rules, agents, mcp servers, and bundles
available in `{{registryHost}}`, served at {{baseUrl}}.

## Layout

| Path | Purpose |
|---|---|
| `index/<host>/<namespace>/<package>/metadata.json` | One entry per package - the source of truth |
| `index.config.json` | Site identity, branding, and the `ci` block the workflows are rendered from |
| `index-policy.json` | Committed allowlist of registry hosts contributions may point at |
| `package.json` / `package-lock.json` | The renderer this index runs, pinned |
| `dist/` | Build output (`all.json`, per-path copies, the rendered site) - not committed |

## Getting set up

```sh
npm install
```

That is the whole toolchain. `package-lock.json` pins the exact renderer this
index builds, validates and deploys with - commit it, because CI installs from
it with `npm ci` and nothing is resolved on the runner.

## Everyday workflow

| Command | What it does |
|---|---|
| `npm run dev` | Serve the index locally with a live preview |
| `npm run build` | Compile `index/**` into `dist/` and render the site |
| `npm run validate` | Run the contribution gate over changed paths |
| `npm run enrich` | Refresh READMEs, logos and version lists from the registry (needs `grim`) |
| `npm run ci` | Re-render the CI workflows from `index.config.json` |
| `npm run ci:check` | Fail if the committed workflows have drifted from the config |

### Review a change locally

```sh
npm run dev
```

`dev` prints the URL to open once it is up - the site exactly as it deploys.
A domain-rooted `site` serves at `http://localhost:4321`; a project-Pages
`site` (`https://<owner>.github.io/<repo>`) serves under a `/<repo>` path
segment instead, because that is Astro's `base` for that layout too.

Entries under `index/` and the settings in `index.config.json` are read once,
at start-up, so restart after editing them. The dev server renders through the
same code path `npm run build` does: what you see is what deploys.

### Test a contribution before you open the pull request

`validate` is the same gate CI runs, and the same exit-code contract - 0
means eligible for auto-merge, non-zero means a maintainer takes a look -
but CI reads the forge identity and the PR tree off the platform, so a
local run has to supply them by hand:

```sh
npm run validate -- \
  --root . --pr-tree . \
  --forge github --author-login <your-github-login> --author-id <your-numeric-id> \
  -- index/<host>/<your-namespace>/<your-package>/metadata.json
```

`--root` and `--pr-tree` both point at your own checkout here; CI points
them at two different checkouts (the trusted base and the PR head) so it
can also catch a re-registered login trying to inherit someone else's
package - fine to collapse for a solo sanity check, not something CI does.
`--author-id` is your numeric forge account id, not your login - find yours
at `https://api.github.com/users/<your-github-login>`. The gate makes real
calls to the forge API and to the registry, so it needs network access and
an entry that is actually yours to pass.

## Contributing a package

Add `index/<host>/<your-namespace>/<your-package>/metadata.json` (`<host>`
is the forge this repo is hosted on, e.g. `github.com`), then open a pull
request.

```json
{
  "schema": 1,
  "name": "{{name}}-example",
  "kind": "skill",
  "ref": "{{registryHost}}/{{registryAlias}}/skills/{{name}}-example",
  "description": "One line describing what this package does.",
  "owner": { "id": 12345678, "github": "your-github-login" }
}
```

The directory name must equal `name`, and `kind` is one of `skill`,
`rule`, `agent`, `mcp`, `bundle`. `ref` names a repository, not a tag or
digest - the gate resolves it to whatever is published. `owner.id` must be
your real numeric GitHub account id, not the placeholder above - find yours
at `https://api.github.com/users/your-github-login`; the gate checks it
against the forge, not the `github` login, since a login can be
re-registered by someone else.

## CI

This repo owns and runs its own CI: the workflow files are committed here, not
called from anywhere else. They are *rendered* from the `ci` block of
`index.config.json`, so the way to change what CI does is to change the config
and run `npm run ci`.

| Key | Default | What it changes |
|---|---|---|
| `forge` | `github` | Which pipeline is rendered - `github` or `gitlab` |
| `nodeVersion` | `22` | Node the jobs run on, and the GitLab image tag |
| `enrich` | `true` | Pull READMEs, logos and version lists from the registry before building |
| `grimVersion` | `latest` | grim release the enrichment step uses |
| `autoMerge` | `false` | Squash-merge a pull request the gate passed, then deploy (GitHub only) |
| `allowManualEdits` | `false` | Own the files by hand; drops the drift guard |

`autoMerge` is off until you turn it on: merging an untrusted contribution
unattended is your policy to set, not this package's to assume. It is GitHub
only, and that is not an oversight - GitHub always runs the base branch's copy
of a `pull_request_target` workflow, so the gate a pull request faces is one it
cannot edit. On GitLab the merge request supplies its own `.gitlab-ci.yml` and a
fork's pipeline runs in the fork, so an auto-merge there would act on a verdict
the contributor wrote. Setting `autoMerge` with `forge: gitlab` is refused
rather than rendered inert.

A `verify-ci` job re-renders and diffs on every change that can produce
drift - pushes and pull requests touching `index.config.json`,
`package.json`, `package-lock.json`, or `.github/workflows/**` - so a
hand-edit fails CI instead of silently forking. Action pins are excluded
from that diff, so Renovate may bump `uses: owner/action@<ref>` freely.

To pick up renderer fixes, bump `@grimoire-rs/indexer` the ordinary npm way and
re-render:

```sh
npm update @grimoire-rs/indexer
npm run ci
```

No CI *definitions* are fetched from outside this repo - no reusable
workflow, no remote `include:` - so what you review in a diff is exactly
what runs. The jobs themselves still reach the network: `npm ci` from the
npm registry, `uses: actions/...@<sha>` from GitHub, and - with `enrich`
on - a grim release tarball.
