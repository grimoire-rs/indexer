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
 * fixture run; see that file's docblock. MEASUREMENT PENDING.
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
        'categories:accessibility': ['error', { minScore: 0.9 }],
        'categories:best-practices': ['error', { minScore: 0.9 }],
        'categories:seo': ['error', { minScore: 0.9 }],
        'categories:performance': ['warn', { minScore: 0.9 }],
      },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci-bulk' },
  },
};
