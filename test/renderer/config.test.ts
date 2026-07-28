// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  loadConfig,
  resolveConfig,
  SiteConfigError,
} from "../../src/config.js";

const roots: string[] = [];

async function rootWith(contents: string | null): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-config-"));
  roots.push(root);
  if (contents !== null) await fs.writeFile(path.join(root, CONFIG_FILE), contents);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("treats a missing file as an empty config", async () => {
    await expect(loadConfig(await rootWith(null))).resolves.toEqual({});
  });

  it("returns what the file declares", async () => {
    const root = await rootWith('{"brand":"acme index","docsUrl":"https://acme.test"}');
    await expect(loadConfig(root)).resolves.toEqual({
      brand: "acme index",
      docsUrl: "https://acme.test",
    });
  });

  it.each([
    ["not JSON at all", "{"],
    ["a JSON array", "[]"],
    ["a non-string brand", '{"brand":42}'],
    // A `javascript:` href would run in the visitor's browser.
    ["a non-http docsUrl", '{"docsUrl":"javascript:alert(1)"}'],
    ["a malformed extension id", '{"vscodeExtension":"nodot"}'],
    ["a non-array install", '{"install":"curl … | sh"}'],
    ["an install row missing `command`", '{"install":[{"os":"Linux"}]}'],
    ["a registry with no index", '{"registry":{"alias":"acme"}}'],
    ["a registry alias with a slash", '{"registry":{"alias":"a/b","index":"https://a.test"}}'],
  ])("rejects %s", async (_case, contents) => {
    await expect(loadConfig(await rootWith(contents))).rejects.toBeInstanceOf(SiteConfigError);
  });

  it("accepts null for every disable-able field", async () => {
    const root = await rootWith(
      '{"docsUrl":null,"repoUrl":null,"vscodeExtension":null,"registry":null,"footerNote":null}',
    );
    const config = resolveConfig(await loadConfig(root));
    expect(config.docsUrl).toBeNull();
    expect(config.vscodeExtension).toBeNull();
    expect(config.registry).toBeNull();
  });
});

describe("resolveConfig", () => {
  it("fills every gap from the defaults", () => {
    expect(resolveConfig({ brand: "acme index" })).toEqual({
      ...DEFAULT_CONFIG,
      brand: "acme index",
    });
  });

  it("treats an explicit undefined as absent, but keeps null", () => {
    const resolved = resolveConfig({ brand: undefined, docsUrl: null });
    expect(resolved.brand).toBe(DEFAULT_CONFIG.brand);
    expect(resolved.docsUrl).toBeNull();
  });

  // A default that names one specific index is a default that ships that
  // index's identity to everyone else. `repoUrl` put a "github" link on
  // every site pointing at grimoire-rs/index; `registry` handed out a
  // working `grim config registry add` for the wrong index entirely.
  it("has no default for the keys that name a particular index", () => {
    expect(DEFAULT_CONFIG.repoUrl).toBeNull();
    expect(DEFAULT_CONFIG.registry).toBeNull();
    // The tool's own docs are the same page whoever runs the index, so
    // those keep theirs.
    expect(DEFAULT_CONFIG.docsUrl).toBe("https://grimoire.rs");
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if (key === "site") continue; // every index sets its own; init writes it
      expect(JSON.stringify(value), key).not.toContain("index.grimoire.rs");
    }
  });
});
