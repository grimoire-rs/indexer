# The dev index

`task dev` renders this. It is not a test fixture — `test/renderer/fixture/`
is, and `test/renderer/build.test.ts` counts its contents — so artifacts can
be added here freely without touching an assertion.

One artifact per rendering state. Adding a state means adding an artifact and
a row in the table below; it never means adding a second index.

| Artifact | kind | The state it exists for |
|---|---|---|
| `code-review` | skill | Fully enriched: logo, all four support channels, `compatibility`, README + changelog + contents, deep tag cascade, 12 votes |
| `starter-pack` | bundle | `contents.json` `members[]` — two indexed (linked), one not (plain `<code>`). Top of the rating sort, and the only artifact with no `support` block |
| `rust-style` | rule | A rating thread with **zero** votes — a `0` pill, which is not the same as unrated. One support channel |
| `test-writer` | agent | Unrated (absent from `.stats.json`) **and** no `logo` key → initial-letter tile |
| `ghost-logo` | skill | Declares a logo it does not ship → 404 → the `ImageOff` broken-image placeholder |
| `old-helper` | rule | Deprecated with a **reason** and a `replacedBy`; hidden from the default browse |
| `sunset-agent` | agent | Deprecated with a reason and **no** replacement |
| `bare` | mcp | Pointer only — no `enrich/` sidecar at all, as an index that never ran `enrich` |
| `context7` | mcp | `contents.json` descriptor with no `members` → raw JSON render |
| `bean-counter` | skill | Stats entry carrying only a `downloads` blob → unrated, and an unknown key that must survive the build |
| `enterprise-compliance-policy-pack` | rule | Long name, long summary, twelve keywords → overflow |
| `many-versions` | skill | Fourteen tags → version picker and cascade. Also the one **rated ref with no thread URL**: the count renders as plain text, not a link, and the badge keeps both ends round |
| `changelog-only` | agent | Changelog but no README → the tab reports its own absence |
| `gitlab.com/team/mirror` | rule | Second namespace, nested, GitLab `login` owner, non-`ghcr.io` host |

`.stats.json` also rates `ghcr.io/acme/gone`, which no `metadata.json`
mentions — the catalog must invent no card for it.

Keywords **overlap on purpose** — `quality`, `docs`, `cli` and `rust` each
span several artifacts. The catalog's keyword rail picks its chips by
splitting power, so a vocabulary of singletons renders a rail that is
technically correct and demonstrates nothing: every candidate ties, and no
click ever visibly rescores the rest. The overlaps are what make the rail
reorder, and `enterprise-compliance-policy-pack`'s twelve keywords are what
keep the `+N more` menu worth opening.

Every rating URL points at a real page in the production shape — GitHub
discussions for the `ghcr.io/acme/*` refs, a GitLab work item for
`gitlab.com/team/mirror` — so clicking a count in the demo demonstrably
leaves the site instead of landing on a fabricated 404. `many-versions`
carries no URL at all, which is the other half of that state.

`deprecated` is the publisher's **message**, not a date — grim's own detail
pane renders it as `Deprecated: <message>`. Both deprecated artifacts here
carry a real sentence, because a fixture holding a date hides the fact that
the banner has a reason to show.
