// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

interface Entry<T> {
  pointer: T;
  path: string;
}

/**
 * One pointer per `ref` for the enrich plane: the last in sorted path order
 * wins, the same one grim picks from `all.json`. Every dropped pointer gets a
 * warning naming it and the winner. `all.json` and the pages keep all of them.
 */
export function dedupeByRef<T extends { ref: string }>(
  pointers: readonly T[],
  pathOf: (pointer: T) => string,
): { kept: T[]; warnings: string[] } {
  const sorted = pointers
    .map((pointer): Entry<T> => ({ pointer, path: pathOf(pointer) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const winner = new Map<string, Entry<T>>();
  for (const entry of sorted) winner.set(entry.pointer.ref, entry);

  const kept: T[] = [];
  const warnings: string[] = [];
  for (const entry of sorted) {
    const won = winner.get(entry.pointer.ref) ?? entry;
    if (won === entry) kept.push(entry.pointer);
    else warnings.push(`warn: ${entry.path} repeats the ref ${entry.pointer.ref} of ${won.path}, which the enrich plane keeps`);
  }
  return { kept, warnings };
}
