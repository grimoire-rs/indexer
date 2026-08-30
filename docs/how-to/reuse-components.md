# Reuse shipped components

A page you add reaches the renderer's own layouts, components and helpers
through the `@grim/*` specifier. It resolves to the Astro source tree this
package ships, *after* your [theme overlay](../reference/theme-overlay.md) has
been applied — so if you replaced a component, importing it gives you yours.

```astro
import Base from "@grim/layouts/Base.astro";
import CommandBar from "@grim/components/CommandBar.astro";
import { installChoices } from "@grim/lib/commands";
import { data } from "@grim/lib/data";
```

The specifier is [contract](../reference/theme-overlay.md#stability); the
component paths behind it are not yet.

`@grim/lib/*` is import-only. Putting a file at `theme/lib/…` does not replace
it — that path is [refused by the
overlay](../reference/theme-overlay.md#what-the-overlay-refuses), so the
renderer stays free to move these helpers.

## The command bars

`CommandBar` is the copy-to-clipboard box the landing page uses for "install
grim" and "add registry", and every package page uses for "add this package".
A setup guide should draw the real one rather than a code block that looks
like it.

```astro
---
import Base from "@grim/layouts/Base.astro";
import CommandBar from "@grim/components/CommandBar.astro";
import { installChoices, registryScopeChoices } from "@grim/lib/commands";
import { data } from "@grim/lib/data";
const { config } = data;
---

<Base title="setup" description="Set up the Acme index.">
  <h1>Set up {config.brand}</h1>

  <h2>1. Install grim</h2>
  <CommandBar
    choices={installChoices(config)}
    noun="install command"
    copyLabel="Copy the install command"
    pickerTitle="Platform"
    pickerLabel="Choose your platform"
    detect
  />

  <h2>2. Add the registry</h2>
  <CommandBar
    choices={registryScopeChoices(config)}
    noun="registry add command"
    copyLabel="Copy the registry add command"
    pickerTitle="Scope"
    pickerLabel="Choose the scope"
  />
</Base>
```

Both bars are derived from *your* `install` and `registry` config, so the
commands cannot drift from the ones the landing page shows.

### A bar for an index other than your own

`registryScopeChoices` takes the registry as a second argument, defaulting to
the one in your config. Pass a different one and you get the same bar for it —
which is what a corporate setup guide that hands out its own index *and*
encourages the public one needs:

```astro
---
import CommandBar from "@grim/components/CommandBar.astro";
import { BrandMark } from "@grim/components/BrandMark.tsx";
import { registryScopeChoices, type RegistryHint } from "@grim/lib/commands";
import { addRegistryUrl } from "@grim/lib/catalog";
import { data } from "@grim/lib/data";
import { mdiMicrosoftVisualStudioCode } from "@mdi/js";
const { config } = data;

const publicIndex: RegistryHint = {
  alias: "grimoire",
  index: "https://index.grimoire.rs",
};
const addPublic = addRegistryUrl(config.vscodeExtension, publicIndex);
---

<h2>Also add the public index</h2>
<CommandBar
  choices={registryScopeChoices(config, publicIndex)}
  noun="registry add command"
  copyLabel="Copy the registry add command"
  pickerTitle="Scope"
  pickerLabel="Choose the scope"
>
  {addPublic && (
    <a slot="action" class="seg brand-link" href={addPublic}
       title="Add this index via VS Code" aria-label="Add this index via VS Code">
      <BrandMark path={mdiMicrosoftVisualStudioCode} />
    </a>
  )}
</CommandBar>
```

`addRegistryUrl` already took its registry explicitly, and returns `null`
whenever the deep link would not work — a non-`https` locator, embedded
credentials, an alias the extension refuses — so a broken button never renders.

`registryAddCommand(config, registry)` takes the same second argument, for a
page that wants the bare command string rather than the bar.

| Prop | Meaning |
|---|---|
| `choices` | The commands offered. One renders a bare field; more than one adds the picker. Empty is legal — a bar can be nothing but its action segment |
| `noun` | What the copy toast calls it, after the choice name: `"install command"` becomes `"Linux install command"` |
| `copyLabel` | Accessible name for the field |
| `pickerTitle`, `pickerLabel` | Tooltip and accessible name for the picker |
| `detect` | Preselect the visitor's own platform before first paint. Only meaningful when the choices *are* platforms |

An `action` slot fills the trailing segment:

```astro
<CommandBar choices={choices} noun="add command" copyLabel="Copy it">
  <a slot="action" class="seg brand-link" href={deepLink}>…</a>
</CommandBar>
```

## Code blocks

`CommandBar` is for a command a reader copies and runs. Anything else you want
to show as code — a config snippet, a workflow file, a JSON descriptor — is
`CodeBlock`, which wears the site's own frame, the same Shiki theme pair as
every rendered README, and the same copy button.

```astro
---
import CodeBlock from "@grim/components/CodeBlock.astro";
import { vscodeUrl } from "@grim/lib/catalog";
import { data } from "@grim/lib/data";
---

<CodeBlock
  code={`{
  "registry": { "alias": "acme", "index": "https://index.acme.example" }
}`}
  lang="json"
  name="config snippet"
/>

<CodeBlock
  code="grim add acme/code-review"
  name="add command"
  vscodeHref={vscodeUrl(data.config.vscodeExtension, "acme/code-review")}
  vscodeLabel="Open code-review in VS Code"
/>
```

| Prop | Meaning |
|---|---|
| `code` | The snippet, verbatim. What the copy button copies |
| `lang` | Shiki language id. Default `sh` |
| `name` | What the copy toast calls it, e.g. `"add command"` |
| `vscodeHref` | Any URL for the trailing button. `null` or omitted draws none |
| `vscodeLabel` | Accessible name for that button. Default `"Open in VS Code"` |

`vscodeHref` is a plain URL, not an extension id, so any deep link works —
`vscodeUrl`, `vscodeVoteUrl` and `addRegistryUrl` from `@grim/lib/catalog`, or
one you write. All three return `null` when the index sets
`vscodeExtension: null`, which is exactly what the prop wants for "no button".

!!! note "The copy button is added by the layout, not by the component"
    `Base.astro` puts one on every code block on the page, because a block
    inside rendered markdown has no markup to hang one on. `CodeBlock` ships
    the slot it lands in. That is why there is one button and one toast whether
    the block came from a README or from your page — and why a block still
    needs the layout's script to be copyable.

## The choice helpers

`@grim/lib/commands` builds what the bars offer:

| Function | Returns |
|---|---|
| `installChoices(config)` | One choice per platform named in `install`, with its brand glyph |
| `registryAddCommand(config, registry?)` | The `grim config registry add …` line, or `null` when there is no registry. `registry` defaults to your config's |
| `registryScopeChoices(config, registry?)` | That command as Global and Project choices, for the same registry |
| `addArtifactChoices(ref)` | `grim add` for one package, Global and Project |

## Smaller pieces

| Import | Is |
|---|---|
| `@grim/components/CommandField.astro` | One copyable command, no picker |
| `@grim/components/PickerMenu.astro` | The choice menu alone |
| `@grim/components/KindMark.tsx` | The glyph for a package kind |
| `@grim/components/BrandMark.tsx` | An `@mdi/js` brand glyph — the VS Code and platform marks |
| `@grim/components/CodeBlock.astro` | A highlighted, copyable code block |
| `@grim/lib/data` | `{ config, packages, css }`, the build-time payload |
| `@grim/lib/base` | `withBase(url)` — prefixes the deployment base — and `linkAttrs(link)`, the `target`/`rel` a nav or footer entry gets |
| `@grim/lib/catalog` | Presentational helpers: `timeAgo`, `lastUpdated`, `externalUrl`, and the deep-link builders `vscodeUrl`, `vscodeVoteUrl`, `addRegistryUrl` |

!!! warning "`@grim/lib/data` is build-time only"
    It inlines the whole catalog. Importing it from a component that hydrates
    in the browser ships every package twice. The catalog island takes what it
    needs as props for exactly this reason.
