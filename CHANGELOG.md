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

## [0.5.2] - 2026-08-31

### Fixed

- **The sort control drew two borders when clicked.** Hover tints a control's
  border to the accent and focus drew a 2px accent outline standing 1px clear
  of it, so anyone who reached the control with a mouse had both at once — one
  state reading as two lines with a gap between them. The ring merges onto the
  border now, the way the card's focus state already did, and the offset comes
  off every bordered control in the toolbar together rather than off the one
  that showed it: the search field, the keyword overflow menu's search, both
  sort halves and both view picks. Keyword chips gain the same ring, having
  taken the browser's default until now.
- **A long address no longer wraps the card's head onto a second line.** A
  namespace breaks at its own slashes and dots, so a wide one took two rows and
  left the card taller than its neighbours with the tail of the address against
  the padding edge. It stays on one line and the overflow is trimmed from the
  *front* — the registry host is on every address in an index and the
  repository at the tail is what tells two apart — with the whole of it in the
  element's `title`.
- **Keyword chips could stutter, or stop part-way through the rail's slide.**
  The rail's FLIP pass inverted each chip with an inline `transition: none` and
  a `translate`, then dropped both on the next animation frame; any commit
  landing inside that window left the chip carrying the offset with its
  transition disabled, and nothing else took those off. It also measured seats
  with `getBoundingClientRect`, which reports where a chip is *drawn*, so a
  chip caught mid-slide recorded its animated box and the next inversion
  compounded the error instead of correcting it. Neither window was rare: the
  rail's own fit measurement re-commits whenever a rescore changes how many
  chips fit. Seats now come from `offsetLeft`/`offsetTop`, which ignore
  transforms and scroll, and the slide is a Web Animation — it starts without a
  frame, writes nothing to `style`, and clears itself when it finishes or is
  cancelled. `prefers-reduced-motion` is honoured by the effect rather than by
  the stylesheet, and `--grim-duration-slow` is still its length.

## [0.5.1] - 2026-08-31

### Added

- **`grim-indexer dev --host [addr]`.** Bare, it binds every interface; with a
  value, that address. Without it the server binds loopback only — Astro's own
  default — which is unreachable from a dev container, a VM or a WSL guest,
  where the port forwards and the connection then hangs against a socket that
  is not listening for it. `npm run dev -- --host` takes the same two forms.
  Bare `--host` puts the preview on your network; the CLI reference says so.
- **`CodeBlock.astro`**, a reusable code block: the site's own frame, the same
  Shiki theme pair every rendered README uses, the same copy button and toast,
  and an optional VS Code button. Props
  `{ code, lang?, name?, vscodeHref?, vscodeLabel? }`; `vscodeHref` is a plain
  URL, so `vscodeUrl`, `vscodeVoteUrl`, `addRegistryUrl` and a hand-written
  deep link all work. Worked example in
  [Reuse shipped components](docs/how-to/reuse-components.md#code-blocks).
- **`data-slot="code-block"`**, for it. Contract tier, like every other slot.
- **A second argument on `registryAddCommand` and `registryScopeChoices`**,
  the registry to build the command for — defaulting to the one in your config,
  so nothing existing changes. It is what lets a setup page draw the "add
  registry" bar for an index *other* than the site's own: a corporate index in
  the hero and the public one further down.
- **A clear button on the keyword filters**, in the catalog toolbar. Rendered
  only while a keyword is picked, and it lifts the keywords alone — Escape is
  still what clears the search and the kinds with them.

### Fixed

- **The keyword overflow menu opened invisibly.** Its panel was an absolutely
  positioned child of the toolbar's filter row, which is a scroll container, so
  the panel was cropped to the row and stretched the row's scroll extent — a
  menu nobody could see, with a stray horizontal and vertical scrollbar to show
  for it. It is a popover now, which puts it in the top layer, outside every
  ancestor's `overflow`, and brings Escape and light dismiss with it. The
  trigger is a `<button>` rather than a `<summary>`, so the toolbar's arrow-key
  navigation now reaches it.
- **The detail page's logo drifted down under a long description.** The header
  centred the tile against the text beside it, so the same package's mark sat
  at a different height on every page. It holds against the title now.
- **Dropped the tinted square behind a package logo**, on the cards, the list
  rows and the detail header alike. A logo is a designed mark already sitting
  on its own ground, so the slot framed it twice — most visibly for the many
  logos that are themselves a rounded square, which then sat inside a slightly
  larger one. The slot still reserves the same box, so nothing shifts. The
  dashed frame the broken-logo state drew goes with it — it read as a fault in
  the layout rather than in the image; the slashed glyph is what says the logo
  failed, and `role="img"` with a label is what announces it. The
  initial-letter tile a package with no logo gets is unchanged: there the
  coloured ground is the mark.
- **The dev server's URL is a legal URL when the server binds an IPv6
  address.** An unbracketed literal reads its own colons as a port, so
  `http://::1:4321/` threw `ERR_INVALID_URL` at the first `new URL` against it
  and took `dev:smoke` down with a message naming neither the address nor the
  host. Wildcard binds still become `localhost`; anything carrying a colon is
  bracketed.
- **The detail page's logo tile is a fixed square.** `aspect-ratio: 1` derived
  its width from the height the box had *before* `align-self: stretch` grew it,
  so it rendered 56x93 beside a logo and 56x70 beside a letter — portrait,
  never square, and narrow enough to read as bounding the image rather than
  framing it.
- **The list row's glyphs sit on the row's centre.** `vertical-align: middle`
  aligns to half the parent's x-height, about 2px under the line's true middle
  at this step, and the upvote arrow's optical nudge added a third pixel the
  same way. The kind and rating cells are flex boxes now and centre their
  contents as boxes.
- **Keyword chips could freeze part-way through the rail's slide.** The rail
  animates a rescore by inverting each chip with an inline `translate` and
  dropping it on the next animation frame. A rescore that also changes how many
  chips fit commits a second time, and that commit cancelled the frame before
  it ran — leaving every moved chip parked at its offset with transitions
  disabled. Deselecting the last keyword hit it most often, because that
  rescore is the largest. The offsets are now cleared before each measurement
  and on cleanup, so an interrupted slide resolves instead of sticking.
- **Switching between the cards and list views repainted the whole catalog.**
  Off-screen cards are skipped until they are scrolled to. The two views share
  no element types, so a switch still rebuilds every item — past a few hundred
  packages the answer is windowing the list, and this is not that.

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

[Unreleased]: https://github.com/grimoire-rs/indexer/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/grimoire-rs/indexer/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/grimoire-rs/indexer/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/grimoire-rs/indexer/compare/v0.4.4...v0.5.0
