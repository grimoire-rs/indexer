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
  repository?: { type?: string; url?: string };
};

/** The repo provenance attests to. A mismatch is rejected at publish time. */
const REPO = "github.com/grimoire-rs/indexer";

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

  // Everything under templates/ is written verbatim into somebody else's
  // repository and then read back in CI logs, forge diff views, terminals and
  // editors whose encoding this package does not get to choose. A generated
  // file is worse than an ordinary one: the index owner cannot fix a stray em
  // dash in it without tripping the drift guard. So the scaffold is ASCII,
  // while this repo's own prose is free not to be.
  it("keeps the scaffold ASCII", () => {
    const walk = (at: string): string[] =>
      fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(at, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });

    for (const file of walk(path.join(root, "templates"))) {
      const offending = [...fs.readFileSync(file, "utf8")].filter((ch) => ch.charCodeAt(0) > 127);
      expect(
        [...new Set(offending)].join(""),
        `${path.relative(root, file)} carries non-ASCII`,
      ).toBe("");
    }
  });

  // Trusted publishing attaches a sigstore provenance bundle naming the repo
  // that built the tarball. npm cross-checks it against `repository.url` and
  // rejects the publish with a 422 if they disagree — which is only visible
  // server-side, after the release workflow has already done all its work.
  it("declares the repository provenance will attest to", () => {
    const url = pkg.repository?.url ?? "";
    expect(url, "repository.url is required for provenance").not.toBe("");
    expect(url).toContain(REPO);
  });
});
