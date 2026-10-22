#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Proves, in a real browser, that the built site runs under its own
 * Content-Security-Policy without a single violation, with JavaScript on and
 * off.
 *
 * `test/renderer/build.test.ts` proves every inline block is hashed; only a
 * browser says the policy as a whole admits what the page actually does —
 * the Astro islands, the Shiki stylesheet, the `<noscript>` style, a theme
 * page. Violations are read from the DevTools `Audits` and `Log` domains
 * rather than from a page script, because a JavaScript-off page has none.
 *
 * The harness is only trusted because of its controls, and each must be
 * blocked or the run fails. A second theme page carries a `style=""`
 * attribute, which the policy must block. A built page with an inline
 * `<script>` the build never hashed (what unsanitized README HTML would
 * leave) must trip `script-src` and must not run: a sentinel it would set
 * stays unset. A control that reports nothing means violations are not being
 * observed.
 *
 * Usage: node scripts/quality-csp.mjs [chromePath]
 */
import { createServer } from "node:http";
import { readFile, writeFile, rm, cp, mkdir, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/dev");
// Under the repo, like `quality-site.mjs`: `--out-dir` must be absolute and
// inside it, and both paths are gitignored.
const SCRATCH = join(ROOT, ".dev", `csp-${process.pid}`);
const OUT = join(ROOT, ".lhci-csp");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** The fixture's pages that cover each way a page reaches the browser. */
const PAGES = [
  ["/", "catalog landing"],
  ["/p/github.com/acme/code-review/", "README with a code fence"],
  ["/p/github.com/acme/context7/", "MCP detail"],
  ["/csp-theme/", "theme page"],
  ["/marketplace/", "marketplace"],
  ["/marketplace/review-kit/", "plugin page"],
];
const CONTROL = ["/csp-control/", "control (must be blocked)"];
/** The theme page, copied after the build with a script the policy has no hash for. */
const SCRIPT_CONTROL = ["/csp-script-control/", "script control (must be blocked)"];
const SENTINEL = "__cspSentinel";

/** A theme page the way the docs tell an index to write one: shipped layout, shipped component. */
const THEME_PAGE = `---
import Base from "@grim/layouts/Base.astro";
import CommandField from "@grim/components/CommandField.astro";
---

<Base title="theme page" description="A page an index added under theme/pages.">
  <h1>theme page</h1>
  <CommandField value="grim config registry add acme" name="setup command" label="Copy it" />
</Base>
`;

/** The same page with the one thing the policy must refuse. */
const CONTROL_PAGE = THEME_PAGE.replace("<h1>theme page</h1>", '<h1 style="color:red">control</h1>');

const FENCE = "\n## Install\n\n```sh\ngrim add acme/code-review\n```\n";

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
 * Open `url` in a fresh page and return every CSP violation the browser
 * reported, and the value of `window[sentinel]` once it settled.
 */
async function violationsOf(browser, url, javaScript, sentinel) {
  // A fresh page per case: one window carries its first case's state into the rest.
  const page = await browser.newPage();
  const found = [];
  let ran;
  try {
    await page.setJavaScriptEnabled(javaScript);
    const client = await page.createCDPSession();
    client.on("Audits.issueAdded", ({ issue }) => {
      if (issue.code !== "ContentSecurityPolicyIssue") return;
      const d = issue.details.contentSecurityPolicyIssueDetails;
      found.push(`${d.violatedDirective} ${d.blockedURL ?? "(inline)"}`);
    });
    client.on("Log.entryAdded", ({ entry }) => {
      if (/Content Security Policy/i.test(entry.text)) found.push(entry.text);
    });
    page.on("console", (msg) => {
      if (/Content Security Policy/i.test(msg.text())) found.push(msg.text());
    });
    await client.send("Audits.enable");
    await client.send("Log.enable");
    await page.goto(url, { waitUntil: "networkidle0" });
    // Audits are delivered asynchronously; give late ones a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (sentinel && javaScript) ran = await page.evaluate((name) => window[name], sentinel);
  } finally {
    await page.close();
  }
  return { found: [...new Set(found)], ran };
}

async function main() {
  const chromePath = process.argv[2] || process.env.CHROME_PATH || undefined;
  let server;
  let browser;
  try {
    await rm(SCRATCH, { recursive: true, force: true });
    await mkdir(dirname(SCRATCH), { recursive: true });
    await cp(FIXTURE, SCRATCH, { recursive: true });
    await mkdir(join(SCRATCH, "theme/pages"), { recursive: true });
    await writeFile(join(SCRATCH, "theme/pages/csp-theme.astro"), THEME_PAGE);
    await writeFile(join(SCRATCH, "theme/pages/csp-control.astro"), CONTROL_PAGE);
    // The dev index has no README with a fence, and a fence is what loads the Shiki sheet.
    await appendFile(join(SCRATCH, "enrich/github.com/acme/code-review/readme.md"), FENCE);

    // The control's `style=""` prints the build's aggregate warning; that is the point.
    execFileSync(process.execPath, [join(ROOT, "dist/cli/index.js"), "build", SCRATCH, "--out-dir", OUT], {
      stdio: "inherit",
    });

    // After the build, so the script is not hashed into the policy: what
    // unsanitized README HTML would be if it ever reached a page.
    const themePage = await readFile(join(OUT, "csp-theme/index.html"), "utf8");
    const planted = `<script>window.${SENTINEL} = "ran";</script>`;
    if (!themePage.includes("</body>")) throw new Error("the theme page has no </body> to plant the script control before");
    await mkdir(join(OUT, "csp-script-control"), { recursive: true });
    await writeFile(join(OUT, "csp-script-control/index.html"), themePage.replace("</body>", `${planted}</body>`));

    server = await serve(OUT);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const puppeteer = (await import("puppeteer-core")).default;
    // No path handed in (a CI runner has no puppeteer cache to glob): let
    // puppeteer resolve the system Chrome install itself.
    browser = await puppeteer.launch({
      ...(chromePath ? { executablePath: chromePath } : { channel: "chrome" }),
      headless: true,
      args: ["--no-sandbox"],
    });

    const failures = [];
    const cases = [...PAGES, CONTROL, SCRIPT_CONTROL];
    for (const [route, label] of cases) {
      const html = await (await fetch(`${origin}${route}`)).text();
      const hasPolicy = /<meta http-equiv="Content-Security-Policy" content="[^"]+">/.test(html);
      if (!hasPolicy) failures.push(`${route}: no Content-Security-Policy meta`);
      // The fence is what the README case is for: without it the Shiki sheet is never loaded.
      if (route === PAGES[1][0] && !/shiki\.[0-9a-f]{8}\.css/.test(html)) {
        failures.push(`${route}: no Shiki stylesheet, so the fence case covers nothing`);
      }
      const isScriptControl = route === SCRIPT_CONTROL[0];
      // A script that cannot run says nothing about the policy, so that control runs with JavaScript on only.
      for (const javaScript of isScriptControl ? [true] : [true, false]) {
        const { found, ran } = await violationsOf(browser, `${origin}${route}`, javaScript, isScriptControl ? SENTINEL : undefined);
        const mode = javaScript ? "js on " : "js off";
        const isStyleControl = route === CONTROL[0];
        const ok = isScriptControl
          ? found.some((v) => /script-src/.test(v)) && ran === undefined
          : isStyleControl
            ? found.length > 0
            : found.length === 0;
        console.log(`  ${ok ? "ok  " : "FAIL"} ${mode} ${route} (${label}): ${found.length} violation(s)`);
        for (const v of found) console.log(`         ${v}`);
        if (ok) continue;
        if (isScriptControl) {
          failures.push(
            `${route}: the unhashed inline script ${ran === undefined ? "raised no script-src violation" : "ran"}, so the policy is not holding script back`,
          );
        } else if (isStyleControl) {
          failures.push(`${route} (${mode}): the planted style attribute raised nothing, so violations are not being observed`);
        } else {
          failures.push(`${route} (${mode}): ${found.length} CSP violation(s)`);
        }
      }
    }
    if (failures.length > 0) {
      // Throw rather than process.exit(): exit() skips the finally below and
      // would leave a scratch tree and a live Chrome.
      throw new Error(`CSP smoke failed:\n  ${failures.join("\n  ")}`);
    }
    console.log("\nCSP holds: no violations on any page, with JavaScript on or off; both planted controls were blocked");
  } finally {
    await browser?.close();
    server?.close();
    await rm(OUT, { recursive: true, force: true });
    await rm(SCRATCH, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
