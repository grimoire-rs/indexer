// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Light and dark code themes.
 *
 * Shiki is what Astro already ships — the same highlighter VS Code renders
 * with — so nothing here adds a library; this only stops the two consumers
 * drifting onto different themes. The markdown pipeline reads it through
 * `astro.config`'s `shikiConfig`, and the `<Code>` component on the package
 * page takes it as a prop.
 *
 * A *pair*, not one theme: with a single theme a block stays dark on a light
 * page. Given two, Shiki writes the light colour as an inline style and the
 * dark one as a `--shiki-dark` custom property on the same token, and
 * `Base.astro` swaps between them with the rest of the palette.
 *
 * GitHub's pair, deliberately boring: Shiki's best-tested themes, and neutral
 * enough to sit on this page without fighting the accent.
 */
export const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;
