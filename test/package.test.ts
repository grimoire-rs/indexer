// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The published artifact's shape, guarded here because npm fails it *quietly*:
// `npm publish` "auto-corrects" an invalid manifest, prints a warning nobody
// reads in CI, and ships the corrected version. 0.1.0 went out with its `bin`
// silently removed — an installable package with no executable, so
// `npx @grimoire-rs/indexer build` did nothing at all.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  bin?: Record<string, string>;
  files?: string[];
};

describe("published manifest", () => {
  it("declares a bin npm will not strip", () => {
    const bin = pkg.bin ?? {};
    expect(Object.keys(bin)).not.toHaveLength(0);
    for (const [name, target] of Object.entries(bin)) {
      // npm >= 11 rejects a leading "./" and drops the whole entry for it.
      expect(target, `bin[${name}] must not start with "./"`).not.toMatch(/^\.\//);
      expect(target, `bin[${name}] must be repo-relative`).not.toMatch(/^\//);
    }
  });

  it("ships every path the bin and templates resolve through", () => {
    const files = pkg.files ?? [];
    for (const target of Object.values(pkg.bin ?? {})) {
      const top = target.split("/")[0];
      expect(files, `${target} is not covered by "files"`).toContain(top);
    }
    // `init` reads its scaffold from templates/ at runtime, so an unshipped
    // templates/ would break the command only once installed from the registry.
    expect(files).toContain("templates");
  });
});
