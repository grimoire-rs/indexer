---
title: VS Code webviews
summary: The surface where the roles reverse — the host owns the vocabulary, no consumer stylesheet can exist, and layering your CSS makes you lose below 1.104
---

# VS Code webviews

> **Provenance: nothing in this file was reproduced in a running webview.**
> No probe touched VS Code this round. Every claim here comes from source
> reading of the VS Code repository plus read-only inspection of
> `dist/webview/*.css` in a real extension. Each claim below is marked
> *(source-read)* or *(measured elsewhere)*. Treat the whole file as the
> best available account, not as verified behaviour, and verify against your
> own `engines.vscode` before acting on it.
>
> **Explicitly open:** whether the injected `<style id="_defaultStyles">`
> survives a CSP with no `unsafe-inline` — nobody has opened devtools on it.
> That is why the `@layer` boundary below is stated as version-conditional
> advice, and why `codicon.css` is given as the independent justification.

## The roles are reversed, and three core rules change shape

The extension **consumes** a host-owned vocabulary rather than publishing one.
The CSP (`default-src 'none'; style-src ${webview.cspSource}`, no
`unsafe-inline`, no external host) makes a downstream consumer stylesheet
structurally impossible. *(source-read)*

So three rules from the index change shape here:

- **CSS-TOK-01** survives in a different form — read appearance through
  `var(--vscode-<theme-color-id>, <fallback>)` rather than publishing a token.
- **CSS-TOK-03** has nothing to assert: the host recomputes its properties on
  every theme change, so there is no per-scheme declaration of yours to compare.
- **CSS-API-01** does not apply: one flat author-controlled stylesheet, nothing
  generating a name.

## Do not layer your webview CSS unless `engines.vscode` is ≥1.104

VS Code shipped its defaults inside `@layer vscode-default` only from 1.104
(commit 4791661, 2025-08-13). On ≤1.103 they are UNLAYERED, so any rule of
yours inside a layer **loses at any specificity** — microsoft/vscode#261430.
*(source-read)*

A second unlayered target exists regardless of the `_defaultStyles` question: a
bundled `codicon.css` that loads before your bundle. *(source-read)* That
independently proves a second author stylesheet is present, which is the
CSS-CAS-02 "audit the landscape first" case in its sharpest form.

## `:root{--vscode-x:…}` loses; `body{--vscode-x:…}` wins and persists

VS Code sets tokens via `document.documentElement.style.setProperty()` — an
inline declaration on `<html>` and only `<html>`, so `:root` cannot beat it.
*(source-read; the underlying cascade fact — inline normal beats an unlayered
`#id` — is measured elsewhere, engine case 4a.)*

A body-level declaration wins body's own cascade and every descendant, including
inside shadow roots. The host's stale-property sweep iterates
`documentElement.style` only, so a body-level override survives every theme
change. *(source-read)*

**This is the real retheming entrypoint.** It is also the claim in this file
most worth verifying yourself before you build on it.

## `::part()` reaches `@vscode-elements` internals

`vscode-button` renders `part="base"`, and an outer `::part()` rule wins by
Context, not specificity — the internals reach (0,5,0) and it does not matter.
*(source-read; the Context-beats-specificity mechanism is measured — see
[web-components.md](web-components.md).)*

## The theme-class trap

The light-high-contrast theme carries BOTH `vscode-high-contrast-light` AND
`vscode-high-contrast`, so a selector list built from `.vscode-light`/
`.vscode-dark` alone ships dark-HC styling under light-HC. *(source-read)*

`vscode-reduce-motion` and `vscode-using-screen-reader` are present and
undocumented — and `prefers-reduced-motion` does NOT see VS Code's own
`workbench.reduceMotion` setting. *(source-read)*

## Deprecations

`data-vscode-theme-name` is deprecated in source; use `data-vscode-theme-id` or
`data-vscode-theme-kind`. `@vscode/webview-ui-toolkit` is archived (last push
2024-09-24) — target `@vscode-elements/elements` or hand-rolled elements.
*(source-read)*

## A CDN `<link>` fails silently

The CSP blocks it with no console error unless devtools is open. Bundle it, or
read `--vscode-font-family` and pick no font at all. *(source-read)*

## The gate skips the browser step here, by design

On ≤1.103 the contract is deliberately NOT to layer, so running the
layered-vs-unlayered assertion asserts the opposite of the contract. See
[gate.md](gate.md).
