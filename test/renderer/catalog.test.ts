// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `addRegistryUrl` is a trust boundary in reverse: the extension's URI
// handler refuses anything it should not write, and this mirrors those rules
// so a config that cannot produce a working link renders no button rather
// than one that silently does nothing when clicked.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addRegistryUrl,
  externalUrl,
  indexAgo,
  lastUpdated,
  resolveMemberRef,
  vscodeUrl,
} from "../../src/renderer/astro/lib/catalog.js";
import type { CatalogPackage } from "../../src/renderer/types.js";

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

  it("carries the scope the picker beside it names", () => {
    const registry = { alias: "hub", index: "https://index.grimoire.rs" };

    // `scope=` is what the extension reads to override its host-derived
    // default, so picking Global on the page cannot land a project write.
    for (const scope of ["global", "project"] as const) {
      const parsed = new URLSearchParams(new URL(addRegistryUrl(EXT, registry, scope)!).search);
      expect(parsed.get("scope")).toBe(scope);
      expect(parsed.get("alias")).toBe("hub");
    }
    // Omitted rather than guessed, which leaves the extension on its default.
    expect(addRegistryUrl(EXT, registry)).not.toContain("scope");
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

// The registry hands the index these strings; the index puts them in an
// `href`. Escaping does not make that safe — `javascript:` is a well-formed
// attribute value that runs on click — so the scheme is what decides.
describe("externalUrl", () => {
  it("passes an ordinary link through exactly as the registry spelled it", () => {
    expect(externalUrl("https://acme.example/foo")).toBe("https://acme.example/foo");
    // Not `URL.href`: normalising would republish a link the publisher did
    // not write, trailing slash and all.
    expect(externalUrl("https://acme.example")).toBe("https://acme.example");
    expect(externalUrl("http://acme.example/foo")).toBe("http://acme.example/foo");
    expect(externalUrl("  https://acme.example/foo  ")).toBe("https://acme.example/foo");
  });

  it("reads a bare address as the mailto it obviously is", () => {
    expect(externalUrl("support@acme.example")).toBe("mailto:support@acme.example");
    expect(externalUrl("mailto:support@acme.example")).toBe("mailto:support@acme.example");
  });

  it("refuses every scheme a package page has no business carrying", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      // A relative path is not an outbound link; it would resolve against
      // this site and point at a page that does not exist.
      "/etc/passwd",
      "acme.example/foo",
    ]) {
      expect(externalUrl(hostile), hostile).toBeNull();
    }
  });

  it("treats anything that is not a non-empty string as no link", () => {
    expect(externalUrl(undefined)).toBeNull();
    expect(externalUrl(null)).toBeNull();
    expect(externalUrl("")).toBeNull();
    expect(externalUrl("   ")).toBeNull();
    expect(externalUrl(42)).toBeNull();
    expect(externalUrl({ href: "https://acme.example" })).toBeNull();
  });
});

describe("lastUpdated", () => {
  const pkg = (fields: Partial<CatalogPackage>) => fields as CatalogPackage;

  it("prefers the date enrich derived over the artifact's own", () => {
    // They agree for every artifact that carries a `created`; they disagree
    // for one that does not, where `updated` is the only date there is.
    expect(
      lastUpdated(pkg({ created: "2026-01-01T00:00:00Z", updated: "2026-08-02T11:15:00Z" })),
    ).toBe("2026-08-02T11:15:00Z");
    expect(lastUpdated(pkg({ updated: "2026-08-02T11:15:00Z" }))).toBe("2026-08-02T11:15:00Z");
  });

  it("falls back to created for a sidecar written before updated existed", () => {
    expect(lastUpdated(pkg({ created: "2026-01-01T00:00:00Z" }))).toBe("2026-01-01T00:00:00Z");
  });

  it("is undefined when the package carries no date at all", () => {
    expect(lastUpdated(pkg({}))).toBeUndefined();
  });
});

// The catalog's own render stamp is the one date in this codebase that starts
// at zero, so it is the only one that ever reaches `timeAgo`'s seconds
// division. `indexAgo` is the floor that keeps it out.
describe("indexAgo", () => {
  const AT = "2026-01-01T12:00:00Z";
  const at = (offsetMs: number) => {
    vi.setSystemTime(new Date(Date.parse(AT) + offsetMs));
    return indexAgo(AT);
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says less than a minute for the whole first minute", () => {
    vi.useFakeTimers();
    // A freshly deployed index, read immediately: never "0 seconds ago".
    expect(at(0)).toBe("less than a minute ago");
    expect(at(25_000)).toBe("less than a minute ago");
    expect(at(59_999)).toBe("less than a minute ago");
  });

  it("counts in minutes and up from there", () => {
    vi.useFakeTimers();
    expect(at(60_000)).toBe("1 minute ago");
    expect(at(120_000)).toBe("2 minutes ago");
    expect(at(3 * 3_600_000)).toBe("3 hours ago");
  });

  it("reads a stamp from the future as fresh, not as a countdown", () => {
    vi.useFakeTimers();
    // A reader whose own clock is behind. "in 4 minutes" would be the index
    // telling them it has not been published yet.
    expect(at(-4 * 60_000)).toBe("less than a minute ago");
  });

  it("renders nothing for an unparseable stamp, as timeAgo does", () => {
    expect(indexAgo("not a date")).toBe("");
  });
});
