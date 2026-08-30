// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

export interface KeywordChip {
  keyword: string;
  count: number;
}

/**
 * The rail's chips, picked by SPLITTING POWER rather than raw frequency.
 *
 * A chip is worth a rail slot when clicking it meaningfully partitions what
 * is on screen, so:
 *
 * - a near-ubiquitous keyword scores ~0 (clicking it barely narrows),
 * - a tiny keyword scores low (it barely selects anything),
 * - a keyword redundant with one already picked scores low (its packages are
 *   already reachable through that one).
 *
 * Greedy. Each round scores every unpicked keyword as
 * `min(uncoveredCount, total - count)` — a tent over coverage, peaking near
 * half the set, intersected with the marginal gain over what is already
 * covered — and takes the best. Ties go to the higher total count, then
 * alphabetically. When nothing scores above zero (a small or homogeneous
 * catalog) the remaining slots are padded by plain frequency, so the rail is
 * never emptier than it has to be.
 *
 * The input is deliberately narrow — only `keywords` is read — so the tests
 * need no full `CatalogPackage` fixtures.
 *
 * Ported from `@ocx-sh/catalog`'s `src/theme/utils/keywordRail.ts`, which
 * arrived at this after a frequency-ranked rail kept offering the tags every
 * package already carries.
 */
export function selectRailKeywords(
  items: readonly { keywords?: readonly string[] }[],
  limit: number,
): KeywordChip[] {
  const total = items.length;
  const members = new Map<string, Set<number>>();
  items.forEach((item, i) => {
    for (const kw of item.keywords ?? []) {
      let set = members.get(kw);
      if (!set) members.set(kw, (set = new Set()));
      set.add(i);
    }
  });

  const picked: KeywordChip[] = [];
  const pickedSet = new Set<string>();
  const covered = new Set<number>();

  while (picked.length < limit) {
    let best: string | null = null;
    let bestScore = 0;
    let bestCount = 0;
    for (const [kw, set] of members) {
      if (pickedSet.has(kw)) continue;
      let uncovered = 0;
      for (const i of set) if (!covered.has(i)) uncovered++;
      const score = Math.min(uncovered, total - set.size);
      const wins =
        score > bestScore ||
        (score === bestScore &&
          score > 0 &&
          (set.size > bestCount ||
            (set.size === bestCount && best !== null && kw < best)));
      if (wins) {
        best = kw;
        bestScore = score;
        bestCount = set.size;
      }
    }
    if (best === null) break;
    picked.push({ keyword: best, count: members.get(best)!.size });
    pickedSet.add(best);
    for (const i of members.get(best)!) covered.add(i);
  }

  // Frequency padding for the slots the greedy pass could not justify.
  if (picked.length < limit) {
    const rest = [...members]
      .filter(([kw]) => !pickedSet.has(kw))
      .map(([keyword, set]) => ({ keyword, count: set.size }))
      .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword));
    picked.push(...rest.slice(0, limit - picked.length));
  }

  return picked;
}

/**
 * Every keyword in `items`, most common first. Feeds the overflow menu, which
 * lists what the rail had no room for.
 *
 * Scored over the same set the rail is, so a menu row is never a click to an
 * empty catalog: a keyword no surviving package carries is simply not there.
 */
export function keywordFrequency(
  items: readonly { keywords?: readonly string[] }[],
): KeywordChip[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const kw of item.keywords ?? [])
      counts.set(kw, (counts.get(kw) ?? 0) + 1);
  }
  return [...counts]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword));
}
