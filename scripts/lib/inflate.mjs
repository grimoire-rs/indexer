// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Cloning the curated dev index up to a corporate-sized one.
//
// Shared by `scripts/dev.mjs` (`npm run dev -- --bulk N`, for looking at the
// catalog at that size) and `scripts/quality-site.mjs` (for measuring it —
// the Lighthouse bulk run). One definition, so the site a regression is
// measured against is the same site it was eyeballed in.
import fs from "node:fs/promises";
import path from "node:path";

// The dev index is fifteen artifacts, one per rendering state (see its
// README), which is the right shape for "does this state render" and the
// wrong one for "does the toolbar, the keyword rail, the sort and the list
// view still hold at the size a real corporate index reaches". `--bulk`
// answers the second question without touching the first: the clones are
// made in the scratch copy, so the curated set stays curated and there is no
// generated JSON in the tree for anyone to review or keep in step.
//
// Each clone is a whole package, not a card: its own directory and `name`
// (which `compileIndex` requires to match), its own `ref`, its own copy of
// the enrichment sidecar and logo, and its own dates and vote count. The
// last two are the ones worth spelling out — 200 packages sharing one
// `updated` timestamp make the sort control a 200-way tie, which is to say
// untestable at exactly the size that needed testing.
export const TEAMS = [
  "platform", "payments", "identity", "billing", "search",
  "mobile", "data", "infra", "checkout", "risk",
  "growth", "docs", "support", "ledger", "auth",
];

/** `code-review` → `code-review-payments`, then `-payments-2` once wrapped. */
export function suffixed(name, i) {
  const round = Math.floor(i / TEAMS.length);
  return `${name}-${TEAMS[i % TEAMS.length]}${round === 0 ? "" : `-${round + 1}`}`;
}

/**
 * A stable number in `[0, max)` from a string — djb2. Deterministic on
 * purpose: two runs of `--bulk 250` render the same catalog, so a layout
 * question asked twice gets the same answer both times.
 */
export function spread(seed, max) {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  return h % max;
}

/** Clone the packages under `root/index` until there are at least `target`. */
export async function inflate(root, target) {
  const indexDir = path.join(root, "index");
  const enrichDir = path.join(root, "enrich");
  const statsPath = path.join(root, ".stats.json");

  const sources = [];
  for (const entry of await fs.readdir(indexDir, { recursive: true, withFileTypes: true })) {
    if (entry.name !== "metadata.json") continue;
    const file = path.join(entry.parentPath, entry.name);
    sources.push({ file, meta: JSON.parse(await fs.readFile(file, "utf8")) });
  }
  if (sources.length === 0) return 0;

  const stats = await fs
    .readFile(statsPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);

  const copies = Math.max(0, Math.ceil(target / sources.length) - 1);
  let made = 0;
  for (const { file, meta } of sources) {
    const nsDir = path.dirname(path.dirname(file));
    const ns = path.relative(indexDir, nsDir).split(path.sep).join("/");
    for (let i = 0; i < copies; i++) {
      const name = suffixed(meta.name, i);
      // The ref's last segment is the package name; the registry host and
      // the namespace in front of it are what make it the same publisher.
      const ref = meta.ref.replace(/[^/]+$/, name);
      const dst = path.join(nsDir, name);
      await fs.mkdir(dst, { recursive: true });
      await fs.writeFile(
        path.join(dst, "metadata.json"),
        JSON.stringify({ ...meta, name, ref }, null, 2) + "\n",
      );

      // The sidecar is looked up by name, so it has to be copied under the
      // new one or the clone renders as a pointer-only entry. `bare` has no
      // sidecar at all, which is the state it exists for — clone that too.
      const sidecar = path.join(enrichDir, ns, meta.name);
      if (await fs.stat(sidecar).then(() => true, () => false)) {
        const into = path.join(enrichDir, ns, name);
        await fs.cp(sidecar, into, { recursive: true });
        const dataPath = path.join(into, "data.json");
        const data = JSON.parse(await fs.readFile(dataPath, "utf8"));
        if (data.title === meta.name) data.title = name;
        // `compileIndex` publishes the logo as `<ns>/<name>.<ext>` off the
        // index metadata's name, so the sidecar's path has to follow it.
        if (typeof data.logo === "string") {
          data.logo = data.logo.replace(/[^/]+(\.[^.]+)$/, `${name}$1`);
        }
        // Up to two years back, so the date sort has something to sort.
        const drift = spread(ref, 17_520) * 3_600_000;
        for (const key of ["created", "updated"]) {
          const at = Date.parse(data[key]);
          if (!Number.isNaN(at)) data[key] = new Date(at - drift).toISOString();
        }
        await fs.writeFile(dataPath, JSON.stringify(data, null, 2) + "\n");
      }

      // Ratings, where the source had one: the thread `target` and `url`
      // carry over, so a vote count in the demo still leaves the site for a
      // page that exists rather than a fabricated 404. One clone in four is
      // left unrated, because an index where everything is rated does not
      // exercise the unrated card.
      const rating = stats?.entries?.[meta.ref]?.rating;
      if (rating && spread(`${ref}:rated`, 4) !== 0) {
        stats.entries[ref] = { rating: { ...rating, up: spread(ref, 90) } };
      }
      made++;
    }
  }

  if (stats) await fs.writeFile(statsPath, JSON.stringify(stats, null, 2) + "\n");
  return made;
}
