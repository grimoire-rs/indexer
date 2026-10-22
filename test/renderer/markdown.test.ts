// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// A README is third-party text rendered into the index's own origin, so the
// markdown pipeline is a trust boundary. These run markdown through the same
// processor the build installs and read the result back with a parser: whether
// an attribute exists is a question for parse5, not for a regex over markup.
import { markdownConfigDefaults } from "@astrojs/markdown-remark";
import { parseFragment } from "parse5";
import { beforeAll, describe, expect, it } from "vitest";
import { SHIKI_CLASSES, SHIKI_THEMES } from "../../src/renderer/astro/lib/code.js";
import { markdownProcessor } from "../../src/renderer/markdown.js";
import { attr, classes, elements, type Element } from "./html.js";
import { expectInert, HOSTILE } from "./inert.js";

let render: (md: string) => Promise<string>;

beforeAll(async () => {
  const renderer = await markdownProcessor().createRenderer({
    ...markdownConfigDefaults,
    shikiConfig: { themes: SHIKI_THEMES, wrap: false, transformers: [SHIKI_CLASSES] },
  });
  render = async (md) => (await renderer.render(md)).code;
});

const byTag = (html: string, tag: string): Element[] => elements(html).filter((el) => el.tagName === tag);

describe("a hostile README", () => {
  it.each(HOSTILE)("%s leaves nothing executable", async (_name, markdown) => {
    expectInert(await render(markdown));
  });

  it("gives every id and name the clobber prefix", async () => {
    const html = await render(HOSTILE.at(-1)![1]);
    const named = elements(html).flatMap((el) => [attr(el, "id"), attr(el, "name")]).filter((v) => v !== undefined);
    expect(named.toSorted()).toEqual(["user-content-Astro", "user-content-querySelectorAll"]);
  });

  it("removes target, so a link cannot open a window that keeps a handle on the page", async () => {
    const html = await render('<a href="https://example.com/" target="_blank">t</a>');
    expect(attr(byTag(html, "a")[0]!, "target")).toBeUndefined();
  });

  it("keeps the text of a link whose URL was refused", async () => {
    const html = await render("[md-js](javascript:alert(1))");
    expect(byTag(html, "a").map((a) => attr(a, "href"))).toEqual([undefined]);
    expect(html).toContain("md-js");
  });

  it("drops the contents of script and style, rather than printing them", async () => {
    const html = await render("before <style>body{display:none}</style><script>alert(1)</script> after");
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });
});

// The build's backstop and the policy both key on this marker, so it comes
// from the pipeline: a theme that replaces the page component keeps both.
it("marks every top-level element as rendered markdown", async () => {
  const html = await render("# h\n\npara\n\n- li\n\n<div>raw</div>\n\n```js\nconst a = 1;\n```\n\n---\n");
  const top = parseFragment(html).childNodes.filter((n) => "tagName" in n);
  expect(top.map((el) => el.tagName)).toEqual(["h1", "p", "ul", "div", "pre", "hr"]);
  expect(top.filter((el) => attr(el, "data-grim-markdown") === undefined)).toEqual([]);
});

describe("a README that is not hostile", () => {
  it("resolves a footnote reference to its definition under a single prefix", async () => {
    const html = await render("Text[^1].\n\n[^1]: The note.\n");
    expect(html).not.toContain("user-content-user-content-");
    const [ref] = byTag(html, "a").filter((a) => attr(a, "data-footnote-ref") !== undefined);
    const [back] = byTag(html, "a").filter((a) => attr(a, "data-footnote-backref") !== undefined);
    const ids = new Set(elements(html).map((el) => attr(el, "id")));
    // Both directions: the reference leads to the note, the note back to the reference.
    expect(ids.has(attr(ref!, "href")!.slice(1)), "reference target").toBe(true);
    expect(ids.has(attr(back!, "href")!.slice(1)), "back-reference target").toBe(true);
    expect(attr(ref!, "href")).toBe(`#${attr(byTag(html, "li")[0]!, "id")}`);
    expect(ids.has(attr(ref!, "aria-describedby")!), "aria-describedby target").toBe(true);
  });

  it("gives headings ids, and an in-page link to one still lands", async () => {
    const html = await render("## My heading\n\n[go](#my-heading)\n");
    expect(attr(byTag(html, "h2")[0]!, "id")).toBe("my-heading");
    expect(attr(byTag(html, "a")[0]!, "href")).toBe("#my-heading");
  });

  it("points a link at a raw anchor's prefixed name", async () => {
    const html = await render('<a name="x"></a>\n\n[jump](#x)\n');
    expect(attr(byTag(html, "a")[0]!, "name")).toBe("user-content-x");
    expect(attr(byTag(html, "a")[1]!, "href")).toBe("#user-content-x");
  });

  it("points a link at a raw element's prefixed id", async () => {
    const html = await render('<h2 id="sec">Sec</h2>\n\n[s](#sec)\n');
    expect(attr(byTag(html, "h2")[0]!, "id")).toBe("user-content-sec");
    expect(attr(byTag(html, "a")[0]!, "href")).toBe("#user-content-sec");
  });

  // remark percent-encodes a link's fragment, but the sanitized id keeps its
  // characters, so the lookup has to decode and the emitted fragment stay encoded.
  it("points a percent-encoded link at a raw element's non-ASCII prefixed id", async () => {
    const html = await render('<h2 id="café">Sec</h2>\n\n[md](#café) <a href="#caf%C3%A9">raw</a> <a href="#café">bare</a>\n');
    expect(attr(byTag(html, "h2")[0]!, "id")).toBe("user-content-café");
    expect(byTag(html, "a").map((a) => attr(a, "href"))).toEqual(Array(3).fill("#user-content-caf%C3%A9"));
  });

  it("points a link with an encoded space at a raw id holding that space", async () => {
    const html = await render('<a name="a b"></a>\n\n[jump](#a%20b)\n');
    expect(attr(byTag(html, "a")[1]!, "href")).toBe("#user-content-a%20b");
  });

  it("leaves a fragment with a malformed escape alone, and still matches an id holding a literal percent", async () => {
    const html = await render('<h2 id="50%">Pct</h2>\n\n[bad](#oops%zz) [md](#50%) <a href="#50%">raw</a>\n');
    expect(byTag(html, "a").map((a) => attr(a, "href"))).toEqual(["#oops%zz", "#user-content-50%25", "#user-content-50%"]);
  });

  it("does not throw on a lone surrogate in a fragment that matches an id", async () => {
    const html = await render('<h2 id="a\ud800">x</h2>\n\n<a href="#a\ud800">raw</a>\n');
    expect(byTag(html, "a").map((a) => attr(a, "href"))).toHaveLength(1);
  });

  it("leaves a link to a missing fragment, and external links, alone", async () => {
    const html = await render("[a](#nowhere) [b](https://example.com/#x)");
    expect(byTag(html, "a").map((a) => attr(a, "href"))).toEqual(["#nowhere", "https://example.com/#x"]);
  });

  it("renders tables with alignment as an attribute, not a style", async () => {
    const html = await render("| a | b |\n|---|:-:|\n| 1 | 2 |\n");
    for (const tag of ["table", "thead", "tbody", "tr", "th", "td"]) expect(byTag(html, tag).length, tag).toBeGreaterThan(0);
    expect(byTag(html, "th").map((th) => attr(th, "align"))).toEqual([undefined, "center"]);
    expectInert(html);
  });

  it("renders task-list checkboxes as disabled checkboxes", async () => {
    const html = await render("- [ ] todo\n- [x] done\n");
    const boxes = byTag(html, "input");
    expect(boxes.map((b) => attr(b, "type"))).toEqual(["checkbox", "checkbox"]);
    expect(boxes.map((b) => attr(b, "disabled") !== undefined)).toEqual([true, true]);
    expect(boxes.map((b) => attr(b, "checked") !== undefined)).toEqual([false, true]);
    expect(classes(byTag(html, "li")[0]!)).toContain("task-list-item");
  });

  it("keeps details, summary, kbd, sub, sup, small and abbr", async () => {
    const html = await render(
      "<details open><summary>More</summary>body</details>\n\n<kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup> <small>fine</small> <abbr title=\"Index\">IDX</abbr>\n",
    );
    for (const tag of ["details", "summary", "kbd", "sub", "sup", "small", "abbr"]) expect(byTag(html, tag).length, tag).toBe(1);
    expect(attr(byTag(html, "abbr")[0]!, "title")).toBe("Index");
    expect(attr(byTag(html, "details")[0]!, "open")).not.toBeUndefined();
  });

  it("keeps picture and source with a srcset", async () => {
    const html = await render('<picture><source srcset="https://example.com/dark.png" media="(prefers-color-scheme: dark)"><img src="https://example.com/light.png" alt="logo"></picture>');
    expect(attr(byTag(html, "source")[0]!, "srcset")).toBe("https://example.com/dark.png");
    expect(attr(byTag(html, "img")[0]!, "src")).toBe("https://example.com/light.png");
  });

  it("keeps an https or a `/`-rooted image and a raw <img>, and turns any other markdown image into its alt text", async () => {
    const html = await render(
      "![a](https://example.com/a.png) ![root](/logos/r.png)\n\n![b](assets/b.png) ![up](../../x.svg) ![ref][r]\n\n[r]: ./r.svg\n\n<img src=\"/c.png\" alt=\"c\" width=\"40\">\n",
    );
    expect(byTag(html, "img").map((i) => attr(i, "src"))).toEqual(["https://example.com/a.png", "/logos/r.png", "/c.png"]);
    expect(attr(byTag(html, "img")[2]!, "width")).toBe("40");
    expect(byTag(html, "p")[1]!.childNodes.map((n) => ("value" in n ? n.value : "")).join("")).toBe("b up ref");
  });

  it("keeps a fenced block highlighted with classes, never a style attribute", async () => {
    const html = await render("```js\nconst a = 1;\n```\n");
    const [pre] = byTag(html, "pre");
    expect(classes(pre!)).toEqual(expect.arrayContaining(["astro-code", "github-light", "github-dark"]));
    expect(classes(pre!).some((c) => c.startsWith("__shiki_"))).toBe(true);
    expect(attr(pre!, "tabindex")).toBe("0");
    expect(attr(pre!, "data-language")).toBe("js");
    const spans = byTag(html, "span");
    expect(spans.some((s) => classes(s).includes("line"))).toBe(true);
    expect(spans.some((s) => classes(s).some((c) => c.startsWith("__shiki_")))).toBe(true);
    expect(elements(html).filter((el) => attr(el, "style") !== undefined)).toEqual([]);
  });

  it("refuses a class on any other element, and an unknown class on a pre", async () => {
    const html = await render('<div class="x"></div><pre class="astro-code evil">p</pre><span class="line evil">s</span>');
    expect(byTag(html, "div").map((d) => attr(d, "class"))).toEqual([undefined]);
    expect(classes(byTag(html, "pre")[0]!)).toEqual(["astro-code"]);
    expect(classes(byTag(html, "span")[0]!)).toEqual(["line"]);
  });

  // The build fails on a Shiki class with no rule, so a forged one would fail
  // every build the README reaches; one Shiki did emit only adds a colour.
  it("drops a Shiki class the highlighter never emitted, and keeps one it did", async () => {
    const html = await render("```js\nconst a = 1;\n```\n\n<pre class=\"__shiki_forged\"><span class=\"line __shiki_forged\">s</span></pre>");
    const registry = SHIKI_CLASSES.getClassRegistry();
    const shiki = elements(html).flatMap((el) => classes(el)).filter((c) => c.startsWith("__shiki_"));
    expect(shiki.length).toBeGreaterThan(0);
    expect(shiki.filter((c) => !registry.has(c))).toEqual([]);
  });
});

// With a file path, Astro's own image step runs and resolves what it takes
// for a local image on disk, ahead of the sanitizer.
describe("a README image Astro would resolve on disk", () => {
  const FILE = new URL("file:///index/enrich/github.com/acme/x/readme.md");
  async function renderAt(processor: ReturnType<typeof markdownProcessor>, md: string) {
    const renderer = await processor.createRenderer({
      ...markdownConfigDefaults,
      shikiConfig: { themes: SHIKI_THEMES, wrap: false, transformers: [SHIKI_CLASSES] },
    });
    return renderer.render(md, { fileURL: FILE });
  }

  it("follows the first of two definitions with one label, as Astro does", async () => {
    const { code, metadata } = await renderAt(
      markdownProcessor(),
      "![dup-alt][a]\n\n[a]: ./local.svg\n[a]: https://example.com/d.png\n",
    );
    expect(metadata.localImagePaths).toEqual([]);
    expect(byTag(code, "img")).toEqual([]);
    expect(code).toContain("dup-alt");
  });

  it("renders as alt text when its URL does not decode or does not parse, rather than failing", async () => {
    const { code } = await renderAt(markdownProcessor(), "![pct-alt](https://example.com/%zz.png) ![junk-alt](https://[bad]/x.png)\n");
    expect(byTag(code, "img")).toEqual([]);
    expect(code).toContain("pct-alt");
    expect(code).toContain("junk-alt");
  });

  it("is never handed to Astro's image step, even with the markdown guard gone", async () => {
    const bare = markdownProcessor();
    bare.options.remarkPlugins = [];
    const { metadata } = await renderAt(bare, "![x](./local.svg)\n");
    expect(metadata.localImagePaths).toEqual([]);
  });
});
