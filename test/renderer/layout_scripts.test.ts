// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The layout's inline scripts, executed.
//
// `is:inline` means Astro ships these byte-for-byte where they are authored,
// so running the text straight out of `Base.astro` in a real DOM is running
// what the browser runs — and it is the only way to catch a script block
// that parses fine and dies on its first statement. `build.test.ts` proves
// the same text reaches the page; nothing there executes it.
//
// jsdom is driven directly rather than through vitest's environment: these
// need `runScripts`, a fresh window per case, and no DOM at all in the rest
// of the file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const BASE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/renderer/astro/layouts/Base.astro",
);

/** The layout's `is:inline` scripts, in document order: head, then body. */
function layoutScripts(): [string, string] {
  const src = fs.readFileSync(BASE, "utf8");
  const found = [...src.matchAll(/<script is:inline>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  if (found.length !== 2) {
    throw new Error(`expected the layout's head and body script, found ${found.length}`);
  }
  return [found[0]!, found[1]!];
}

/**
 * One page: the layout's head script, then `body`, then the layout's body
 * script — the order `Base.astro` puts them in.
 *
 * The stub ahead of them supplies the two host APIs jsdom does not implement
 * and the head script reads at parse time. Both are what a browser would
 * have answered; neither is under test.
 */
function renderPage(body: string) {
  const [head, tail] = layoutScripts();
  const { window } = new JSDOM(
    `<!doctype html><html><head>
      <script>
        window.matchMedia = () => ({ matches: false });
        Object.defineProperty(navigator, "userAgentData", { value: { platform: "Windows" } });
      </script>
      <script>${head}</script>
    </head><body>${body}<script>${tail}</script></body></html>`,
    { runScripts: "dangerously", url: "https://index.example.test/" },
  );
  return window.document;
}

/** What the end of the body script acts on: a code block and the toast. */
const COPYABLE = `
  <pre class="astro-code">grim add acme/thing</pre>
  <div id="copy-toast"><span class="toast-name"></span><code class="toast-value"></code></div>
`;

/** A command bar asking to be preselected, offering two platforms. */
const DETECTING_BAR = `
  <div class="cmd-bar" data-os-switch data-os-detect data-os-noun="install command">
    <div data-copy="curl https://setup.example.test/sh | sh" data-copy-name="Linux install command">
      <code>curl https://setup.example.test/sh | sh</code>
    </div>
    <button data-os-pick="curl https://setup.example.test/sh | sh" data-os-name="Linux" aria-checked="true"></button>
    <button data-os-pick="irm https://setup.example.test/ps1 | iex" data-os-name="Windows" aria-checked="false"></button>
  </div>
`;

describe("C-012 — the layout's scripts do not depend on the header", () => {
  // S-001. An index repo that replaces `SiteHeader.astro` with one carrying
  // no theme toggle leaves `getElementById` returning null, and the whole
  // block after it — copy buttons, picker wiring, toast — died on that one
  // dereference. The injected copy button is the tail of the block, so it
  // exists only if everything above it ran.
  it("wires the copy buttons when no theme toggle is on the page", () => {
    const doc = renderPage(COPYABLE);

    expect(doc.querySelector("#theme-toggle")).toBeNull();
    const block = doc.querySelector(".code-block");
    expect(block, "the code block was never wrapped — an earlier script threw").not.toBeNull();
    expect(block!.querySelector("button.code-copy")).not.toBeNull();
  });

  // …and the toggle still toggles where a header does ship one, which is
  // the half a null-guard could quietly break.
  it("still toggles the theme when the header has one", () => {
    const doc = renderPage(`<button id="theme-toggle"></button>${COPYABLE}`);

    const before = doc.documentElement.dataset.theme;
    doc.getElementById("theme-toggle")!.click();
    expect(doc.documentElement.dataset.theme).not.toBe(before);
  });
});

describe("C-012 — the layout preselects the host platform", () => {
  // S-002. The loop used to live in `pages/index.astro`, so a page under
  // `theme/pages/` drawing `<CommandBar detect />` got the configured first
  // choice however the visitor arrived. Reading it out of the layout is what
  // makes `detect` mean the same thing on every page.
  it("selects the visitor's platform for a detecting bar", () => {
    const doc = renderPage(DETECTING_BAR);

    expect(doc.querySelector('[data-os-name="Windows"]')!.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(doc.querySelector('[data-os-name="Linux"]')!.getAttribute("aria-checked")).toBe(
      "false",
    );
    // The shown command and the copied one are the same node, so this is
    // both halves at once.
    const field = doc.querySelector("[data-copy]")!;
    expect(field.getAttribute("data-copy")).toBe("irm https://setup.example.test/ps1 | iex");
    expect(field.querySelector("code")!.textContent).toBe(
      "irm https://setup.example.test/ps1 | iex",
    );
  });

  // A bar with no `detect` is the configured order, on purpose: the scope
  // picker leads with Global whatever the visitor runs.
  it("leaves a bar that did not ask alone", () => {
    const doc = renderPage(DETECTING_BAR.replace(" data-os-detect", ""));

    expect(doc.querySelector('[data-os-name="Linux"]')!.getAttribute("aria-checked")).toBe("true");
  });
});

/** The registry bar: a scope picker whose choices each carry their own deep
 *  link, plus the action segment that link belongs to. */
const SCOPE_BAR = `
  <div class="cmd-bar" data-os-switch data-os-noun="registry add command">
    <div data-copy="grim --global config registry add hub --index https://index.test/">
      <code>grim --global config registry add hub --index https://index.test/</code>
    </div>
    <button data-os-pick="grim --global config registry add hub --index https://index.test/"
            data-os-name="Global" data-os-href="vscode://ext/add-registry?alias=hub&amp;scope=global"
            aria-checked="true"></button>
    <button data-os-pick="grim config registry add hub --index https://index.test/"
            data-os-name="Project" data-os-href="vscode://ext/add-registry?alias=hub&amp;scope=project"
            aria-checked="false"></button>
    <a data-os-link href="vscode://ext/add-registry?alias=hub&amp;scope=global"></a>
  </div>
`;

describe("C-012 — the scope picker steers the VS Code link too", () => {
  // The extension honours `scope=` on `/add-registry`, so the button has to
  // follow the picker: someone who picked Project and clicked the icon used
  // to get the global write the initial href named.
  it("rewrites the action link when a scope is picked", () => {
    const doc = renderPage(SCOPE_BAR);

    doc.querySelector<HTMLElement>('[data-os-name="Project"]')!.click();

    expect(doc.querySelector("[data-os-link]")!.getAttribute("href")).toBe(
      "vscode://ext/add-registry?alias=hub&scope=project",
    );
  });

  // The install bar has an action link too — the marketplace page — and its
  // platform choices carry no href. Blanking it on every pick would drop it.
  it("leaves an action link alone for a choice carrying no href", () => {
    const doc = renderPage(
      DETECTING_BAR.replace("</div>\n", '<a data-os-link href="https://marketplace.test/"></a></div>\n'),
    );

    expect(doc.querySelector("[data-os-link]")!.getAttribute("href")).toBe(
      "https://marketplace.test/",
    );
  });
});
