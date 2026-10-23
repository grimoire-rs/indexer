// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The post-process works on built pages by splicing at source offsets, so
// the assertions here are about bytes: what was inserted, and that nothing
// else moved.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { parse, type ParserOptions } from "parse5";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { SHIKI_CLASSES, SHIKI_THEMES } from "../../src/renderer/astro/lib/code.js";
import { postProcessSite } from "../../src/renderer/postprocess.js";
import { cspHash, cspMeta, cspPolicy } from "./html.js";

// The re-parse that checks the policy landed in <head> cannot fail on any page
// a fuzz of 400,000 documents produced, so one test forces it at this seam.
// Every other test runs the real parser.
vi.mock("parse5", async (importOriginal) => {
  const actual = await importOriginal<typeof import("parse5")>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

let outDir: string;
let stderr: MockInstance<typeof console.error>;

beforeEach(async () => {
  // The registry is process-wide, so each case starts from an empty one.
  SHIKI_CLASSES.clearRegistry();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "postprocess-"));
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  stderr.mockRestore();
  await fs.rm(outDir, { recursive: true, force: true });
});

/** A real highlighted fence, rendered through the same pipeline the site uses. */
async function fence(): Promise<string> {
  const md = await createMarkdownProcessor({
    shikiConfig: { themes: SHIKI_THEMES, transformers: [SHIKI_CLASSES] },
  });
  return (await md.render("```sh\ngrim add acme/code-review\n```\n")).code;
}

/** Quoting, case and whitespace a re-serialising parser would normalise away. */
const HEAD_TAG = "<HEAD data-x='1'>";
const page = (head: string, body: string) =>
  `<!DOCTYPE html>\r\n<html lang='en'>\r\n${HEAD_TAG}${head}</HEAD>\r\n<body  class=a>${body}</body>\r\n</html>\r\n`;

async function write(rel: string, html: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(outDir, rel)), { recursive: true });
  await fs.writeFile(path.join(outDir, rel), html);
}

const read = (rel: string) => fs.readFile(path.join(outDir, rel), "utf8");

/** The `content` of the one CSP meta a page carries. */
async function policyOf(rel: string): Promise<string> {
  const found = [...(await read(rel)).matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
  expect(found, rel).toHaveLength(1);
  return found[0]![1]!;
}

/** Everything written to stderr, joined. */
const warned = () => stderr.mock.calls.map((c) => c.join(" ")).join("\n");

describe("postProcessSite", () => {
  it.each([
    ["/", "/_astro/"],
    ["/index-repo/", "/index-repo/_astro/"],
    ["/index-repo", "/index-repo/_astro/"],
  ])("links the Shiki stylesheet into a page that uses a class (base %s)", async (base, prefix) => {
    const original = page("<title>t</title>", await fence());
    await write("p/a/index.html", original);

    await postProcessSite(outDir, base);

    const sheets = (await fs.readdir(path.join(outDir, "_astro"))).filter((f) =>
      /^shiki\.[0-9a-f]{8}\.css$/.test(f),
    );
    expect(sheets).toHaveLength(1);
    const link = `<link rel="stylesheet" href="${prefix}${sheets[0]}">`;
    // The whole page is the original with the policy and then the link
    // spliced in after the start tag: quoting, case and CRLFs all survive, so
    // nothing was re-serialised, and the policy comes first so it covers the link.
    const at = original.indexOf(HEAD_TAG) + HEAD_TAG.length;
    expect(await read("p/a/index.html")).toBe(
      original.slice(0, at) + cspMeta() + link + original.slice(at),
    );

    const css = await fs.readFile(path.join(outDir, "_astro", sheets[0]!), "utf8");
    for (const cls of original.match(/__shiki_[a-z0-9]+/g)!) {
      expect(css, cls).toContain(`.${cls}{`);
    }
  });

  it("splices only the policy into a page without a Shiki class, and writes no sheet for it", async () => {
    const plain = page("<title>t</title>", "<p>no code, but __shiki_zzzzzz in text</p>");
    await write("index.html", plain);

    await postProcessSite(outDir, "/");

    const at = plain.indexOf(HEAD_TAG) + HEAD_TAG.length;
    expect(await read("index.html")).toBe(plain.slice(0, at) + cspMeta() + plain.slice(at));
    await expect(fs.access(path.join(outDir, "_astro"))).rejects.toThrow();
  });

  it("fails the build on a class the registry has no rule for", async () => {
    await fence();
    await write("p/bad/index.html", page("", '<span class="x __shiki_zzzzzz">y</span>'));

    await expect(postProcessSite(outDir, "/")).rejects.toThrow(/p[\\/]bad[\\/]index\.html.*__shiki_zzzzzz/);
  });
});

describe("the content security policy", () => {
  it("carries exactly the directive list, in order, with no unsafe keyword", async () => {
    await write("index.html", page("<title>t</title>", "<p>x</p>"));

    await postProcessSite(outDir, "/");

    const policy = await policyOf("index.html");
    expect(policy).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    expect(policy).not.toMatch(/unsafe-/);
  });

  it("leads <head> when a later <meta charset> is not the first element", async () => {
    const original = page("<title>t</title><meta charset=\"utf-8\" data-late>", "<p>x</p>");
    await write("index.html", original);

    await postProcessSite(outDir, "/");

    // Only a first-element charset is exempt from being pushed down.
    const at = original.indexOf(HEAD_TAG) + HEAD_TAG.length;
    expect(await read("index.html")).toBe(original.slice(0, at) + cspMeta() + original.slice(at));
  });

  it("follows a <meta charset> that is head's first element, which must stay near the top", async () => {
    const charset = '<meta charset="utf-8">';
    const original = page(`  ${charset}<title>t</title>`, "<p>x</p>");
    await write("index.html", original);

    await postProcessSite(outDir, "/");

    const at = original.indexOf(charset) + charset.length;
    expect(await read("index.html")).toBe(original.slice(0, at) + cspMeta() + original.slice(at));
  });

  it("hashes every inline script and style, <noscript> and <template> included", async () => {
    const script = "window.__a = 1;";
    const module = 'import("/x.js");';
    const style = "@layer g{.a{color:red}}";
    const noscript = "@layer g{.b{display:none}}";
    const templated = "tpl();";
    await write(
      "index.html",
      page(
        `<title>t</title><script>${script}</script><style>${style}</style>` +
          '<script src="/ext.js"></script>',
        `<script type="module">${module}</script>` +
          `<noscript><style>${noscript}</style></noscript>` +
          `<template><script>${templated}</script></template>`,
      ),
    );

    await postProcessSite(outDir, "/");

    const scripts = [script, module, templated].map(cspHash).sort();
    const styles = [style, noscript].map(cspHash).sort();
    expect(await policyOf("index.html")).toBe(cspPolicy(scripts, styles));
  });

  it("hashes the text the browser sees, with line endings normalised", async () => {
    await write("index.html", page("<title>t</title><script>a();\r\nb();\rc();</script>", ""));

    await postProcessSite(outDir, "/");

    expect(await policyOf("index.html")).toBe(cspPolicy([cspHash("a();\nb();\nc();")]));
  });

  it("lists each hash once and in a fixed order, whatever the document order", async () => {
    const a = "one();";
    const b = "two();";
    await write("a.html", page("", `<script>${a}</script><script>${b}</script><script>${a}</script>`));
    await write("b.html", page("", `<script>${b}</script><script>${a}</script>`));

    await postProcessSite(outDir, "/");

    const expected = cspPolicy([cspHash(a), cspHash(b)].sort());
    expect(await policyOf("a.html")).toBe(expected);
    expect(await policyOf("b.html")).toBe(expected);
  });

  // parse5 synthesises the head for these, so the policy goes where the parser
  // opens it: after the doctype and any `<html>` start tag, before everything else.
  it.each([
    ["a doctype and no tags", "<!DOCTYPE html>", "<title>redirect</title><p>x</p>"],
    ["an <html> start tag", "<!DOCTYPE html>\r\n<html lang='en'>", "<title>t</title><body class=a><p>x</p></body>"],
    ["no doctype", "", "<title>t</title><p>x</p>"],
    ["a comment before the doctype", "<!-- c -->\n<!DOCTYPE html>", "<p>x</p>"],
  ])("puts the policy first in the implied head of a page with %s", async (_name, lead, rest) => {
    const original = lead + rest;
    await write("old/index.html", original);

    await postProcessSite(outDir, "/");

    expect(await read("old/index.html")).toBe(lead + cspMeta() + rest);
    expect(stderr).not.toHaveBeenCalled();
  });

  // A page with no element at all (a site-verification token) has nothing for a
  // policy to govern, and whatever fetches it may compare its bytes.
  it.each([
    ["only text", "google-site-verification: google1.html"],
    ["a doctype, comments and text", "<!DOCTYPE html>\r\n<!-- c -->\r\ntoken\r\n"],
    ["a byte-order mark and text", "\uFEFFtoken"],
    ["a doctype alone", "<!DOCTYPE html>"],
  ])("publishes a page with no element byte for byte: %s", async (_name, original) => {
    await write("token.html", original);

    await postProcessSite(outDir, "/");

    expect(await read("token.html")).toBe(original);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("still gives the policy to a page whose only element is <html>", async () => {
    await write("old/index.html", "<html>token");

    await postProcessSite(outDir, "/");

    expect(await read("old/index.html")).toBe(`<html>${cspMeta()}token`);
  });

  it("keeps a leading <meta charset> first in the implied head, inside the first 1,024 bytes", async () => {
    const charset = '<meta charset="utf-8">';
    const scripts = Array.from({ length: 20 }, (_v, i) => `go${i}()`);
    const rest = scripts.map((s) => `<script>${s}</script>`).join("") + "<p>x</p>";
    await write("old/index.html", `<!DOCTYPE html>${charset}${rest}`);

    await postProcessSite(outDir, "/");

    const out = await read("old/index.html");
    expect(out).toBe(`<!DOCTYPE html>${charset}${cspMeta(scripts.map(cspHash).sort())}${rest}`);
    // Twenty hashes make the policy longer than the whole window.
    expect(Buffer.byteLength(await policyOf("old/index.html"))).toBeGreaterThan(1024);
    expect(Buffer.byteLength(out.slice(0, out.indexOf(charset) + charset.length))).toBeLessThanOrEqual(1024);
  });

  it("keeps a byte-order mark first, so the doctype still reads as one", async () => {
    await write("old/index.html", "\uFEFF<!DOCTYPE html><p>x</p>");

    await postProcessSite(outDir, "/");

    expect(await read("old/index.html")).toBe(`\uFEFF<!DOCTYPE html>${cspMeta()}<p>x</p>`);
  });

  it("hashes the inline blocks of a page with no <head> start tag into its policy", async () => {
    const script = "go()";
    await write("old/index.html", `<!DOCTYPE html><title>t</title><script>${script}</script>`);

    await postProcessSite(outDir, "/");

    expect(await policyOf("old/index.html")).toBe(cspPolicy([cspHash(script)]));
  });

  it("gives rendered markdown in a page with no <head> start tag its policy rather than failing", async () => {
    await write("p/a/index.html", "<!DOCTYPE html><title>t</title><p data-grim-markdown>x</p>");

    await postProcessSite(outDir, "/");

    expect(await read("p/a/index.html")).toBe(
      `<!DOCTYPE html>${cspMeta()}<title>t</title><p data-grim-markdown>x</p>`,
    );
  });

  it("accepts ordinary rendered markdown", async () => {
    const readme =
      '<h1>t</h1><p><a href="https://example.test/x">x</a> <img src="https://example.test/i.png" alt=""></p>' +
      (await fence());
    await write("p/a/index.html", page("", `<div data-grim-markdown>${readme}</div>`));

    await expect(postProcessSite(outDir, "/")).resolves.toBeUndefined();
    expect(stderr).not.toHaveBeenCalled();
  });
});

// Defence in depth: the offset puts the meta in the implied head, and a second
// parse of the finished page must agree. Here that parse is made to disagree.
describe("the check that the policy landed in <head>", () => {
  let real: typeof parse;

  beforeEach(async () => {
    real = (await vi.importActual<typeof import("parse5")>("parse5")).parse;
    // The scan reads the page with source locations; only the re-parse does not.
    vi.mocked(parse).mockImplementation(((html: string, options?: ParserOptions) =>
      real(options?.sourceCodeLocationInfo ? html : "", options)) as typeof parse);
  });

  afterEach(() => {
    vi.mocked(parse).mockImplementation(real);
  });

  it("fails the build for rendered markdown, writing nothing", async () => {
    const original = "<!DOCTYPE html><title>t</title><p data-grim-markdown>x</p>";
    await write("p/a/index.html", original);

    await expect(postProcessSite(outDir, "/")).rejects.toThrow(
      /p[\\/]a[\\/]index\.html: no <head> start tag, so no Content-Security-Policy was added to the rendered markdown it carries/,
    );
    expect(await read("p/a/index.html")).toBe(original);
  });

  it("leaves any other page as it was, with a note", async () => {
    const original = "<!DOCTYPE html><title>t</title><p>x</p>";
    await write("old/index.html", original);

    await expect(postProcessSite(outDir, "/")).resolves.toBeUndefined();

    expect(await read("old/index.html")).toBe(original);
    expect(warned()).toMatch(/old[\\/]index\.html: no <head> start tag, so no Content-Security-Policy was added/);
  });
});

describe("rendered markdown", () => {
  it.each([
    ["a script", "<script>alert(1)</script>", /<script>/],
    ["an external script", '<script src="https://e.test/x.js"></script>', /<script>/],
    ["a style element", "<style>a{color:red}</style>", /<style>/],
    ["a style attribute", '<img src="https://e.test/i.png" style="color:red">', /style/],
    ["an event handler", '<img src="https://e.test/i.png" onerror="alert(1)">', /onerror/],
    ["a javascript: href", '<a href="javascript:alert(1)">x</a>', /javascript:/],
    ["a javascript: href spelled around the filter", '<a href=" Ja\tVa\nScRiPt:alert(1)">x</a>', /javascript:/],
    ["a vbscript: href", '<a href="vbscript:msgbox(1)">x</a>', /vbscript:/],
    ["a data:text/html src", '<img src="data:text/html,<b>x</b>">', /data:text\/html/],
    ["a javascript: form action", '<form action="javascript:alert(1)"></form>', /javascript:/],
    ["a javascript: formaction", '<button formaction="javascript:alert(1)">x</button>', /javascript:/],
    ["a javascript: xlink:href", '<svg><a xlink:href="javascript:alert(1)"></a></svg>', /javascript:/],
    ["a script inside a template", "<template><script>alert(1)</script></template>", /<script>/],
    ["an iframe", '<iframe src="https://e.test/"></iframe>', /<iframe>/],
    ["an object", '<object data="https://e.test/x"></object>', /<object>/],
    ["an embed", '<embed src="https://e.test/x">', /<embed>/],
    ["a base element", '<base href="https://e.test/">', /<base>/],
    ["a meta refresh", '<meta http-equiv="refresh" content="0;url=https://e.test/">', /<meta>/],
    ["a stylesheet link", '<link rel="stylesheet" href="https://e.test/x.css">', /<link>/],
    ["a form", '<form action="https://e.test/"><input name="p"></form>', /<form>/],
  ])("fails the build on %s", async (_name, markup, construct) => {
    const original = page("<title>t</title>", `<div><div data-grim-markdown><p>ok</p>${markup}</div></div>`);
    await write("p/a/index.html", original);

    await expect(postProcessSite(outDir, "/")).rejects.toThrow(/p[\\/]a[\\/]index\.html/);
    await expect(postProcessSite(outDir, "/")).rejects.toThrow(construct);
    // Nothing is written for a page that fails.
    expect(await read("p/a/index.html")).toBe(original);
  });

  it("fails on README HTML nobody sanitised", async () => {
    // What reaches the page when the sanitizer is off: the policy would block
    // both of these in a browser, and the build refuses to ship them at all.
    const raw = "<p>hi</p><script>alert(1)</script><img src=x onerror=alert(1)>";
    await write("p/a/index.html", page("<title>t</title>", `<div class="prose" data-grim-markdown>${raw}</div>`));

    await expect(postProcessSite(outDir, "/")).rejects.toThrow(/<script>[\s\S]*onerror|onerror[\s\S]*<script>/);
  });

  it("fails on it on a page with no <head> start tag too", async () => {
    await write("p/a/index.html", '<!DOCTYPE html><title>t</title><div data-grim-markdown><script>alert(1)</script></div>');

    await expect(postProcessSite(outDir, "/")).rejects.toThrow(/<script>/);
  });

  it("only warns about the same constructs outside it, once for the whole build", async () => {
    await write("a/index.html", page("", '<p style="color:red">a</p><button onclick="go()">b</button>'));
    await write("b/index.html", page("", '<span style="x">c</span>'));

    await postProcessSite(outDir, "/");

    // Both pages still get their policy.
    expect(await policyOf("a/index.html")).toBe(cspPolicy());
    expect(await policyOf("b/index.html")).toBe(cspPolicy());
    expect(stderr).toHaveBeenCalledTimes(1);
    const message = warned();
    expect(message).toMatch(/\b3\b/);
    expect(message).toMatch(/a[\\/]index\.html/);
    expect(message).toMatch(/blocks them|blocked/);
  });
});

// A standalone SVG opened at its own URL runs its script on the index origin,
// and no page's policy applies to it, so it must pass the logo allowlist.
describe("an SVG the build emitted", () => {
  it("keeps a plain drawing", async () => {
    await write("_astro/logo.abc.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
    await expect(postProcessSite(outDir, "/")).resolves.toBeUndefined();
  });

  it.each([
    ["a script", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["a namespaced script", '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></s:svg>'],
    ["a handler after a quoted >", '<svg xmlns="http://www.w3.org/2000/svg" a=">" onload="alert(1)"/>'],
  ])("fails the build: %s", async (_name, svg) => {
    await write("_astro/logo.abc.svg", svg);
    await expect(postProcessSite(outDir, "/")).rejects.toThrow(/_astro[\\/]logo\.abc\.svg/);
  });

  it("leaves an SVG outside _astro/ alone", async () => {
    await write("icons/x.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(postProcessSite(outDir, "/")).resolves.toBeUndefined();
  });
});
