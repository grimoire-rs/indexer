// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import path from "node:path";

import { CliError, EXIT } from "./exit.js";

/**
 * Resolve `--out-dir` against the index root, refusing one that would take
 * the index with it.
 *
 * `compileIndex` starts by removing `outDir` outright, so an out-dir that is
 * the repo root — or an ancestor of it — would delete the index it is about
 * to compile. Shared by `build` and `dev`, which both compile before they
 * render.
 */
export function resolveOutDir(rootDir: string, outDir: string | undefined): string {
  const resolved = path.resolve(rootDir, outDir ?? "dist");
  if (resolved === rootDir || rootDir.startsWith(resolved + path.sep)) {
    throw new CliError(
      `--out-dir ${JSON.stringify(resolved)} contains the index root ${JSON.stringify(rootDir)}; ` +
        `the build would delete it`,
      EXIT.usage,
    );
  }
  // `public/` is the index's own committed asset layer — the logo and favicon
  // the config names live there, which is why the scaffold deliberately does
  // not gitignore it. Building into it deleted them before the renderer read
  // them, and the site deployed green with a 404 where the logo had been.
  if (resolved === path.join(rootDir, "public")) {
    throw new CliError(
      `--out-dir ${JSON.stringify(resolved)} is the index's committed asset layer; ` +
        `build into another directory and move it if your host needs "public"`,
      EXIT.usage,
    );
  }
  return resolved;
}
