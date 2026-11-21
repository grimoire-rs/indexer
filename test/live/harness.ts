// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Shared by the suites in this directory. Not a test file: vitest.live.config.ts
// includes `*.test.ts` only. The two variables are required, see dependencies.test.ts.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { vi } from "vitest";

export const BIN = process.env.GRIM_LIVE_BIN;
export const REGISTRY = process.env.GRIM_LIVE_REGISTRY;
if (!BIN || !path.isAbsolute(BIN) || !REGISTRY) {
  throw new Error(
    "test/live needs GRIM_LIVE_BIN (absolute path of a grim binary) and GRIM_LIVE_REGISTRY (host:port of a writable plain-HTTP OCI registry)",
  );
}
const GRIM: string = BIN;
const HOST: string = REGISTRY;

export const NS = "github.com/acme";
export const VERSION = "1.0.0";

export const GRIM_VERSION = execFileSync(GRIM, ["--version"], { encoding: "utf8" }).trim();

/**
 * Whether this grim knows the `mod` kind: its schema command exits 0 for it. A
 * capability probe, not a version compare, so an unreleased build counts.
 */
export const HAS_MOD = spawnSync(GRIM, ["schema", "--kind", "mod", "--format", "json"], { stdio: "ignore" }).status === 0;

if (!HAS_MOD) {
  console.warn(`live: ${GRIM} (${GRIM_VERSION}) has no mod kind; the mod cases are skipped`);
}

export function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** A fresh repository prefix per call, so a reused registry never answers with a previous run's tags. */
export const freshPrefix = (): string => `${HOST}/live-${randomBytes(4).toString("hex")}`;

/** Points grim's state and credentials at `tmp` and opts into the experimental kinds this grim has. */
export function stubGrimEnv(tmp: string, extraConfig = ""): void {
  vi.stubEnv("GRIM_HOME", path.join(tmp, "grim-home"));
  vi.stubEnv("DOCKER_CONFIG", path.join(tmp, "docker"));
  vi.stubEnv("GRIM_INSECURE_REGISTRIES", HOST);
  vi.stubEnv("GRIM_OFFLINE", undefined);
  vi.stubEnv("GRIM_DEFAULT_REGISTRY", undefined);
  // Hooks, settings and mods are experimental: grim publishes them only once the global config opts in.
  const flags = ["settings = true", "hooks = true", ...(HAS_MOD ? ["mods = true"] : [])];
  write(path.join(tmp, "grim-home", "grimoire.toml"), `[options.experimental]\n${flags.join("\n")}\n${extraConfig}`);
}

/** Publishes `source` as `<ref>:1.0.0` and returns its manifest digest. */
export function release(source: string, ref: string, kind?: string): string {
  const args = ["release", source, `${ref}:${VERSION}`, ...(kind ? ["--kind", kind] : []), "--no-git", "--format", "json"];
  const report = execFileSync(GRIM, args, { encoding: "utf8", timeout: 60_000 });
  return (JSON.parse(report) as { manifest_digest: string }).manifest_digest;
}
