// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R35: `build` and `dev` make no network request, and Astro's own telemetry
// post and update check are requests. Both entry points switch them off before
// they read anything, so a call that fails at once still leaves them off.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveConfig } from "../../src/config.js";
import { buildSite, devSite } from "../../src/renderer/index.js";

const VARS = ["ASTRO_TELEMETRY_DISABLED", "ASTRO_DISABLE_UPDATE_CHECK"] as const;
const saved = new Map<string, string | undefined>();
let dir: string;

beforeEach(() => {
  for (const name of VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  // An empty directory: there is no `all.json`, so the call rejects before Astro starts.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-offline-env-"));
});

afterEach(() => {
  for (const name of VARS) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const opts = () => ({ root: dir, outDir: path.join(dir, "dist"), config: resolveConfig({ site: "https://index.example" }) });

describe("Astro stays offline (IX-R35)", () => {
  it.each([
    ["buildSite", () => buildSite(opts())],
    ["devSite", () => devSite(opts())],
  ])("%s disables Astro's telemetry and update check", async (_name, call) => {
    await expect(call()).rejects.toThrow();

    expect(process.env.ASTRO_TELEMETRY_DISABLED).toBe("1");
    expect(process.env.ASTRO_DISABLE_UPDATE_CHECK).toBe("true");
  });
});
