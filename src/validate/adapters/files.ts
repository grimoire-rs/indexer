// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Filesystem reads of a checkout. The PR tree is untrusted data: every read is
 * confined to the tree root, symlinks are refused rather than followed, and a
 * size cap applies before any content is loaded.
 */

import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { MAX_METADATA_BYTES } from "../core/metadata.js";

export type FileRead =
  | { kind: "missing" }
  | { kind: "text"; text: string }
  | { kind: "error"; reason: string };

function contained(base: string, target: string): boolean {
  return target === base || target.startsWith(base + sep);
}

/**
 * Read `relative` from inside `root`.
 *
 * `missing` is a real outcome, not an error — a changed path with no file in
 * the PR tree is a deletion by the namespace owner.
 */
export async function readIndexFile(
  root: string,
  relative: string,
): Promise<FileRead> {
  if (relative.includes("\0") || isAbsolute(relative)) {
    return { kind: "error", reason: "path must be relative to the index root" };
  }

  const base = await realpath(root).catch(() => null);
  if (base === null) {
    return { kind: "error", reason: `cannot resolve index root ${root}` };
  }

  const target = resolve(base, relative);
  if (!contained(base, target)) {
    return { kind: "error", reason: "path escapes the index root" };
  }

  const stat = await lstat(target).catch(() => null);
  if (stat === null) return { kind: "missing" };
  if (stat.isSymbolicLink()) {
    return { kind: "error", reason: "symlinks are not accepted" };
  }
  if (!stat.isFile()) return { kind: "error", reason: "not a regular file" };
  if (stat.size > MAX_METADATA_BYTES) {
    return { kind: "error", reason: `larger than ${MAX_METADATA_BYTES} bytes` };
  }

  // Catches a symlinked *parent* directory, which lstat on the leaf cannot see.
  const real = await realpath(target).catch(() => null);
  if (real === null || !contained(base, real)) {
    return { kind: "error", reason: "path escapes the index root" };
  }

  return { kind: "text", text: await readFile(target, "utf8") };
}
