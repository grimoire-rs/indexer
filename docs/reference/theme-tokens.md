# Theme tokens

Every value the renderer draws with is a CSS custom property named
`--grim-<category>-<role>`, declared in one file — the renderer's
`styles/tokens.css`, whose contract comment is the authority. Reassign any of
them from your [`customCss`](../how-to/customize-branding.md#colour-spacing-shape)
file.

| Family | Tokens |
|---|---|
| Colour | `--grim-color-*` — surface, accent, package kind, state |
| Space | `--grim-space-1` … `-9`, a sparse scale whose steps grow apart |
| Type | `--grim-text-2xs` … `-2xl` |
| Radius | `--grim-radius-base` — one knob: `0px` square (the default), `4px` rounded. The four steps `-code`, `-inset`, `-control` and `-surface` derive from it and keep their ratios; `-pill` does not, so chips stay pills |
| Border, motion, elevation | `--grim-border-width`, `--grim-duration-*`, `--grim-shadow-*` |

## Colour is the only per-scheme family

Override it **twice**:

```css
:root { --grim-color-accent: #2563eb; }
[data-theme="dark"] { --grim-color-accent: #60a5fa; }
```

`:root` is scheme-agnostic. A `:root`-only colour override silently applies in
dark mode too and pins that token to its light value — the most common way to
break dark mode without noticing, because a light-mode screenshot looks right.

Everything else is a measurement. Declare it once; redeclaring a radius under
`[data-theme="dark"]` would be a second source of truth for one value.

## Shape

The renderer ships square. `--grim-radius-base` is `0px`; set it to `4px` to
restore the rounding of `0.4.x` and earlier in one line. The four measurement
steps derive from it, so overriding the base moves all of them; overriding one
step directly still wins over the derivation.

`-pill` is off the knob on purpose — a chip is a pill because that shape says
"toggleable tag", and squaring one turns it into a button.

## There is no component-hook tier

No `--grim-card-radius` and friends. With the cascade layer and the
[data slots](data-slots.md), a hook would reach nothing an ordinary rule
cannot already reach, and it would freeze a per-slot vocabulary that is not
worth promising this early.

## Renamed in past releases

!!! warning "Radius steps were renamed after 0.4.x"
    `--grim-radius-sm`/`-md`/`-lg`/`-xl` are now `--grim-radius-code`,
    `-inset`, `-control` and `-surface`. `-pill` is unchanged and the values
    did not move. An override under an old name is silently ignored, like any
    unknown property.

!!! warning "Tokens were namespaced after 0.4.0"
    They were unnamespaced (`--accent`, `--bg`, `--fg`), which collides with
    any other stylesheet on the page. The role names are the same behind a
    `--grim-color-` prefix.
