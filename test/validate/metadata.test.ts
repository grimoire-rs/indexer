// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";

import {
  KINDS,
  MAX_METADATA_BYTES,
  parseMetadataJson,
  parseRef,
  registryHostReason,
  validateMetadata,
} from "../../src/validate/core/metadata.js";

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    name: "tool",
    kind: "skill",
    ref: "reg.example.com/acme/tool",
    description: "d",
    owner: { github: "acme", id: 7 },
    ...overrides,
  };
}

function reasonOf(value: unknown, pkg = "tool"): string {
  const result = validateMetadata(value, pkg);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

describe("validateMetadata", () => {
  it("accepts either owner key", () => {
    expect(validateMetadata(doc({ owner: { login: "acme", id: 7 } }), "tool").ok).toBe(true);
    expect(validateMetadata(doc({ owner: { github: "acme", id: 7 } }), "tool").ok).toBe(true);
  });

  it("requires an owner object with an id and a login", () => {
    expect(reasonOf(doc({ owner: { id: 7 } }))).toContain("owner");
    expect(reasonOf(doc({ owner: { login: "acme" } }))).toContain("owner");
    expect(reasonOf(doc({ owner: "acme" }))).toContain("owner");
    expect(reasonOf(doc({ owner: [{ login: "acme", id: 7 }] }))).toContain("owner");
    expect(reasonOf(doc({ owner: { login: "acme", id: "7" } }))).toContain("owner.id");
    expect(reasonOf(doc({ owner: { login: "acme", id: 7.5 } }))).toContain("owner.id");
  });

  it("accepts every published kind and nothing else", () => {
    for (const kind of KINDS) {
      expect(validateMetadata(doc({ kind }), "tool").ok, kind).toBe(true);
    }
    expect(reasonOf(doc({ kind: "plugin" }))).toContain("kind");
    expect(reasonOf(doc({ kind: 1 }))).toContain("kind");
  });

  it("ties the name to the package directory", () => {
    expect(reasonOf(doc({ name: "other" }))).toContain("directory");
    expect(reasonOf(doc({ name: 1 }))).toContain("directory");
  });

  it("rejects unknown schema versions and missing keys", () => {
    expect(reasonOf(doc({ schema: 2 }))).toContain("schema version");
    expect(reasonOf({ schema: 1 })).toContain("missing keys");
    expect(reasonOf([])).toContain("JSON object");
    expect(reasonOf(null)).toContain("JSON object");
    expect(reasonOf("string")).toContain("JSON object");
  });

  it("requires string ref and description", () => {
    expect(reasonOf(doc({ ref: "" }))).toContain("ref");
    expect(reasonOf(doc({ ref: { host: "x" } }))).toContain("ref");
    expect(reasonOf(doc({ description: 42 }))).toContain("description");
  });
});

describe("parseMetadataJson", () => {
  it("parses a plain document", () => {
    const result = parseMetadataJson(JSON.stringify(doc()));
    expect(result.ok).toBe(true);
  });

  it("refuses prototype-pollution keys at any depth", () => {
    for (const text of [
      '{"__proto__": {"polluted": true}}',
      '{"owner": {"__proto__": {"polluted": true}}}',
      '{"constructor": {"prototype": {"polluted": true}}}',
      '{"a": [{"prototype": 1}]}',
    ]) {
      const result = parseMetadataJson(text);
      expect(result.ok, text).toBe(false);
      expect(result.ok ? "" : result.reason).toContain("forbidden key");
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reports malformed JSON instead of throwing", () => {
    const result = parseMetadataJson("{not json");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("invalid JSON");
  });

  it("refuses an oversized document before parsing it", () => {
    const result = parseMetadataJson(`{"pad":"${"a".repeat(MAX_METADATA_BYTES)}"}`);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("larger than");
  });
});

describe("parseRef", () => {
  it("splits host and repository", () => {
    expect(parseRef("ghcr.io/grimoire-rs/skill")).toEqual({
      ok: true,
      value: { host: "ghcr.io", repository: "grimoire-rs/skill" },
    });
    expect(parseRef("reg.example.com:5000/a/b/c").ok).toBe(true);
  });

  it("rejects refs that are not <host>/<repository>", () => {
    for (const ref of [
      "ghcr.io",
      "/no-host/repo",
      "ghcr.io/",
      "ghcr.io/UPPER/case",
      "ghcr.io/repo:tag",
      "ghcr.io/repo@sha256:abc",
      "ghcr.io/../etc/passwd",
      "user:pass@ghcr.io/repo",
      "ghcr.io/repo?x=1",
      "ghcr.io/repo#frag",
      "ghcr.io/repo space",
    ]) {
      expect(parseRef(ref).ok, ref).toBe(false);
    }
  });
});

describe("registryHostReason", () => {
  it("enforces a configured allowlist", () => {
    expect(registryHostReason("ghcr.io", ["ghcr.io"])).toBeNull();
    expect(registryHostReason("GHCR.IO", ["ghcr.io"])).toBeNull();
    expect(registryHostReason("evil.example.com", ["ghcr.io"])).toContain("allowlist");
  });

  it("keeps a hostile ref off the CI runner's own network", () => {
    for (const host of ["127.0.0.1", "169.254.169.254", "10.0.0.5:5000", "localhost", "registry"]) {
      expect(registryHostReason(host), host).toContain("public DNS name");
    }
    expect(registryHostReason("ghcr.io")).toBeNull();
  });

  it("lets an operator commit an internal host explicitly", () => {
    expect(registryHostReason("10.0.0.5:5000", ["10.0.0.5:5000"])).toBeNull();
  });
});
