// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { transformerStyleToClass } from "@shikijs/transformers";

/**
 * Light and dark code themes.
 *
 * Shiki is what Astro already ships — the same highlighter VS Code renders
 * with — so nothing here adds a library; this only stops the two consumers
 * drifting onto different themes. The markdown pipeline reads it through
 * `astro.config`'s `shikiConfig`, and `CodeBlock.astro` — what every
 * hand-written snippet on the site goes through — passes it to `<Code>`.
 *
 * A *pair*, not one theme: with a single theme a block stays dark on a light
 * page. Given two, Shiki writes the light colour and a `--shiki-dark` custom
 * property on the same token, and `Base.astro` swaps between them with the
 * rest of the palette.
 *
 * GitHub's pair, deliberately boring: Shiki's best-tested themes, and neutral
 * enough to sit on this page without fighting the accent.
 */
export const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;

type StyleToClass = ReturnType<typeof transformerStyleToClass>;
const SHIKI_KEY = Symbol.for("grim.shiki.styleToClass");

/**
 * Turns the colours Shiki would write as `style=""` into `__shiki_` classes,
 * which `postProcessSite` ships as one stylesheet.
 *
 * One instance for the whole process, kept on `globalThis`: the markdown
 * pipeline runs from Node while `CodeBlock.astro` is bundled by Vite, so each
 * imports its own copy of this module, and two registries would split the
 * rules between them. Pass this to both `shikiConfig` and `<Code>`; the
 * latter does not inherit the former.
 */
const shared = globalThis as { [SHIKI_KEY]?: StyleToClass };
export const SHIKI_CLASSES: StyleToClass = (shared[SHIKI_KEY] ??= transformerStyleToClass({
  classPrefix: "__shiki_",
}));

/**
 * The registry as one stylesheet, empty when no block was highlighted.
 *
 * Sorted, because pages render concurrently and insertion order would make
 * the file's hash differ between identical builds. In `@layer grimoire` with
 * the rest of the site's CSS: a `customCss` file overrides it like any other
 * rule, and no rule outside the layer survives the build.
 */
export function shikiCss(): string {
  const rules = [...SHIKI_CLASSES.getClassRegistry()]
    .map(([cls, style]) => {
      const body =
        typeof style === "string"
          ? style
          : Object.entries(style)
              .map(([k, v]) => `${k}:${v}`)
              .join(";");
      return `.${cls}{${body}}`;
    })
    .sort();
  return rules.length ? `@layer grimoire{${rules.join("")}}` : "";
}
