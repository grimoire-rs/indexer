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

`marketplace.toml` and `marketplace.lock` at the repository root are the one
exception to the path list, and they still never auto-merge. A change to either
is refused with `marketplace changes need maintainer review`, because the
marketplace is what a harness installs on your people's machines. The gate also
checks that every registry member is a package the index serves, and adds its
own reason when one is not. A member the gate cannot read - a malformed entry or
a key it does not know - gets a reason too, and so does a TOML syntax error,
reported by line and column only. The gate runs on pull requests that touch
either file, so a marketplace-only change is never skipped.

The gate judges the pull request head, not the result of merging it. A package
removed from `main` after the branch point still counts as indexed for the
marketplace check, so the maintainer review that every marketplace change gets
is where that gap closes.

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
- A `theme` package from `index.config.json` is the same: its files run at
  build time like your own `theme/`. Pin it in your lockfile.

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
contribution PRs, and an unconstrained path would let one publish any readable
file on the site.

## Package data is untrusted

Every outbound string on a package page — repository, homepage, documentation,
support channels — was handed to the index by a registry it does not control.
Each goes through a scheme allowlist before it becomes an `href`.

A README, changelog or `SKILL.md` is the same kind of input at greater length.
It is held to GitHub's HTML allow-list when the page is built. Scripts, event
handlers, inline styles, iframes, forms and `target` attributes are removed.
Every `id` and `name` gets a `user-content-` prefix, so a README cannot shadow a
page global.

## Content security policy

Every page the build writes carries a hash-based `Content-Security-Policy` in a
`<meta>` tag at the top of `<head>`, after only the charset declaration. No
theme layout can drop it. Scripts, stylesheets, fonts and fetches load from the
site's own origin; images load from it or over `https`. The only inline code
that runs is the `<script>` and `<style>` blocks present when the site was
built. A `style=""` attribute or an `onclick=""` handler is blocked, and a
README that still carries a script, style or handler fails the build. A `<meta>`
cannot carry `frame-ancestors`, so framing is for your host's response headers.

## Known gap

In the combined (`--with-skills`) layout the gate does **not** cover your own
CI's announce. GitHub runs no workflows on a PR opened with
`secrets.GITHUB_TOKEN`, so that PR arrives ungated — review it by hand. That
layout also needs "Allow GitHub Actions to create and approve pull requests"
enabled, which is off by default and which also lets workflows approve PRs.
