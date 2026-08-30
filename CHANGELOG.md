# Changelog

All notable changes to `@grimoire-rs/indexer` are recorded here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> This file starts at `0.5.0`. Releases up to and including `v0.4.4` shipped
> before it existed and are not reconstructed here — the git tags and
> `git log v0.4.3..v0.4.4` are the record for those. Every release from the
> next one on is written down here.

Component overrides sit in the **Unstable** tier of the
[stability table](docs/reference/theme-overlay.md#stability): their file paths
and props may move in a minor release, and this file is where that is
announced. Everything in the Contract tier moves only in a major.

An entry for such a move carries both halves or it announces nothing an
overrider can act on: the component's name, and the move itself as old → new —
`PackageRow`: `components/PackageRow.tsx` → `components/list/PackageRow.tsx`,
props `{ pkg }` → `{ pkg, compact }`.

## [Unreleased]

## [0.5.0] - 2026-08-30

### Added

- **Theme overlay.** A `theme/` directory in an index repo is copied over the
  renderer's staged sources before every build. A file at a path the renderer
  does not ship adds one — `theme/pages/setup.astro` becomes `/setup/` — and a
  file at a path it does ship replaces it. Structure is customizable now, not
  just CSS. Only on the staged-copy path: a caller-supplied `srcDir` is left
  alone.
- **Two paths the overlay refuses**, `theme/lib/**` and a root
  `theme/content.config.ts`, so the renderer stays free to move its own helpers
  and its one content-collection entrypoint. Each prints a line to stderr and
  the build still succeeds. The same rule applies to `dev`'s mirror, because a
  deny-list only one of the two writers honours lets an author develop against
  a file the build then drops in silence. It is a compatibility guard, not a
  security boundary: the copy does not follow symlinks either way.
- **`@grim/*` import specifier**, resolving to the renderer's sources so an
  added page reaches the layout, components and helpers without a relative
  path that encodes how deep it sits under `pages/`. It resolves *after* the
  overlay, so an index that replaced a component imports its own.
- **`@grim-original/*`**, the same tree as it was *before* the overlay ran, so
  an override can wrap the file it replaced instead of owning it outright.
  `@grim/*` cannot serve that purpose once the theme has taken the path, and
  the package's `exports` do not publish the Astro sources for a deep import.
- **One stderr line per overlaid path that replaces a shipped file**, naming
  the path and the indexer version that shipped it. That is what makes the
  Unstable tier below honest without a manifest. A path that only adds a file
  is not logged.
- **`dev` mirrors `theme/**` edits** into the staged tree, so a page reloads as
  it is saved. It creates `theme/` first if it is absent — a directory added
  after the server started now mirrors instead of 404ing forever — and removes
  it again on shutdown if you left it empty. Deletes are still not mirrored;
  restart for those. A fault in the platform's recursive-watch backend disables
  mirroring with a message rather than taking the server down.
- **`nav` config key.** An ordered `{label, href}` list that takes the header
  over. Unset, it synthesizes exactly what the header has always shown, so an
  index that predates the key renders unchanged; `[]` leaves the theme toggle
  standing alone.
- **`notice` config key.** One line above the page content, in the site's own
  width, on every page, carrying `data-slot="site-notice"`. Named `notice`
  rather than `banner` because `--grim-color-banner-*` is the existing amber
  palette for the deprecated-package banner, and a key called `banner` would
  invite an index runner to override that token family by mistake.
- **`nav[].external` and `footerLinks[].external`.** Optional per entry, and it
  decides only the new-tab affordance — the deployment base prefix is applied
  either way. Unset keeps the old inference from the href's shape. `false` is
  the case that inference cannot express: an absolute URL that is still your
  own site, a staging host or an intranet mirror.
- **A build-time warning for a `nav` or `footerLinks` href that leads nowhere.**
  A `/`-rooted href matching no emitted route and no `public/` file prints
  `nav[0].href "/setup/": nothing is published at that path — the link will
  404`. It warns and never fails: a path served by something outside the build
  is indistinguishable from a typo, and refusing a whole site over a footer
  typo is worse than the typo. Checked after the build, which is the one moment
  both the emitted routes and every `public/` layer exist at once.
- **A warning for an unrecognised top-level key in `index.config.json`**,
  naming the key. Without it a typo — or a config predating the `banner` →
  `notice` rename — loaded clean and silently rendered nothing.
- **`init` scaffolds `theme/README.md` and a `tsconfig.json`** mapping
  `@grim/*` for editors. The README states where a page goes and which parts of
  the overlay are promised, which a `.gitkeep` could not; both reserve `theme/`
  for git equally well. `theme/pages/` is no longer created empty. The build
  does not read that tsconfig.
- **A documentation site** (MkDocs Material, Diátaxis), built `--strict` as the
  docs' pre-merge gate and published to GitHub Pages. `task docs:build`,
  `docs:serve`, `docs:clean` — deliberately not part of `task check`, which
  must stay runnable with no Python toolchain.
- **Individually replaceable components**: `SiteHeader`, `SiteFooter`,
  `CommandBar`, `CopyButton`, `CardLogo`, `PackageCard`, `PackageRow`.
- **This changelog**, which two docs pages already made the sole mitigation for
  the Unstable tier. It ships in the npm tarball, so the copy that matches your
  pinned version is `node_modules/@grimoire-rs/indexer/CHANGELOG.md`.
- **`npm run typecheck:tests`**, type-checking the `test` tree under its own
  `tsconfig.test.json`. Deliberately not wired into `task check` yet: the tree
  has 95 real type errors, which is its own piece of work.

### Changed

- **`footerLinks[].href` now accepts a site-root path** (`/setup/`) as well as
  an absolute `http(s)` URL — previously `http(s)` only. `nav` takes the same
  rule from one shared validator, and so now do `logo` and `favicon`, which had
  three different answers between them and one that validated nothing. Both
  link keys are checked when the config *loads*, so a `javascript:` or
  protocol-relative href fails the build with the key that carried it, rather
  than reaching a rendered anchor. A bare relative path is still refused: it
  would resolve against whichever page carries the link, and the detail pages
  sit two levels deep.
- **`/\host/x` and userinfo are refused everywhere a config value becomes a
  URL.** Browsers read `/\host/x` the way they read `//host/x`, and
  `https://good.test@evil.test/` resolves to `evil.test` while reading as
  `good.test`. Two of the four validators already rejected userinfo; all four
  do now.
- **Footer links go through the deployment base prefix, and honour the same
  new-tab rule as the header.** They did neither before. **This changes an
  existing site:** an `https://` footer link now opens in a new tab. Set
  `"external": false` on the entry to keep it in the same tab.
- **`Base.astro` no longer contains the header and footer markup** — they are
  `SiteHeader.astro` and `SiteFooter.astro`. Neither takes props: everything
  they draw is build-time config. The head, the centered `main`, the copy toast
  and every default style still come from the layout.
- **The platform-preselect loop moved into `Base.astro`**, so a `<CommandBar
  detect />` on a page you added under `theme/pages/` preselects the visitor's
  own platform. It used to run only on the shipped landing page, so the same
  markup elsewhere silently showed the configured first choice instead.
- **`Catalog.tsx` no longer contains the card and row markup** — they are
  `PackageCard.tsx` and `PackageRow.tsx`, and they *do* take props, because a
  component that hydrates in the browser cannot read the build-time payload.
  Those props are the contract the Unstable tier is about.
- **The install/registry/package command boxes are one `CommandBar`**, with
  their choices derived in `@grim/lib/commands` — so a page an index adds can
  draw the site's real install bar from the site's own config instead of
  restating the command in a code block that drifts.
- **The renderer ships square.** `--grim-radius-base` is `0px`; set it to `4px`
  to restore the rounding of `0.4.x` and earlier in one line.
- **Radius tokens are named for their role**: `--grim-radius-sm`/`-md`/`-lg`/
  `-xl` are now `-code`, `-inset`, `-control` and `-surface`, and they derive
  from `--grim-radius-base` rather than carrying their own values. `-pill` is
  unchanged and off the knob. An override under an old name is silently
  ignored, like any unknown property.
- **The list view leads with the package logo**, then the name, then the kind
  mark.
- **The README is a pointer to the docs site.** The theming contract, the stats
  sidecar schema and the CLI reference moved into `docs/`.
- **The scaffolded `tsconfig.json` sets `module` and `moduleResolution`** —
  `esnext`/`bundler`, what actually reads those specifiers — and no longer sets
  `baseUrl`, which is deprecated on the pinned TypeScript and made the file
  fail to load. It stays free of `extends` on purpose.
- **The docs workflow splits `configure-pages` into its own job**, so the job
  that resolves and executes unpinned transitive PyPI packages holds
  `contents: read` and nothing else — `id-token: write` is a job-wide grant.
  lychee now checks the external links `mkdocs --strict` never resolves and,
  with `--include-fragments`, the `#anchor` half of the internal ones, which
  `--strict` logs at INFO and exits 0 on.
- **eslint and vitest skip `.agents/worktrees/`.** Both tools walk the tree
  themselves rather than asking git, and neither knew about a path `.gitignore`
  had carried all along: eslint found a `tsconfig.json` per worktree and
  reported a parse error on every file in the repo, and vitest collected and
  ran each worktree's whole suite. A `.gitignore` entry and a tool's own ignore
  list are two independent claims.

### Fixed

- **Scaffold → `npm install` → build was broken end to end.** An index repo has
  its own `node_modules`, and the staged root Astro builds in sits inside it,
  so `preact-render-to-string` resolved to a second copy of preact. The first
  hook rendered died with `Cannot read properties of undefined (reading
  'context')`, in a stack naming preact and lucide and nothing that leads back
  to dependency resolution. Every preact-touching module is pinned to one copy
  now, and `preact-render-to-string` is a declared dependency so it resolves
  under an isolated install layout too.
- **A replaced header with no theme toggle no longer breaks the rest of the
  page.** The `#theme-toggle` lookup in `Base.astro` is null-safe, so the copy
  buttons, the picker wiring and the toast still run.
- **A `tsconfig.json` in the index repo that cannot be parsed is now named.**
  It made the build fail while rendering a page with an error about preact; the
  usual cause is an `extends` pointing into a `node_modules` that has not been
  installed yet.
- **`dev` cleans up after itself.** Stopping the server is idempotent, and a
  failure part-way through staging removes the scratch directory rather than
  leaving it in the index repo. One case is not fixable from inside shutdown
  and is written up in the docs: interrupting `dev` within about a second of
  boot can leave a `.index-*` holding Vite's `deps_temp_<hash>`, which the
  dependency optimizer recreates after the removal has already returned.

[Unreleased]: https://github.com/grimoire-rs/indexer/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/grimoire-rs/indexer/compare/v0.4.4...v0.5.0
