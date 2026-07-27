// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";

import type { NamespaceIdentity } from "../../src/validate/adapters/forge.js";
import {
  botOwnsNamespace,
  findTrustedBot,
  namespaceOwned,
} from "../../src/validate/core/ownership.js";

const user = (over: Partial<NamespaceIdentity> = {}): NamespaceIdentity => ({
  kind: "user",
  id: "9",
  path: "Acme",
  ...over,
});

describe("namespaceOwned", () => {
  it("accepts a user namespace only on login *and* id match", () => {
    expect(namespaceOwned("acme", user(), { login: "ACME", id: "9" }, false)).toBe(true);
    // A login match alone is one rename away from being someone else.
    expect(namespaceOwned("acme", user(), { login: "ACME", id: "1" }, false)).toBe(false);
    expect(namespaceOwned("acme", user(), { login: "mallory", id: "2" }, false)).toBe(false);
    // Membership never rescues a user namespace.
    expect(namespaceOwned("acme", user(), { login: "mallory", id: "2" }, true)).toBe(false);
  });

  it("delegates org and group namespaces to the membership probe", () => {
    const group: NamespaceIdentity = { kind: "group", id: "44", path: "platform/ai" };
    expect(namespaceOwned("platform/ai", group, { login: "dev", id: "5" }, true)).toBe(true);
    expect(namespaceOwned("platform/ai", group, { login: "dev", id: "5" }, false)).toBe(false);
    const org: NamespaceIdentity = { kind: "org", id: "12", path: "acme" };
    expect(namespaceOwned("acme", org, { login: "dev", id: "5" }, true)).toBe(true);
  });
});

describe("trusted bots", () => {
  it("matches the login case-insensitively", () => {
    expect(findTrustedBot(["Announce[bot]"], "announce[bot]")).toMatchObject({
      namespaces: ["*"],
    });
    expect(findTrustedBot(["announce[bot]"], "mallory")).toBeNull();
    expect(findTrustedBot(undefined, "announce[bot]")).toBeNull();
    expect(findTrustedBot([], "announce[bot]")).toBeNull();
  });

  it("pins the numeric account id when configured", () => {
    const grant = findTrustedBot(
      [{ login: "announce[bot]", id: "77", namespaces: ["*"] }],
      "announce[bot]",
    );
    expect(grant).not.toBeNull();
    expect(botOwnsNamespace(grant!, "anything", "77")).toBe(true);
    expect(botOwnsNamespace(grant!, "anything", "78")).toBe(false);
  });

  it("scopes a bot to its namespaces", () => {
    const grant = findTrustedBot(
      [{ login: "scoped-bot", id: "88", namespaces: ["platform/ai"] }],
      "scoped-bot",
    );
    expect(botOwnsNamespace(grant!, "platform/ai", "88")).toBe(true);
    expect(botOwnsNamespace(grant!, "PLATFORM/AI", "88")).toBe(true);
    expect(botOwnsNamespace(grant!, "other", "88")).toBe(false);
  });

  it("treats a bare string as unpinned and unscoped", () => {
    const grant = findTrustedBot(["announce[bot]"], "announce[bot]");
    expect(botOwnsNamespace(grant!, "anything", "whatever")).toBe(true);
  });
});
