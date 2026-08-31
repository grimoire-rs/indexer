/**
 * Lighthouse CI config for `task quality:web`, curated-fixture run.
 *
 * Consumed OUT-OF-PROCESS by the `@lhci/cli` binary — never imported into the
 * vitest process. `task quality:web` builds `test/fixtures/dev` (the
 * fifteen-artifact dev index, one package per rendering state) into
 * `.lhci-site/`, and lhci audits the pages below. `.lighthouserc.bulk.cjs` is
 * the sibling run that audits the same renderer at corporate catalog size.
 *
 * ## Why the URLs are listed, not autodiscovered
 *
 * lhci's autodiscovery cannot see this site at all. `readHtmlFilesInDirectory`
 * (@lhci/cli, collect/fallback-server.js) skips any directory whose name
 * contains a dot, and every package page lives under one — the namespace is a
 * forge hostname, `/p/github.com/acme/<name>/`. Left to autodiscover, lhci
 * audits index.html alone and reports a clean pass over one page, at any
 * `staticDirFileDiscoveryDepth`. The URL layout is frozen (README), so that is
 * a permanent property of this site, not a version to wait out.
 *
 * A hostless path is fine: lhci rewrites the port of every supplied URL to its
 * own static server's (collect/collect.js).
 *
 * ## Why these six pages and not all sixteen
 *
 * Measured 2026-08-31, 3 runs x 16 pages, Chrome 152.0.7977.64: ten of the
 * sixteen score a flat 1.00 in all four categories, because every detail page
 * is one template and most fixture packages differ only in their data. The
 * full sweep costs 496s; these six hold every score the sweep found and cost
 * about a third of that.
 *
 *   /                        perf 1.00  a11y 1.00  bp 0.96  seo 1.00
 *   .../ghost-logo/          perf 1.00  a11y 1.00  bp 0.96  seo 1.00
 *   .../test-writer/         perf 1.00  a11y 0.96  bp 1.00  seo 1.00
 *   .../code-review/         perf 1.00  a11y 1.00  bp 1.00  seo 1.00
 *   .../bare/                perf 1.00  a11y 1.00  bp 1.00  seo 1.00
 *   .../many-versions/       perf 1.00  a11y 1.00  bp 1.00  seo 1.00
 *
 * Between them: the hydrated island; a package whose logo is declared but not
 * shipped; an agent-kind page; a fully enriched page (readme, changelog,
 * support, rating, version cascade); a pointer-only page with no sidecar at
 * all; and the version-cascade page. ADD A URL HERE when the dev index gains
 * a rendering state — the list below is checked to exist, so a renamed page
 * fails loudly, but a new one nothing names is simply not audited.
 *
 * ## Thresholds: measured, then ratcheted
 *
 * A gate whose red state was never observed is not a gate (CSS-GATE-02).
 * These are the measured minimum medians above, dropped by a 0.03 margin so
 * run-to-run variance never reds the build while a real regression still
 * does. Re-measure and re-ratchet when the renderer or the fixture changes;
 * never raise a threshold above a level the site actually clears.
 *
 *   accessibility   min median 0.96 -> 0.93 error
 *   best-practices  min median 0.96 -> 0.93 error
 *   seo             min median 1.00 -> 0.97 error
 *   performance     min median 1.00 -> 0.97 warn
 *
 * Two known defects hold the first two floors below 1.00, and both should be
 * ratcheted up once closed:
 *
 *   - accessibility 0.96 on every agent-kind page is one `color-contrast`
 *     failure: the `kind-agent` badge computes 4.48:1 against white, against
 *     a required 4.5:1. It is a design-token value (`--grim-color-kind-agent`),
 *     so it is reported rather than silently changed here.
 *   - best-practices 0.96 is `errors-in-console`: a 404 for the `ghost-logo`
 *     fixture's declared-but-unshipped logo. That is the fixture doing its
 *     job — it exists to render the broken-logo state — so this one is a
 *     property of the test data, not of the renderer.
 *
 * ## Why category assertions and NOT `preset: 'lighthouse:no-pwa'`
 *
 * The preset asserts individual audits at `error` — `unused-css-rules` and
 * `unused-javascript` among them. Those are real and out of scope: the
 * catalog island ships the toolbar's whole behaviour to a visitor who may
 * only read the first card. Category assertions hold the line against any
 * FUTURE regression in whichever audits make up a category, without the
 * "author names every audit by hand" maintenance burden.
 */
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const DIST = '.lhci-site';

const AUDITED = [
  '/',
  '/p/github.com/acme/ghost-logo/',
  '/p/github.com/acme/test-writer/',
  '/p/github.com/acme/code-review/',
  '/p/github.com/acme/bare/',
  '/p/github.com/acme/many-versions/',
];

// A listed page that no longer exists would otherwise be audited as lhci's
// SPA fallback — a 200 for index.html under the wrong URL, scoring fine and
// proving nothing about the page that was renamed out from under it.
const missing = AUDITED.filter((url) => !existsSync(join(DIST, url, 'index.html')));
if (missing.length > 0) {
  throw new Error(
    `.lighthouserc.cjs: ${String(missing.length)} audited page(s) are not in ${DIST}: ` +
      `${missing.join(', ')}. Rebuild the fixture site, or update this list.`,
  );
}

module.exports = {
  ci: {
    collect: {
      staticDistDir: DIST,
      url: AUDITED.map((path) => `http://localhost${path}`),
      numberOfRuns: 3,
      settings: {
        // chrome-launcher autodetects when CHROME_PATH is unset (CI provides
        // its own chrome); `task quality:web` fills it in locally from a
        // puppeteer-cached Chrome when the shell has not set it.
        chromePath: process.env.CHROME_PATH || undefined,
        chromeFlags: '--headless=new --no-sandbox',
      },
    },
    assert: {
      assertions: {
        'categories:accessibility': ['error', { minScore: 0.93 }],
        'categories:best-practices': ['error', { minScore: 0.93 }],
        'categories:seo': ['error', { minScore: 0.97 }],
        'categories:performance': ['warn', { minScore: 0.97 }],
      },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' },
  },
};
