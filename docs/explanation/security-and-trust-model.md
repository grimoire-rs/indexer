# Security and trust

Who can cause what to run, and where the gate is.

## Two populations

An index repo has two kinds of change, and they are not trusted alike:

- **Contributions** — a PR adding a package pointer. Untrusted by
  construction: anyone may open one.
- **Repository content** — config, CI, `theme/`, `public/`. Owner territory,
  reviewed the way any change to your own repository is.

## The contribution gate

`grim-indexer validate` runs on every contribution PR, and its exit code *is*
the decision: **0 means eligible for auto-merge, any non-zero means manual
review**. Branch protection reads nothing else.

Its first and cheapest filter is the changed-path list. Every changed path must
be:

```
index/<host>/<namespace…>/<package>/metadata.json
```

Path strings arrive from the forge API and are attacker-chosen, so segments are
charset-checked rather than merely pattern-matched: `..`, empty segments,
absolute paths, backslashes and NUL never survive.

**A PR that touches anything else falls to manual review.** That includes
`theme/`, `index.config.json`, the CI, and `public/` — so a submitted package
cannot add a page, replace a component, or change what the site executes.

Beyond the path check, the gate verifies that the author owns the namespace,
that the registry host is on the committed allowlist in `index-policy.json`,
and that the OCI ref actually resolves.

## What `theme/` means for trust

`theme/` is code, and it executes at build time in your own CI — the same as
your `astro.config`, your CI workflows and everything else in the repository.
The overlay adds no new exposure to contributors, because the path gate above
already refuses those PRs. It does mean:

- Review a `theme/` change the way you would review a workflow change, not the
  way you would review a README.
- The build job's token is available to whatever `theme/` runs. Keep that job's
  permissions minimal.
- A dependency you import from a theme page is a dependency of your build.

The two paths the overlay
[refuses](../reference/theme-overlay.md#what-the-overlay-refuses) —
`theme/lib/**` and a root `theme/content.config.ts` — are a compatibility
guard, not part of this model. The copy does not follow symlinks either way,
so the list constrains nothing an owner could not already do. Do not read it as
containment.

## Config values that land in HTML

Config is owner-authored, so URL validation there is a typo guard rather than a
trust boundary — but it is applied anyway, at load rather than at render, so a
`javascript:` href fails the build instead of shipping. `customCss` is
containment-checked to the index root for a sharper reason: `validate` builds
contribution PRs, and an unconstrained path would let one inline any readable
file into the published site.

## Package data is untrusted

Every outbound string on a package page — repository, homepage, documentation,
support channels — was handed to the index by a registry it does not control.
Each goes through a scheme allowlist before it becomes an `href`.

## Known gap

In the combined (`--with-skills`) layout the gate does **not** cover your own
CI's announce. GitHub runs no workflows on a PR opened with
`secrets.GITHUB_TOKEN`, so that PR arrives ungated — review it by hand. That
layout also needs "Allow GitHub Actions to create and approve pull requests"
enabled, which is off by default and which also lets workflows approve PRs.
