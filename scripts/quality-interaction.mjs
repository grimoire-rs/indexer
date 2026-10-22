#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Traces what a reader costs the main thread on the landing page (IX-R33): in headless Chrome at
 * 4x CPU throttle it scrolls to the end of the results, changes the sort and types a query, and
 * reports for each step the long tasks (count, total and max ms) and the element count.
 * Budgets are in scripts/lib/interaction-budgets.json, measured 2026-10-23 on the 250-entry bulk
 * site as twice the worst of twelve runs; the table is under that file's "//" key.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const EXIT = { ok: 0, breach: 1, usage: 64 };
export const THROTTLE = 4;
export const STEPS = ["load", "scroll", "sort", "search"];
export const METRICS = ["longTaskCount", "longTaskTotalMs", "longTaskMaxMs", "domNodes"];

const USAGE = [
  "usage: node scripts/quality-interaction.mjs --site <dir> (--report | --budget <file.json | inline json>)",
  "       node scripts/quality-interaction.mjs --from <measurement.json> --budget <file.json | inline json>",
  "  --report  print the measurement and exit 0; warn when the scroll stopped short of the end",
  "  --budget  print the measurement, then every breach, and exit 1 on any",
  "  --from    judge a saved measurement instead of driving Chrome (CHROME_PATH, else the system Chrome)",
  "exit: 0 clean, 1 a breach or a run that could not measure, 64 usage",
].join("\n");

const QUERY = "review";
const SETTLE_QUIET_MS = 400;
const SETTLE_MAX_MS = 30_000;
// A scroll step that renders nothing new, after the page went quiet and stopped loading, is a stall.
const SCROLL_STALL_LIMIT = 3;
const LOAD_MAX_MS = 5 * 60_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  // Served as is, with no Content-Encoding: the island inflates the blob itself.
  ".gz": "application/gzip",
};

class UsageError extends Error {}

/**
 * Every budget the measurement exceeds, in budget order, then a scroll that did not reach the
 * end. A budgeted step or metric the measurement lacks is a breach too: a gate that quietly
 * measured nothing is the failure this exists to prevent.
 *
 * @param {{ steps?: Record<string, Record<string, number>> }} measure
 * @param {Record<string, Record<string, number>>} budgets
 * @returns {{ step: string, metric: string, actual: number | null, limit: number }[]}
 */
export function evaluateBudgets(measure, budgets) {
  const breaches = [];
  for (const [step, limits] of Object.entries(budgets)) {
    for (const [metric, limit] of Object.entries(limits)) {
      const actual = measure?.steps?.[step]?.[metric];
      if (typeof actual !== "number" || !Number.isFinite(actual)) {
        breaches.push({ step, metric, actual: null, limit });
      } else if (actual > limit) {
        breaches.push({ step, metric, actual, limit });
      }
    }
  }
  // A scroll that stopped short measured one window of the results, whatever the budgets say.
  const scroll = measure?.steps?.scroll;
  if (scroll?.reachedEnd === false) {
    breaches.push({ step: "scroll", metric: "reachedEnd", actual: scroll.rendered ?? null, limit: scroll.shown ?? null });
  }
  return breaches;
}

export function describeBreach({ step, metric, actual, limit }) {
  if (metric === "reachedEnd") return `${step}: stopped at ${actual} of ${limit} results, before the end of the list`;
  return actual === null
    ? `${step}.${metric}: not measured (budget ${limit})`
    : `${step}.${metric}: ${actual} exceeds the budget of ${limit}`;
}

/** Throws `UsageError` for any argument shape the usage line does not allow. */
export function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        site: { type: "string" },
        budget: { type: "string" },
        from: { type: "string" },
        report: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.report === Boolean(values.budget)) throw new UsageError("give exactly one of --report and --budget");
  if (Boolean(values.site) === Boolean(values.from)) throw new UsageError("give exactly one of --site and --from");
  return values;
}

/** The budget as an object: inline JSON when it starts with `{`, else a file path. */
export async function loadBudgets(spec) {
  let raw = spec;
  if (!spec.trimStart().startsWith("{")) {
    try {
      raw = await readFile(spec, "utf8");
    } catch (error) {
      throw new UsageError(`--budget ${JSON.stringify(spec)}: ${error.message}`);
    }
  }
  let budgets;
  try {
    budgets = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`--budget is not valid JSON: ${error.message}`);
  }
  // JSON has no comments: a "//" key (as tsconfig.test.json does) carries the notes.
  if (budgets !== null && typeof budgets === "object" && !Array.isArray(budgets)) delete budgets["//"];
  const shaped =
    budgets !== null &&
    typeof budgets === "object" &&
    !Array.isArray(budgets) &&
    Object.entries(budgets).every(
      ([step, limits]) =>
        STEPS.includes(step) &&
        limits !== null &&
        typeof limits === "object" &&
        Object.entries(limits).every(([metric, n]) => METRICS.includes(metric) && Number.isFinite(n)),
    );
  if (!shaped) {
    throw new UsageError(
      `--budget must be { <step>: { <metric>: <number> } } over steps ${STEPS.join("/")} and metrics ${METRICS.join("/")}`,
    );
  }
  return budgets;
}

/** A static server on loopback; a malformed request is a 400, a path outside the site a 404. */
export function serve(dir) {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    let file;
    try {
      let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (path.endsWith("/")) path += "index.html";
      file = normalize(join(root, path));
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    try {
      if (file !== root && !file.startsWith(root + sep)) throw new Error("outside the site");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Runs in the page before any of its scripts: collects every long task's duration. */
function observeLongTasks() {
  const durations = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) durations.push(entry.duration);
  });
  observer.observe({ type: "longtask", buffered: true });
  window.__longTasks = {
    durations,
    flush() {
      for (const entry of observer.takeRecords()) durations.push(entry.duration);
      return durations.length;
    },
  };
}

const readPage = () => ({
  tasks: window.__longTasks.flush(),
  nodes: document.getElementsByTagName("*").length,
  rendered: document.querySelectorAll('[data-slot="package-card"], [data-slot="package-row"]').length,
});

/** Waits until neither a long task nor a DOM change landed for a quiet window. */
async function settle(page) {
  const deadline = Date.now() + SETTLE_MAX_MS;
  let last = await page.evaluate(readPage);
  while (Date.now() < deadline) {
    await sleep(SETTLE_QUIET_MS);
    const now = await page.evaluate(readPage);
    if (now.tasks === last.tasks && now.nodes === last.nodes) return now;
    last = now;
  }
  return last;
}

/** One step: run it, let the page go quiet, then report the long tasks that landed meanwhile. */
async function runStep(page, act) {
  // Before the first navigation there is no document to hold the observer yet.
  const from = await page.evaluate(() => window.__longTasks?.flush() ?? 0);
  const detail = (await act()) ?? {};
  const after = await settle(page);
  const durations = await page.evaluate((start) => window.__longTasks.durations.slice(start), from);
  return {
    longTaskCount: durations.length,
    longTaskTotalMs: Math.round(durations.reduce((sum, d) => sum + d, 0)),
    longTaskMaxMs: Math.round(Math.max(0, ...durations)),
    domNodes: after.nodes,
    rendered: after.rendered,
    ...detail,
  };
}

/** What the results line and the DOM say about completeness; runs in the page. */
const readResults = () => {
  const text = document.querySelector(".result-count")?.textContent ?? "";
  const counts = /^(?:(\d+) of )?(\d+) packages/.exec(text);
  return {
    loading: /^Loading/.test(text) || document.querySelector('[aria-busy="true"]') !== null,
    shown: counts ? Number(counts[1] ?? counts[2]) : null,
    rendered: document.querySelectorAll('[data-slot="package-card"], [data-slot="package-row"]').length,
  };
};

/** Waits out the lazy search file: the results line reads "Loading" while it downloads and decodes. */
async function untilLoaded(page) {
  const deadline = Date.now() + LOAD_MAX_MS;
  let results = await page.evaluate(readResults);
  while (results.loading && Date.now() < deadline) {
    await sleep(500);
    results = await page.evaluate(readResults);
  }
  return results;
}

/**
 * Jump to the bottom, let the page go quiet and finish loading, and repeat until every result the
 * count promises is rendered. Waiting on the page, not on a deadline, is what keeps this honest at
 * scale: under throttle a window of thousands of cards, or the search file, takes seconds, and a
 * timeout would call that the end. Each productive step renders at least one card, so the loop is
 * bounded by the count; three steps in a row that render nothing end it as `reachedEnd: false`.
 */
async function scrollToEnd(page) {
  let results = await page.evaluate(readResults);
  let steps = 0;
  for (let stalled = 0; stalled < SCROLL_STALL_LIMIT; ) {
    steps++;
    const before = results.rendered;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await settle(page);
    results = await untilLoaded(page);
    if (results.shown === null) throw new Error("cannot read the result count (.result-count) to tell the end of the list");
    if (results.rendered >= results.shown) return { scrollSteps: steps, reachedEnd: true, shown: results.shown };
    stalled = results.rendered > before ? 0 : stalled + 1;
  }
  return { scrollSteps: steps, reachedEnd: false, shown: results.shown };
}

async function pickAnotherSort(page) {
  const picked = await page.evaluate(() => {
    const item = document.querySelector('[role="menu"][aria-label="Sort by"] [role="menuitemradio"][aria-checked="false"]');
    if (!item) return null;
    // A programmatic click: the menu is a popover, and the toolbar may be off screen after the scroll.
    item.click();
    return item.getAttribute("value");
  });
  if (!picked) throw new Error('no unchecked option in the "Sort by" menu');
  return { sortedBy: picked };
}

/** Drives the site and returns the measurement; the only part of this file that needs a Chrome. */
export async function measureSite(site) {
  const server = await serve(site);
  let browser;
  try {
    const puppeteer = (await import("puppeteer-core")).default;
    const chromePath = process.env.CHROME_PATH || undefined;
    browser = await puppeteer.launch({
      ...(chromePath ? { executablePath: chromePath } : { channel: "chrome" }),
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(observeLongTasks);
    await page.emulateCPUThrottling(THROTTLE);

    // Controls are found by accessible name and `data-slot`, the hooks the CSS contract names; a
    // missing one fails the run, since a trace of a page it could not drive is no trace.
    const search = 'input[aria-label="Search packages"]';
    const steps = {};
    steps.load = await runStep(page, async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
      await page.waitForSelector(search, { timeout: 30_000 });
    });
    steps.scroll = await runStep(page, () => scrollToEnd(page));
    steps.sort = await runStep(page, () => pickAnotherSort(page));
    steps.search = await runStep(page, async () => {
      await page.type(search, QUERY, { delay: 60 });
      return { query: QUERY };
    });
    return { v: 1, throttle: THROTTLE, steps };
  } finally {
    await browser?.close();
    server.close();
  }
}

/**
 * The whole CLI behind one function so a test drives it without a Chrome:
 * `deps.measure` replaces the browser run. Returns the exit code.
 */
export async function main(argv, { measure = measureSite, out = console.log, err = console.error } = {}) {
  try {
    const args = parseCli(argv);
    const budgets = args.budget ? await loadBudgets(args.budget) : null;
    let measurement;
    if (args.from) {
      try {
        measurement = JSON.parse(await readFile(args.from, "utf8"));
      } catch (error) {
        throw new UsageError(`--from ${JSON.stringify(args.from)}: ${error.message}`);
      }
    } else {
      measurement = await measure(args.site);
    }
    out(JSON.stringify(measurement, null, 2));
    if (!budgets) {
      for (const breach of evaluateBudgets(measurement, {})) err(`interaction trace: ${describeBreach(breach)}`);
      return EXIT.ok;
    }
    const breaches = evaluateBudgets(measurement, budgets);
    for (const breach of breaches) err(`interaction budget: ${describeBreach(breach)}`);
    if (breaches.length > 0) return EXIT.breach;
    err("interaction budgets hold");
    return EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      err(`${error.message}\n${USAGE}`);
      return EXIT.usage;
    }
    err(`interaction trace failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.breach;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
