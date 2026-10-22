// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The post-process works on built pages by splicing at source offsets, so
// the assertions here are about bytes: what was inserted, and that nothing
// else moved.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHIKI_CLASSES, SHIKI_THEMES } from "../../src/renderer/astro/lib/code.js";
import { postProcessSite } from "../../src/renderer/postprocess.js";

let outDir: string;

beforeEach(async () => {
  // The registry is process-wide, so each case starts from an empty one.
  SHIKI_CLASSES.clearRegistry();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "postprocess-"));
});

afterEach(async () => {
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
    // The whole page is the original with the link spliced in after the
    // start tag: quoting, case and CRLFs all survive, so nothing was re-serialised.
    const at = original.indexOf(HEAD_TAG) + HEAD_TAG.length;
    expect(await read("p/a/index.html")).toBe(original.slice(0, at) + link + original.slice(at));

    const css = await fs.readFile(path.join(outDir, "_astro", sheets[0]!), "utf8");
    for (const cls of original.match(/__shiki_[a-z0-9]+/g)!) {
      expect(css, cls).toContain(`.${cls}{`);
    }
  });

  it("leaves a page without a Shiki class byte-identical, and writes no sheet for it", async () => {
    const plain = page("<title>t</title>", "<p>no code, but __shiki_zzzzzz in text</p>");
    await write("index.html", plain);

    await postProcessSite(outDir, "/");

    expect(await read("index.html")).toBe(plain);
    await expect(fs.access(path.join(outDir, "_astro"))).rejects.toThrow();
  });

  it("fails the build on a class the registry has no rule for", async () => {
    await fence();
    await write("p/bad/index.html", page("", '<span class="x __shiki_zzzzzz">y</span>'));

    await expect(postProcessSite(outDir, "/")).rejects.toThrow(/p[\\/]bad[\\/]index\.html.*__shiki_zzzzzz/);
  });
});
