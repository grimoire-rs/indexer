// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// @vitest-environment jsdom
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import Catalog from "../../src/renderer/astro/components/Catalog.tsx";
import { Harnesses } from "../../src/renderer/astro/components/Harnesses.tsx";
import { cardPackage, validServes } from "../../src/renderer/astro/lib/catalog.js";
import type { CatalogPackage } from "../../src/renderer/types.js";

(globalThis as Record<string, unknown>).__GRIMOIRE_BASE__ = "/";

const BUILT_AT = "2026-01-01T00:00:00Z";
const pkg = (name: string, serves?: unknown): CatalogPackage =>
  ({ namespace: "acme", name, kind: "mod", logo: `/${name}.svg`, ref: `r.test/acme/${name}`, ...(serves !== undefined && { serves }) }) as unknown as CatalogPackage;

const DATA = [
  pkg("pair", ["claude", "opencode"]),
  pkg("odd", ["claude", "zed"]),
  pkg("bare"),
];

const mounted: HTMLElement[] = [];
function mount(url: string, packages = DATA, view?: "table"): HTMLElement {
  history.replaceState({}, "", url);
  if (view) localStorage.setItem("grim.catalog.view", view);
  const host = document.createElement("div");
  document.body.append(host);
  mounted.push(host);
  render(<Catalog packages={packages} vscodeExtension={null} builtAt={BUILT_AT} />, host);
  return host;
}
afterEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  localStorage.clear();
  history.replaceState({}, "", "/");
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const names = (host: HTMLElement) =>
  [...host.querySelectorAll("li.card h2 a, a.row .t-name")].map((e) => e.textContent?.trim());
const harnessChips = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>(".harness-chips button")].map((b) => b.textContent?.trim());

describe("validServes", () => {
  it.each([undefined, null, [], "claude", [1], ["Claude"], ["a b"], ["../x"], [""]])("treats %j as absent", (v) => {
    expect(validServes(v)).toBeUndefined();
  });
  it("keeps a valid list in order", () => {
    expect(validServes(["claude", "opencode"])).toEqual(["claude", "opencode"]);
  });
  it("is dropped by the card projection when invalid", () => {
    expect(cardPackage(pkg("x", ["Bad!"])).serves).toBeUndefined();
    expect(cardPackage(pkg("x", ["claude"])).serves).toEqual(["claude"]);
  });
});

describe("Harnesses badges", () => {
  const html = (serves: unknown) => {
    const host = document.createElement("div");
    render(<Harnesses serves={serves} />, host);
    return host;
  };

  it("labels the group, keeps the order, and marks only claude", () => {
    const host = html(["claude", "opencode"]);
    expect(host.querySelector(".harnesses")?.getAttribute("aria-label")).toBe("Serves claude, opencode");
    const badges = [...host.querySelectorAll(".harness")];
    expect(badges.map((b) => b.textContent?.trim())).toEqual(["claude", "opencode"]);
    expect(badges[0]!.querySelector("svg")).not.toBeNull();
    expect(badges[1]!.querySelector("svg")).toBeNull();
  });

  it("renders an unknown name as plain text and nothing without serves", () => {
    expect(html(["zed"]).querySelector(".harness svg")).toBeNull();
    expect(html(["zed"]).textContent).toBe("zed");
    expect(html(undefined).innerHTML).toBe("");
  });

  it("shows on the card and on the row, and only for a package that serves", () => {
    for (const view of [undefined, "table" as const]) {
      const host = mount("/", DATA, view);
      const groups = [...host.querySelectorAll(".harnesses")].map((g) => g.getAttribute("aria-label")).sort();
      expect(groups, String(view)).toEqual(["Serves claude, opencode", "Serves claude, zed"]);
      for (const m of mounted.splice(0)) render(null, m);
      localStorage.clear();
    }
  });
});

describe("harness filter", () => {
  it("offers the harness names in the data, sorted, and hides itself with none", async () => {
    const host = mount("/");
    await settle();
    expect(harnessChips(host)).toEqual(["claude", "opencode", "zed"]);

    const none = mount("/", [pkg("bare")]);
    await settle();
    expect(none.querySelector(".harness-chips")).toBeNull();
  });

  it("matches any selected harness and hides a package with no serves", async () => {
    const host = mount("/?harness=opencode");
    await settle();
    expect(names(host)).toEqual(["pair"]);
    const both = mount("/?harness=opencode,zed");
    await settle();
    expect(names(both).sort()).toEqual(["odd", "pair"]);
  });

  it("restores from the URL, drops invalid or absent values, and rewrites the address", async () => {
    const host = mount("/?harness=zed,nope,../etc,Claude");
    await settle();
    const pressed = [...host.querySelectorAll<HTMLElement>(".harness-chips button[aria-pressed=true]")].map((b) => b.textContent?.trim());
    expect(pressed).toEqual(["zed"]);
    await vi.waitFor(() => expect(location.search).toBe("?harness=zed"));
  });

  it("writes the selection to the URL on click", async () => {
    const host = mount("/");
    await settle();
    host.querySelector<HTMLElement>('.harness-chips [data-harness="claude"]')!.click();
    await vi.waitFor(() => expect(location.search).toBe("?harness=claude"));
    expect(names(host).sort()).toEqual(["odd", "pair"]);
  });
});
