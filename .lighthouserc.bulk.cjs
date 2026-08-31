/**
 * Lighthouse CI config for `task quality:web`, corporate-size run.
 *
 * Same renderer, same gate, a catalog of ~250 packages instead of fifteen
 * (`scripts/quality-site.mjs`). This is where the payload and hydration cost
 * of the one hydrated island actually shows: the curated fixture is too small
 * for a regression in either to move a score.
 *
 * Only `/` is audited. The detail pages carry no island and their weight does
 * not change with catalog size, so auditing 251 pages x 3 runs would buy
 * nothing for the minutes it costs — `.lighthouserc.cjs` already covers every
 * detail page at fixture size.
 *
 * Thresholds follow the same measured-then-ratcheted discipline as the
 * fixture run; see that file's docblock. Measured 2026-08-31, 3 runs, Chrome
 * 152.0.7977.64, against a 255-package build: every category medians 1.00, so
 * every floor is 1.00 minus the same 0.03 margin. For reference the same run
 * reported LCP 1205ms, TBT 35ms and CLS 0.000 — `content-visibility` on the
 * card grid is what holds that at this size.
 *
 * Higher than the fixture run's two lower floors, deliberately: neither of
 * the defects that depress those exists here. The bulk index is cloned from
 * the curated one, so there is no `ghost-logo` 404 in it.
 */
module.exports = {
  ci: {
    collect: {
      staticDistDir: '.lhci-bulk',
      numberOfRuns: 3,
      // The landing page only. `1` rather than `0`: autodiscovery starts at
      // index.html, and everything past it is a detail page.
      maxAutodiscoverUrls: 1,
      settings: {
        chromePath: process.env.CHROME_PATH || undefined,
        chromeFlags: '--headless=new --no-sandbox',
      },
    },
    assert: {
      assertions: {
        'categories:accessibility': ['error', { minScore: 0.97 }],
        'categories:best-practices': ['error', { minScore: 0.97 }],
        'categories:seo': ['error', { minScore: 0.97 }],
        'categories:performance': ['warn', { minScore: 0.97 }],
      },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci-bulk' },
  },
};
