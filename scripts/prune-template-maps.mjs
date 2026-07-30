// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Drop source maps from the staged Astro template.
//
// `dist/renderer/astro/` is built twice over: tsc compiles the tree (because
// `src/renderer/index.ts` imports `./astro/lib/code.js` from it), then the
// build copies the `.ts`/`.tsx`/`.astro` sources on top, because those are
// what Astro actually renders. The maps tsc leaves behind name paths under
// the repository's own `src/`, which no published package contains — so
// every `grim-indexer dev` in a real index repo logged a
// "Sourcemap … points to missing source files" warning per file, for maps
// nothing can resolve and nobody debugs.
//
// Runs from `npm run build`, after the copy.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "dist", "renderer", "astro");
const TRAILING_MAP = /\n\/\/# sourceMappingURL=.*\s*$/;

let removed = 0;
for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  if (entry.name.endsWith(".map")) {
    rmSync(file);
    removed += 1;
  } else if (entry.name.endsWith(".js")) {
    const before = readFileSync(file, "utf8");
    const after = before.replace(TRAILING_MAP, "\n");
    if (after !== before) writeFileSync(file, after);
  }
}

console.log(`prune-template-maps: removed ${removed} map(s) from dist/renderer/astro`);
