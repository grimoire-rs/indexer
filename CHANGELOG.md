# Changelog

All notable changes to `@grimoire-rs/indexer` are recorded here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Component overrides sit in the **Unstable** tier of the
[stability table](docs/reference/theme-overlay.md#stability): their file paths
and props may move in a minor release, and this file is where that is
announced. Everything in the Contract tier moves only in a major — so a commit
that moves one says which component and where, old → new, in its subject or
body, because that is all a reader gets here.

## [Unreleased]

### Added

- Publish the forge host in providers.rating_host *(ratings)*
- Carry the picked scope into the add-registry link *(renderer)*

## [0.5.3] - 2026-08-31

### Added

- --bulk, to look at the catalog at corporate size *(dev)*
- Fuzzy search across every field, with a relevance order *(renderer)*
- Give the search field its own clear button *(renderer)*

### Changed

- Ship the island only the fields a card renders *(renderer)*
- Build a viewport of the catalog, not all of it *(renderer)*

### Fixed

- Hold the paint for a stored view and a kw deep link *(renderer)*
- Lift the agent badge to WCAG AA, and ratchet the floors *(renderer)*
- Verify the pack shape under both npm majors the matrix ships *(ci)*
- Restore the list view's subgrid columns *(renderer)*
- Keep the sort ring off a pointer interaction *(renderer)*

## [0.5.2] - 2026-08-31

### Fixed

- Merge the focus ring onto the control's own border *(renderer)*
- Trim a long card address from the front *(renderer)*
- Run the keyword rail's slide as a Web Animation *(renderer)*

## [0.5.1] - 2026-08-30

### Added

- Add a --host flag to dev *(cli)*
- Add CodeBlock, a code block an index's page can use *(renderer)*
- Let the registry command builders take another index *(renderer)*
- Add a clear button to the keyword filters *(renderer)*

### Changed

- Keep off-screen cards out of layout and paint *(renderer)*

### Documentation

- Record the unreleased changes *(changelog)*

### Fixed

- Bracket an IPv6 address in the dev server's URL *(renderer)*
- Make the detail page's logo tile a fixed square *(renderer)*
- Centre the list row's glyphs on the row, not the x-height *(renderer)*
- Open the keyword overflow menu in the top layer *(renderer)*
- Stop keyword chips freezing part-way through the rail's slide *(renderer)*
- Hold the detail logo against the title, and stop framing it *(renderer)*

## [0.5.0] - 2026-08-30

### Added

- Carry the rating thread URL into the catalog *(renderer)*
- Redraw the package card, and keep the view across a visit *(renderer)*
- Give the detail page its right column back *(renderer)*
- Pick keyword chips by splitting power *(renderer)*
- Give the catalog a keyword facet and a list view *(renderer)*
- Ship square, behind one radius knob *(renderer)* **BREAKING**
- **Migration:** every corner is square by default. `--grim-radius-base` is the whole decision — `0px` now, `4px` restores the rounding of `0.4.x` and earlier in one line. The four measurement steps derive from it and hold their ratios; overriding one step directly still beats the derivation, so a consumer wanting square surfaces and rounded controls sets that step and ignores the knob.  Four steps at 4/6/8/10px was a distinction nobody perceived — they were only pickable after their roles were written down, and the package list had already ended up on the wrong one silently. Square reads as the developer tool this is, and `pill` stays off the knob because a chip is a
- Show the package logo in the list view *(renderer)*
- Add nav and notice, behind one URL guard for every link value *(config)* **BREAKING**
- **Migration:** `footerLinks[].href` now accepts a site-root path as well as an absolute URL, and both link keys are validated when the config loads, so a
- Lay an index repo's theme/ over the shipped sources *(renderer)*
- Scaffold theme/README.md and an editor tsconfig that loads *(init)* **BREAKING**
- **Migration:** `init` no longer creates `theme/pages/.gitkeep`. An index scaffolded before this keeps its own copy; nothing removes it.

### Changed

- Name the radius tokens for their role *(renderer)* **BREAKING**
- **Migration:** `--grim-radius-sm`, `-md`, `-lg` and `-xl` are now `--grim-radius-code`, `-inset`, `-control` and `-surface`. `-pill` is unchanged and no value moved. A `customCss` override under an old name is silently ignored, like any unknown custom property; `README.md` carries the migration note.  Every other family in `tokens.css` names the role a value plays rather than its size — that is the rule this sheet states about itself, and the radius scale was the one family breaking it. The cost was not cosmetic: with nothing saying which step a surface should take, the package list ended up on the control step next to cards on the surface step, and the two corners disagreed. That is fixed here too.  The contract comment now publishes what each step is for, and warns against picking by eye — the same radius on a shorter box reads as more curve, so two corners that look different are often the same step.
- Lead the list row with logo, name, then kind *(renderer)*
- Put the kind mark before the name in the list *(renderer)*
- Make the header, footer, command bar and cards replaceable *(renderer)* **BREAKING**
- **Migration:** an `https://` footer link now opens in a new tab. Set

### Documentation

- Write down the local loop -- direnv, task, and the dev index
- Publish a documentation site, and start a changelog

### Fixed

- Hang the kind watermark off the corner by a share of its size *(renderer)*
- Point the dev fixture at the real extension id *(dev)*

## [0.4.4] - 2026-08-29

### Fixed

- Upload the tally -- a dotfile artifact was silently dropped *(ratings)*

## [0.4.3] - 2026-08-28

### Fixed

- Stop locking threads by default -- a locked one cannot be voted on *(ratings)* **BREAKING**

## [0.4.2] - 2026-08-28

### Added

- Publish zero-vote threads so a first vote can be cast *(ratings)* **BREAKING**

## [0.4.1] - 2026-08-28

### Added

- Make the whole theming surface a token contract *(renderer)* **BREAKING**
- **Migration:** every CSS custom property is renamed. The unnamespaced tokens (`--accent`, `--bg`, `--fg`, and the rest) are now `--grim-color-*`, and space, type, radius, border width, motion and elevation become overridable for the first time under `--grim-space-*`, `--grim-text-*`, `--grim-radius-*`, `--grim-border-width`, `--grim-duration-*` and `--grim-shadow-*`. A `theme.css` written against 0.4.0 or earlier stops applying silently rather than erroring.
- Publish a checkpoint, and seed the sidecars from it *(enrich)*

### Fixed

- Stop reading a large page as a transport failure *(ratings)*
- Stop every run dying on PAGE_SIZE at import *(ratings)*

## [0.4.0] - 2026-08-26

### Added

- Publish a stats.json sidecar from the index's own forge (#5) *(ratings)*
- Carry grim's annotation fields, and date every package *(enrich)*
- Show provenance and support, and publish the updated signal *(renderer)*

### Documentation

- Document the second stat, and release 0.4.0

## [0.3.1] - 2026-07-30

### Documentation

- Point at the index template repository

## [0.3.0] - 2026-07-30

### Added

- Own the pipeline in the index repo, and harden the gate *(ci)* **BREAKING**
- **Migration:** the reusable workflows `grimoire-rs/indexer/.github/workflows/index-{pages,validate}.yml` and the GitLab remote include are gone. An index scaffolded on 0.2.x keeps working on its pinned tag; to move, bump the dependency, add a `ci` block to index.config.json, run `npm run ci`, and delete the old thin callers - `ci --check` reports them as stale.

## [0.2.2] - 2026-07-28

### Fixed

- Stop defaulting the keys that name one specific index *(config)*

## [0.2.1] - 2026-07-28

### Fixed

- Stop gitignoring the index's own public/ directory *(init)*

## [0.2.0] - 2026-07-28

### Added

- Write a contents sidecar from the artifact payload *(enrich)*
- Add a header logo, and let an index drop the attribution *(config)*
- Rebuild the hero and the package page *(renderer)*

## [0.1.9] - 2026-07-28

### Added

- Offer the index as a one-click VS Code add-registry link *(renderer)*

## [0.1.8] - 2026-07-28

### Fixed

- Hand the gate every changed path, unfiltered *(validate)*

## [0.1.7] - 2026-07-28

### Added

- Read package READMEs, logos and versions from the registry (#1) *(enrich)*

## [0.1.6] - 2026-07-28

### Fixed

- Give the GitLab gate the git it shells out to *(ci)*

## [0.1.5] - 2026-07-28

### Fixed

- Resolve every internal URL against the site's base path *(renderer)*

## [0.1.4] - 2026-07-28

### Documentation

- Say the gate does not cover a first-party announce *(init)*
- Record what the live end-to-end trial settled

### Fixed

- Point --with-skills announce at the scaffolded repo *(init)*
- Name the status check branch protection can require *(init)*

## [0.1.3] - 2026-07-28

### Fixed

- Ship the reusable workflows the scaffold points at *(ci)*

## [0.1.2] - 2026-07-28

### Fixed

- Declare the repository provenance attests to

## [0.1.1] - 2026-07-28

### Added

- Add the grimoire-index renderer, gate and CLI

### Changed

- Publish as @grimoire-rs/indexer
- Name the binary grim-indexer

### Documentation

- State the real status and warn off the broken 0.1.0

### Fixed

- Declare a bin npm will not silently strip

[Unreleased]: https://github.com/grimoire-rs/indexer/compare/v0.5.3...HEAD
[0.5.3]: https://github.com/grimoire-rs/indexer/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/grimoire-rs/indexer/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/grimoire-rs/indexer/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/grimoire-rs/indexer/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/grimoire-rs/indexer/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/grimoire-rs/indexer/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/grimoire-rs/indexer/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/grimoire-rs/indexer/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/grimoire-rs/indexer/compare/v0.3.3...v0.4.0
[0.3.1]: https://github.com/grimoire-rs/indexer/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/grimoire-rs/indexer/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/grimoire-rs/indexer/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/grimoire-rs/indexer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/grimoire-rs/indexer/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/grimoire-rs/indexer/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/grimoire-rs/indexer/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/grimoire-rs/indexer/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/grimoire-rs/indexer/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/grimoire-rs/indexer/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/grimoire-rs/indexer/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/grimoire-rs/indexer/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/grimoire-rs/indexer/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/grimoire-rs/indexer/tree/v0.1.1

