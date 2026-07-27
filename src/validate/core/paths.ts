// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Changed-path gate — the first and cheapest filter on an untrusted PR.
 *
 * Every changed path must be `index/<host>/<namespace...>/<pkg>/metadata.json`.
 * Anything else means manual review. Path strings arrive from the forge API and
 * are attacker-chosen, so segments are charset-checked rather than merely
 * pattern-matched: `..`, empty segments, absolute paths, backslashes and NUL
 * never survive, which is what makes the later `resolve()` in
 * `adapters/files.ts` a belt-and-braces check rather than the only one.
 */

export type Forge = "github" | "gitlab";

export interface IndexPath {
  /** The path exactly as the forge reported it. */
  file: string;
  /** Namespace segment(s) — one on GitHub, possibly nested on GitLab. */
  namespace: string;
  /** Package directory name; `metadata.json`'s `name` must equal it. */
  pkg: string;
}

/**
 * A single path segment: starts alphanumeric, then alphanumeric/`.`/`_`/`-`.
 * Rejects `.`, `..`, hidden files, and anything needing URL escaping.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseIndexPath(
  file: string,
  forge: Forge,
  host: string,
): IndexPath | null {
  if (file.includes("\0") || file.includes("\\")) return null;

  const parts = file.split("/");
  // index / <host> / <ns...> / <pkg> / metadata.json
  if (parts.length < 5) return null;
  if (parts[0] !== "index") return null;
  if ((parts[1] ?? "").toLowerCase() !== host.toLowerCase()) return null;
  if (parts[parts.length - 1] !== "metadata.json") return null;

  const middle = parts.slice(2, -1);
  if (middle.length < 2) return null;
  // GitHub namespaces are a single login or org; GitLab groups nest.
  if (forge === "github" && middle.length !== 2) return null;
  if (!middle.every((segment) => SEGMENT.test(segment))) return null;

  const pkg = middle[middle.length - 1];
  if (pkg === undefined) return null;
  return { file, namespace: middle.slice(0, -1).join("/"), pkg };
}
