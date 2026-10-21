// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config.js";
import {
  derivedIndex,
  registryAddCommand,
  registryScopeChoices,
} from "../../src/renderer/astro/lib/commands.js";

const site = "https://acme.github.io/index/";

describe("a registry with no index", () => {
  const config = resolveConfig({ site, registry: { alias: "acme" } });

  it("hands out the site, without its trailing slash", () => {
    expect(registryAddCommand(config)).toBe(
      "grim config registry add acme --index https://acme.github.io/index",
    );
  });

  it("puts the site in the VS Code deep link", () => {
    const href = registryScopeChoices(config)[0]!.href!;
    expect(new URL(href).searchParams.get("index")).toBe("https://acme.github.io/index");
  });

  it("asks the page to swap the site for its own address", () => {
    expect(derivedIndex(config)).toBe("https://acme.github.io/index");
  });
});

describe("a registry with an index", () => {
  const config = resolveConfig({ site, registry: { alias: "acme", index: "https://packages.acme.test" } });

  it("hands out the configured index, and the page leaves it alone", () => {
    expect(registryAddCommand(config)).toBe(
      "grim config registry add acme --index https://packages.acme.test",
    );
    expect(derivedIndex(config)).toBeNull();
  });
});

describe("no registry", () => {
  it("has nothing to hand out or derive", () => {
    const config = resolveConfig({ site, registry: null });
    expect(registryAddCommand(config)).toBeNull();
    expect(derivedIndex(config)).toBeNull();
  });
});
