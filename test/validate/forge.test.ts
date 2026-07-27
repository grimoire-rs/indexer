// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { afterEach, describe, expect, it, vi } from "vitest";

import { createForge } from "../../src/validate/adapters/forge.js";
import { stubFetch, type Route } from "./helpers.js";

const API = "https://api.test";

afterEach(() => {
  vi.unstubAllGlobals();
});

function github(routes: (url: string) => Route | null) {
  const calls = stubFetch(routes);
  return { forge: createForge("github", { apiBase: API, token: "t" }), calls };
}

function gitlab(routes: (url: string) => Route | null, minAccessLevel = 30) {
  const calls = stubFetch(routes);
  return {
    forge: createForge("gitlab", { apiBase: API, token: "t", minAccessLevel }),
    calls,
  };
}

const json = (value: unknown): Route => ({ body: JSON.stringify(value) });

describe("github forge", () => {
  it("resolves a user namespace to its numeric id", async () => {
    const { forge } = github((url) =>
      url === `${API}/users/acme` ? json({ id: 7, login: "acme", type: "User" }) : null,
    );
    expect(await forge.namespaceIdentity("acme")).toEqual({
      kind: "user",
      id: "7",
      path: "acme",
    });
  });

  it("distinguishes organizations", async () => {
    const { forge } = github(() => json({ id: 12, login: "acme", type: "Organization" }));
    expect(await forge.namespaceIdentity("acme")).toMatchObject({ kind: "org", id: "12" });
  });

  it("returns null for an unknown or id-less namespace", async () => {
    const missing = github(() => ({ status: 404 }));
    expect(await missing.forge.namespaceIdentity("acme")).toBeNull();
    vi.unstubAllGlobals();
    const idless = github(() => json({ login: "acme", type: "User" }));
    expect(await idless.forge.namespaceIdentity("acme")).toBeNull();
  });

  it("treats public membership as org ownership", async () => {
    const { forge, calls } = github((url) =>
      url === `${API}/orgs/acme/public_members/dev` ? { status: 204 } : { status: 404 },
    );
    expect(await forge.isMember("acme", { login: "dev", id: "5" })).toBe(true);
    expect(await forge.isMember("acme", { login: "mallory", id: "6" })).toBe(false);
    expect(calls[0]?.headers.Authorization).toBe("Bearer t");
  });

  it("encodes the namespace into the URL", async () => {
    const { forge, calls } = github(() => ({ status: 404 }));
    await forge.namespaceIdentity("a/../b");
    expect(calls[0]?.url).toBe(`${API}/users/a%2F..%2Fb`);
  });
});

describe("gitlab forge", () => {
  // Port of test_namespace_info_user_fallback: /namespaces is membership-scoped,
  // so a bot token cannot see foreign user namespaces.
  it("falls back to the public /users lookup for user namespaces", async () => {
    const { forge } = gitlab((url) =>
      url.startsWith(`${API}/namespaces/`)
        ? { status: 404 }
        : json([{ id: 5, username: "Acme" }]),
    );
    expect(await forge.namespaceIdentity("acme")).toEqual({
      kind: "user",
      id: "5",
      path: "Acme",
    });
  });

  it("carries the USER id even when the namespace is visible", async () => {
    const { forge } = gitlab((url) =>
      url.startsWith(`${API}/namespaces/`)
        ? json({ kind: "user", id: 999, full_path: "acme" })
        : json([{ id: 5, username: "acme" }]),
    );
    expect(await forge.namespaceIdentity("acme")).toMatchObject({ id: "5" });
  });

  it("returns null when the namespace is unknown or ambiguous", async () => {
    const unknown = gitlab((url) =>
      url.startsWith(`${API}/namespaces/`) ? { status: 404 } : json([]),
    );
    expect(await unknown.forge.namespaceIdentity("acme")).toBeNull();
    vi.unstubAllGlobals();

    // Only an exact (case-insensitive) username hit counts.
    const substring = gitlab((url) =>
      url.startsWith(`${API}/namespaces/`) ? { status: 404 } : json([{ id: 6, username: "acme2" }]),
    );
    expect(await substring.forge.namespaceIdentity("acme")).toBeNull();
  });

  it("passes group namespaces through with the group id", async () => {
    const { forge, calls } = gitlab(() => json({ kind: "group", id: 44, full_path: "platform/ai" }));
    expect(await forge.namespaceIdentity("platform/ai")).toEqual({
      kind: "group",
      id: "44",
      path: "platform/ai",
    });
    expect(calls[0]?.url).toBe(`${API}/namespaces/platform%2Fai`);
    expect(calls[0]?.headers["PRIVATE-TOKEN"]).toBe("t");
  });

  it("requires the configured access level, inherited membership included", async () => {
    const developer = gitlab(() => json({ access_level: 30 }));
    expect(await developer.forge.isMember("platform/ai", { login: "dev", id: "5" })).toBe(true);
    vi.unstubAllGlobals();

    const reporter = gitlab(() => json({ access_level: 20 }));
    expect(await reporter.forge.isMember("platform/ai", { login: "dev", id: "5" })).toBe(false);
    vi.unstubAllGlobals();

    const nonMember = gitlab(() => ({ status: 404 }));
    expect(await nonMember.forge.isMember("platform/ai", { login: "dev", id: "5" })).toBe(false);
  });

  it("refuses a non-numeric author id instead of putting it in a URL", async () => {
    const { forge, calls } = gitlab(() => json({ access_level: 50 }));
    expect(await forge.isMember("platform/ai", { login: "dev", id: "5 or 1=1" })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("queries membership through /members/all/", async () => {
    const { forge, calls } = gitlab(() => json({ access_level: 40 }));
    await forge.isMember("platform/ai", { login: "dev", id: "5" });
    expect(calls[0]?.url).toBe(`${API}/groups/platform%2Fai/members/all/5`);
  });
});
