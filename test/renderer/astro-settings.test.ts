// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The Astro settings a large catalog's build depends on. Neither is
// observable in the rendered HTML, so they are pinned where they are written.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASTRO_EXPERIMENTAL } from "../../src/renderer/index.js";

// `content.config.ts` imports `astro:content`, which only resolves inside
// Vite, so the loaders are read as text rather than imported.
const CONTENT_CONFIG = fs.readFileSync(
  fileURLToPath(new URL("../../src/renderer/astro/content.config.ts", import.meta.url)),
  "utf8",
);

describe("Astro settings", () => {
  // `deferRender` makes every markdown file its own bundler module: at 20,000
  // packages the build took 15.3 GiB of RSS and 14 minutes instead of 7.1 GiB and 5.
  it("renders markdown during content sync, not in the bundler", () => {
    // Each `glob(` call up to its closing `})`; none of them nests braces.
    const loaders = CONTENT_CONFIG.match(/glob\(\{[^}]*\}\)/g) ?? [];
    expect(loaders).toHaveLength(6);
    for (const loader of loaders) expect(loader).not.toContain("deferRender");
  });

  it("chunks the content store", () => {
    expect(ASTRO_EXPERIMENTAL).toEqual({ collectionStorage: "chunked" });
  });
});
