// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// What a mod's package page reads from its `contents.json`. Its own module,
// not `catalog.ts`: that one ships in the catalog island, and the TOML parser
// must stay out of the browser bundle.
import { parse as parseToml } from "smol-toml";

/** One file of a mod's layer, as `grim fetch` lists it. */
export interface ModFile {
  path: string;
  size: number;
}

/** A mod's `contents.json`: the packed `mod.toml` text and the layer's files. */
export interface ModContents {
  document: string;
  files: ModFile[];
}

/**
 * A mod's `contents.json`, or `null` when it is not that shape. The file comes
 * from the registry, so a wrong type or a missing key means no mod section
 * rather than a failed build; a file entry that is malformed is dropped.
 */
export function modContents(data: unknown): ModContents | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const { document, files } = data as { document?: unknown; files?: unknown };
  if (typeof document !== "string" || !Array.isArray(files)) return null;
  const kept = files.flatMap((f: unknown): ModFile[] => {
    if (f === null || typeof f !== "object") return [];
    const { path, size } = f as { path?: unknown; size?: unknown };
    return typeof path === "string" && typeof size === "number" && Number.isFinite(size) && size >= 0 ? [{ path, size }] : [];
  });
  return { document, files: kept };
}

/** One harness directory of a mod: its files below `<name>/<harness>/`, sorted by path. */
export interface ModHarness {
  name: string;
  files: ModFile[];
}

/**
 * The harness directories of a mod's layer, sorted by name. A harness is the
 * second path segment of every file with at least three, so nothing here
 * knows a harness by name.
 */
export function modHarnesses(files: readonly ModFile[]): ModHarness[] {
  const byName = new Map<string, ModFile[]>();
  for (const { path, size } of files) {
    const parts = path.split("/");
    if (parts.length < 3 || !parts[1]) continue;
    const list = byName.get(parts[1]) ?? [];
    list.push({ path: parts.slice(2).join("/"), size });
    byName.set(parts[1], list);
  }
  return [...byName]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, list]) => ({ name, files: list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }));
}

/**
 * The `entry` a harness's table names in `mod.toml`: `string` when set,
 * `null` for a table without one (the default entry applies), `undefined`
 * when the document does not parse so no entry line is shown.
 */
export function modEntry(document: string, harness: string): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = parseToml(document);
  } catch {
    return undefined;
  }
  const table = Object.hasOwn(parsed as object, harness) ? (parsed as Record<string, unknown>)[harness] : undefined;
  const entry = table !== null && typeof table === "object" ? (table as { entry?: unknown }).entry : undefined;
  return typeof entry === "string" ? entry : null;
}
