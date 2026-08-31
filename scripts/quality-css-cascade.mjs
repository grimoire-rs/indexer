#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Proves, in a real browser, that a consumer stylesheet can actually override
 * the theme — the central claim of the CSS contract.
 *
 * Everything else in the suite checks this at the source or byte level:
 * `test/renderer/style_contract.test.ts` proves every authored block is
 * wrapped in `@layer grimoire`, and `test/renderer/build.test.ts` proves the
 * wrapper survives a real Astro build and that `customCss` is emitted
 * unlayered and last. Neither proves a browser APPLIES it, and that gap
 * cannot be closed with the DOM shims in the repo: happy-dom drops `@layer`
 * blocks at parse time and jsdom parses them but never applies layered
 * declarations, so an assertion in either passes whether or not the mechanism
 * works — the vacuous green `.claude/rules/css-theming/gate.md` warns about.
 *
 * Runs from `task quality:web`, reusing the Chrome that task already resolves
 * and driving it with `puppeteer-core`, which Lighthouse itself already uses
 * for the same job.
 *
 * Usage: node scripts/quality-css-cascade.mjs [chromePath]
 */
/* The `page.evaluate()` callback below is serialised and run inside Chrome, so
   its identifiers resolve against the browser, not Node. */
/* global document, getComputedStyle */
import { createServer } from "node:http";
import { readFile, writeFile, rm, mkdtemp, cp, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, extname, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/dev");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".md": "text/markdown",
  ".woff2": "font/woff2",
};

function serve(dir) {
  const server = createServer(async (req, res) => {
    let path = decodeURI(req.url.split("?")[0]);
    if (path.endsWith("/")) path += "index.html";
    if (!extname(path)) path += ".html";
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/**
 * The probe stylesheet uses ONLY published surface: two `data-slot` selectors
 * from the set `style_contract.test.ts` fixes, and one token from
 * `styles/tokens.css`. Nothing here targets an internal class name — those are
 * explicitly not contract (CSS-API-01).
 *
 * Every value is a distinct improbable colour, so a pass cannot come from
 * reading a UA default or from another rule that happens to agree.
 */
const PROBE_CSS = `
[data-slot="package-card"] { border-color: rgb(1, 2, 3); }
[data-slot="package-keywords"] { background-color: rgb(4, 5, 6); }
:root { --grim-color-bg: rgb(7, 8, 9); }
`;

const EXPECTED = {
  cardBorder: "rgb(1, 2, 3)",
  keywordsBackground: "rgb(4, 5, 6)",
  pageBackground: "rgb(7, 8, 9)",
};

async function main() {
  const chromePath = process.argv[2] || process.env.CHROME_PATH || undefined;
  const outDir = await mkdtemp(join(tmpdir(), "grim-cascade-out-"));
  // A scratch copy of the fixture, not the fixture itself: `customCss` must
  // resolve inside the index root (`readCustomCss` refuses anything else), so
  // the probe stylesheet has to live beside a config — and neither belongs in
  // a committed fixture directory, where it would perturb the Lighthouse run
  // whose thresholds are tuned to that exact site.
  const root = await mkdtemp(join(tmpdir(), "grim-cascade-src-"));

  let server;
  let browser;
  try {
    await cp(FIXTURE, root, { recursive: true });
    await mkdir(join(root, "theme"), { recursive: true });
    await writeFile(join(root, "cascade-probe.css"), PROBE_CSS, "utf8");
    const config = JSON.parse(await readFile(join(root, "index.config.json"), "utf8"));
    await writeFile(
      join(root, "index.config.json"),
      JSON.stringify({ ...config, customCss: "./cascade-probe.css" }, null, 2),
    );

    execFileSync(
      process.execPath,
      [join(ROOT, "dist/cli/index.js"), "build", root, "--out-dir", outDir],
      { stdio: "inherit" },
    );

    server = await serve(outDir);
    const { port } = server.address();
    const puppeteer = (await import("puppeteer-core")).default;
    // No path handed in (a CI runner has no puppeteer cache to glob): let
    // puppeteer resolve the system Chrome install itself.
    browser = await puppeteer.launch({
      ...(chromePath ? { executablePath: chromePath } : { channel: "chrome" }),
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-slot="package-card"]', { timeout: 15_000 });

    const actual = await page.evaluate(() => {
      const cs = getComputedStyle;
      const card = document.querySelector('[data-slot="package-card"]');
      const keywords = document.querySelector('[data-slot="package-keywords"]');
      return {
        cardBorder: cs(card).borderTopColor,
        keywordsBackground: keywords
          ? cs(keywords).backgroundColor
          : "(no keyword group rendered)",
        pageBackground: cs(document.body).backgroundColor,
      };
    });

    const failures = Object.entries(EXPECTED).filter(([k, want]) => actual[k] !== want);
    for (const [k, want] of Object.entries(EXPECTED)) {
      console.log(`  ${actual[k] === want ? "ok  " : "FAIL"} ${k}: ${actual[k]} (want ${want})`);
    }
    if (failures.length > 0) {
      // Throw rather than process.exit(): exit() terminates immediately and
      // skips the finally below, leaving a scratch tree and a live Chrome.
      throw new Error(
        "A consumer stylesheet failed to override the theme in a real browser.\n" +
          "The most likely cause is theme CSS escaping `@layer grimoire` — an\n" +
          "unlayered theme rule outranks a consumer's by specificity, silently.",
      );
    }
    console.log("\ncascade contract holds: consumer CSS overrides the theme in a real browser");
  } finally {
    await browser?.close();
    server?.close();
    await rm(outDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
