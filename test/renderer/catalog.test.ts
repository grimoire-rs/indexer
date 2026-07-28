// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `addRegistryUrl` is a trust boundary in reverse: the extension's URI
// handler refuses anything it should not write, and this mirrors those rules
// so a config that cannot produce a working link renders no button rather
// than one that silently does nothing when clicked.
import { describe, expect, it } from "vitest";

import {
  addRegistryUrl,
  resolveMemberRef,
  vscodeUrl,
} from "../../src/renderer/astro/lib/catalog.js";

const EXT = "grimoire-rs.grimoire-vscode";

describe("addRegistryUrl", () => {
  it("builds the link the extension's /add-registry handler parses", () => {
    const url = addRegistryUrl(EXT, { alias: "hub", index: "https://index.grimoire.rs" });

    expect(url).toBe(
      `vscode://${EXT}/add-registry?index=https%3A%2F%2Findex.grimoire.rs%2F&alias=hub`,
    );
    // Round-trips through the same parse the extension does.
    const parsed = new URLSearchParams(new URL(url!).search);
    expect(parsed.get("alias")).toBe("hub");
    expect(parsed.get("index")).toBe("https://index.grimoire.rs/");
  });

  it("is null when there is nothing to link to", () => {
    expect(addRegistryUrl(null, { alias: "hub", index: "https://index.test" })).toBeNull();
    expect(addRegistryUrl(EXT, null)).toBeNull();
  });

  it("refuses an alias the handler would reject", () => {
    for (const alias of ["", "-lead", "has.dot", "has space", 'quo"te', "a".repeat(33)]) {
      expect(addRegistryUrl(EXT, { alias, index: "https://index.test" }), alias).toBeNull();
    }
  });

  it("refuses a locator the handler would reject", () => {
    for (const index of [
      "http://index.test", // downgrades the fetch the credentials go to
      "https://user:pass@index.test", // would persist a secret into grimoire.toml
      "ftp://index.test",
      "not a url",
      `https://index.test/${"a".repeat(2100)}`,
    ]) {
      expect(addRegistryUrl(EXT, { alias: "hub", index }), index).toBeNull();
    }
  });
});

describe("vscodeUrl", () => {
  it("encodes the ref it carries", () => {
    expect(vscodeUrl(EXT, "ghcr.io/acme/skills/foo:1.0.0")).toBe(
      `vscode://${EXT}/open?repo=ghcr.io%2Facme%2Fskills%2Ffoo%3A1.0.0`,
    );
  });

  it("is null when no extension is configured", () => {
    expect(vscodeUrl(null, "ghcr.io/acme/skills/foo")).toBeNull();
  });
});

describe("resolveMemberRef", () => {
  const BUNDLE = "ghcr.io/acme/bundles/starter-pack";

  it("resolves the relative ids grim writes into a bundle", () => {
    // Relative so a mirrored namespace keeps working; the catalog keys on the
    // absolute, untagged ref.
    expect(resolveMemberRef(BUNDLE, "../skills/code-review:0")).toBe(
      "ghcr.io/acme/skills/code-review",
    );
    expect(resolveMemberRef(BUNDLE, "./sibling:1.2.3")).toBe("ghcr.io/acme/bundles/sibling");
    expect(resolveMemberRef(BUNDLE, "../../other/thing")).toBe("ghcr.io/other/thing");
  });

  it("passes an absolute id through, tag and digest stripped", () => {
    expect(resolveMemberRef(BUNDLE, "ghcr.io/other/elsewhere:2")).toBe("ghcr.io/other/elsewhere");
    expect(resolveMemberRef(BUNDLE, "ghcr.io/other/elsewhere@sha256:abc")).toBe(
      "ghcr.io/other/elsewhere",
    );
  });

  it("does not mistake a registry port for a tag", () => {
    expect(resolveMemberRef("localhost:5000/acme/bundles/x", "../skills/y:0")).toBe(
      "localhost:5000/acme/skills/y",
    );
    expect(resolveMemberRef(BUNDLE, "localhost:5000/acme/y")).toBe("localhost:5000/acme/y");
  });
});
