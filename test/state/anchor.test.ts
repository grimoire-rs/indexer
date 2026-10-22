// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { anchorRoot, anchorSite, readRoot } from "../../src/state/anchor.js";
import { request } from "../../src/validate/adapters/http.js";
import { stubFetch } from "../validate/helpers.js";

// Passes through unless a test says otherwise: the one seam for "request() itself threw".
vi.mock("../../src/validate/adapters/http.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/validate/adapters/http.js")>();
  return { ...original, request: vi.fn(original.request) };
});

const SITE = "https://index.example.test";
const HEX = "a".repeat(64);
const root = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    flat: null,
    generated_at: "2026-10-21T08:00:00Z",
    generation: 1_792_000_000,
    planes: { catalog: null, enrich: { sha256: HEX, size: 10 } },
    schema: 1,
    search: null,
    stats: { sha256: "b".repeat(64), size: 5 },
    ...over,
  });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("anchorSite (IX-R28, D22)", () => {
  it.each([
    ["https", "https://index.example.test", "https://index.example.test"],
    ["a trailing slash", "https://index.example.test/", "https://index.example.test"],
    ["http on localhost", "http://localhost:4321", "http://localhost:4321"],
    ["http on 127.0.0.1", "http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http on [::1]", "http://[::1]:8080", "http://[::1]:8080"],
  ])("qualifies %s", (_name, site, expected) => {
    expect(anchorSite(site)).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["an unset site", undefined],
    ["http on a public host", "http://index.example.test"],
    ["an unparseable site", "not a url"],
    ["another scheme", "ftp://index.example.test"],
  ])("warns and returns no anchor for %s", (_name, site) => {
    expect(anchorSite(site)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("readRoot", () => {
  it("reads <site>/c/root.json behind a nonce, asking for gzip, without following redirects", async () => {
    const calls = stubFetch(() => ({ body: root() }));

    const got = await readRoot(SITE);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/^https:\/\/index\.example\.test\/c\/root\.json\?[0-9a-f]{8,}$/);
    expect(calls[0]?.headers["Accept-Encoding"]).toBe("gzip");
    expect(calls[0]?.redirect).toBe("manual");
    expect(got?.generation).toBe(1_792_000_000);
    expect(got?.planes.enrich).toEqual({ sha256: HEX, size: 10 });
    expect(got?.stats).toEqual({ sha256: "b".repeat(64), size: 5 });
  });

  it("uses a fresh nonce per read, so an edge cache cannot serve the previous generation", async () => {
    const calls = stubFetch(() => ({ body: root() }));
    await readRoot(SITE);
    await readRoot(SITE);
    expect(calls[0]?.url).not.toBe(calls[1]?.url);
  });

  it("treats a 404 as no root, quietly", async () => {
    stubFetch(() => null);
    expect(await readRoot(SITE)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["a 500", { status: 500, body: "" }],
    ["a redirect", { status: 302, body: "" }],
    ["an HTML 200", { body: "<!doctype html><title>x</title>" }],
    ["an oversize body", { body: " ".repeat(64 * 1024 + 1) }],
    ["a non-object", { body: "[]" }],
    ["an unknown schema", { body: root({ schema: 2 }) }],
    ["a non-integer generation", { body: root({ generation: "1" }) }],
    ["an unsafe generation", { body: root({ generation: 2 ** 53 }) }],
    ["an untyped planes.enrich", { body: root({ planes: { catalog: null, enrich: "x" } }) }],
    ["a malformed digest", { body: root({ planes: { catalog: null, enrich: { sha256: "../x", size: 1 } } }) }],
    ["a malformed stats ref", { body: root({ stats: { sha256: HEX } }) }],
  ])("warns and returns no root for %s", async (_name, route) => {
    stubFetch(() => route);
    expect(await readRoot(SITE)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("IX-R28 never throws, even when the request helper does", async () => {
    vi.mocked(request).mockRejectedValueOnce(new Error("socket hang up"));
    expect(await readRoot(SITE)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().join("\n")).toMatch(/socket hang up/);
  });

  it("returns no root when the request never completes", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));
    expect(await readRoot(SITE)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("anchorRoot", () => {
  it("makes no request without a qualifying site", async () => {
    const calls = stubFetch(() => ({ body: root() }));
    expect(await anchorRoot(undefined)).toBeNull();
    expect(await anchorRoot("http://index.example.test")).toBeNull();
    expect(calls).toEqual([]);
  });
});
