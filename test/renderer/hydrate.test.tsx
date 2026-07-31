// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Hydration fidelity for the catalog island.
 *
 * Preact does not diff props while hydrating — its own source says so, and
 * only re-applies props whose value is a function:
 *
 *     } else if ((!isHydrating || typeof value == 'function') && …) {
 *       setProperty(dom, i, value, oldProps[i], namespace);
 *
 * Text children *are* diffed. So a first client render that does not match
 * the server's produces cards whose visible text is right and whose every
 * attribute belongs to whichever package the server put at that position —
 * a logo from one package above a name from another, and a link that opens
 * the wrong page. Nothing throws, and nothing looks broken in a snapshot of
 * the text.
 *
 * The island therefore has one hard rule: **its first render must not depend
 * on the URL**, because the server cannot see the URL. The query is applied
 * immediately afterwards, before paint. These tests pin that.
 */
import { hydrate, render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import Catalog from "../../src/renderer/astro/components/Catalog.tsx";
import type { CatalogPackage } from "../../src/renderer/types.js";

// Normally injected by Vite `define` at build time.
(globalThis as Record<string, unknown>).__GRIMOIRE_BASE__ = "/";

const PACKAGES = [
  { namespace: "acme", name: "alpha", kind: "skill", logo: "/alpha.svg", ref: "r.test/acme/alpha" },
  { namespace: "acme", name: "bravo", kind: "rule", logo: "/bravo.svg", ref: "r.test/acme/bravo" },
  {
    namespace: "acme",
    name: "charlie",
    kind: "skill",
    logo: "/charlie.svg",
    ref: "r.test/acme/charlie",
  },
] as unknown as CatalogPackage[];

/** What the build ships: every package, because the server has no `location`. */
function serverMarkup(): string {
  const host = document.createElement("div");
  render(<Catalog packages={PACKAGES} vscodeExtension={null} />, host);
  const html = host.innerHTML;
  render(null, host);
  return html;
}

/** Hydrate the island over `markup` with `?q=` already in the URL. */
function hydrateWithQuery(markup: string, query: string): HTMLElement {
  history.replaceState({}, "", `/?q=${encodeURIComponent(query)}`);
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.append(host);
  hydrate(<Catalog packages={PACKAGES} vscodeExtension={null} />, host);
  return host;
}

/** Each visible card as (name from text, logo src, link href). */
function cards(host: HTMLElement) {
  return [...host.querySelectorAll("li.card")].map((card) => ({
    name: card.querySelector("h2 a")?.textContent?.trim(),
    logo: card.querySelector("img")?.getAttribute("src"),
    href: card.querySelector("h2 a")?.getAttribute("href"),
  }));
}

describe("catalog hydration with a seeded query", () => {
  let markup: string;

  beforeEach(() => {
    history.replaceState({}, "", "/");
    markup = serverMarkup();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    delete document.documentElement.dataset.query;
  });

  it("renders every package on the server, whatever the URL says", () => {
    // The guard on the whole thing: if this render ever starts reading
    // `location`, the markup the browser hydrates against stops matching and
    // every assertion below becomes vacuous.
    history.replaceState({}, "", "/?q=charlie");
    const host = document.createElement("div");
    render(<Catalog packages={PACKAGES} vscodeExtension={null} />, host);
    expect(host.querySelectorAll("li.card")).toHaveLength(PACKAGES.length);
  });

  it("gives a filtered card its own logo and link, not the ones at its index", async () => {
    const host = hydrateWithQuery(markup, "charlie");
    // The query is applied in a layout effect, so let the rerender land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cards(host)).toEqual([
      { name: "charlie", logo: "/charlie.svg", href: "/p/acme/charlie/" },
    ]);
  });

  it("reveals the catalog once the filtered render is in the DOM", async () => {
    document.documentElement.dataset.query = "charlie";
    hydrateWithQuery(markup, "charlie");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.documentElement.dataset.query).toBeUndefined();
  });

  it("puts the seeded query in the search box", async () => {
    const host = hydrateWithQuery(markup, "charlie");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("charlie");
  });
});
