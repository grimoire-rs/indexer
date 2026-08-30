// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer dev` — serve this index locally, so a change to an entry, the
// branding, or the custom CSS can be looked at before it is pushed. It renders
// through the same code path `build` does, so what is on screen is what the
// deploy will publish.
import path from "node:path";

import { CliError, EXIT, type ExitCode } from "./exit.js";
import { resolveOutDir } from "./out_dir.js";

export interface DevFlags {
  outDir?: string;
  port?: string;
  /** `true` for a bare `--host` (every interface), or the address to bind. */
  host?: string | boolean;
}

/**
 * A bad `--port` is a usage error (64), like every other bad flag. Passed
 * through unchecked it reached Astro as `NaN` and surfaced as a raw zod issue
 * dump naming no flag at all, exiting 1.
 */
function resolvePort(port: string | undefined): number | undefined {
  if (port === undefined) return undefined;
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new CliError(`--port ${JSON.stringify(port)}: must be a port number (1-65535)`, EXIT.usage);
  }
  return value;
}

/**
 * What `--host` binds to, in the shape Astro's `server.host` takes: `true` for
 * every interface, a string for one address, `undefined` to leave the default
 * loopback bind alone.
 *
 * Only the shapes that cannot be an address are rejected here — an empty value,
 * and anything carrying whitespace or a `/`, which is what `--host
 * http://0.0.0.0` and a pasted URL look like. Whether the address exists on
 * this machine is the kernel's answer, not this function's, and it arrives as a
 * bind error naming the address.
 */
export function resolveHost(host: string | boolean | undefined): string | boolean | undefined {
  if (host === undefined || typeof host === "boolean") return host;
  const value = host.trim();
  if (value === "" || /[\s/]/.test(value)) {
    throw new CliError(
      `--host ${JSON.stringify(host)}: must be a hostname or IP address, or bare for all interfaces`,
      EXIT.usage,
    );
  }
  return value;
}

export async function dev(root: string, flags: DevFlags): Promise<ExitCode> {
  const rootDir = path.resolve(root);
  const outDir = resolveOutDir(rootDir, flags.outDir);
  const port = resolvePort(flags.port);
  const host = resolveHost(flags.host);

  const [{ loadConfig }, { compileIndex }, { devSite }] = await Promise.all([
    import("../config.js"),
    import("../data/index.js"),
    import("../renderer/index.js"),
  ]);

  const config = await loadConfig(rootDir);
  const { count, namespaces } = await compileIndex({ root: rootDir, outDir });
  const server = await devSite({ root: rootDir, outDir, config, port, host });

  console.log(`\n  ${server.url}\n`);
  console.log(`  ${count} package(s) across ${namespaces.length} namespace(s)`);
  // `index.config.json` is read once, at boot, and baked into the bundle — the
  // same thing a build does. Say so, or an edit that appears to do nothing
  // reads as a bug in the renderer.
  console.log("  editing index/ or index.config.json? restart to pick it up\n");

  // The server owns the process from here. Astro's dev server keeps the event
  // loop alive on its own, but the promise is what stops `run` from returning
  // and letting the CLI set an exit code out from under it.
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        void server
          .stop()
          .catch(() => {})
          .finally(resolve);
      });
    }
  });
  return EXIT.ok;
}
