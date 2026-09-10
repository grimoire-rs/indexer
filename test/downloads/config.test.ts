// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The `downloads` block of `index.config.json`.
//
// The block is optional and its absence is the off switch. Most of what
// follows is about what is deliberately NOT here: no repository map, because
// the Artifactory repository key and the image path are both derived from the
// ref itself, and no token key, because the credential comes from the job.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SiteConfigError } from "../../src/config.js";
import { loadDownloadsConfig, validateDownloads } from "../../src/downloads/config.js";

const MINIMAL = { baseUrl: "https://artifactory.example.com/artifactory" };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-downloads-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(config: unknown): void {
  fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify(config, null, 2));
}

describe("validateDownloads", () => {
  it("reads absence as the off switch, never as an empty configuration", () => {
    expect(validateDownloads(undefined)).toBeUndefined();
    expect(validateDownloads(null)).toBeUndefined();
  });

  it("takes the base URL and nothing else by default", () => {
    expect(validateDownloads(MINIMAL)).toEqual({
      baseUrl: "https://artifactory.example.com/artifactory",
    });
  });

  it("strips trailing slashes once, here, so no call site has to", () => {
    expect(validateDownloads({ baseUrl: "https://a.example.com/artifactory///" })?.baseUrl).toBe(
      "https://a.example.com/artifactory",
    );
  });

  it("refuses a base URL that is not https — the reply decides every count", () => {
    expect(() => validateDownloads({ baseUrl: "http://a.example.com/artifactory" })).toThrow(
      SiteConfigError,
    );
    expect(() => validateDownloads({ baseUrl: "artifactory.example.com" })).toThrow(SiteConfigError);
    expect(() => validateDownloads({})).toThrow(SiteConfigError);
    expect(() => validateDownloads({ baseUrl: "  " })).toThrow(SiteConfigError);
  });

  it("refuses a non-object block", () => {
    expect(() => validateDownloads([MINIMAL])).toThrow(SiteConfigError);
    expect(() => validateDownloads("https://a.example.com")).toThrow(SiteConfigError);
  });

  it("keeps an OIDC provider name, and refuses one that could break out of generated YAML", () => {
    expect(validateDownloads({ ...MINIMAL, oidcProvider: "github-grim" })?.oidcProvider).toBe(
      "github-grim",
    );
    for (const bad of ["", "name with spaces", 'x"\n      run: rm -rf /', 7]) {
      expect(() => validateDownloads({ ...MINIMAL, oidcProvider: bad }), String(bad)).toThrow(
        SiteConfigError,
      );
    }
  });

  it("drops an unknown key rather than passing it through", () => {
    expect(validateDownloads({ ...MINIMAL, repos: ["a", "b"] })).toEqual(MINIMAL);
  });
});

describe("loadDownloadsConfig", () => {
  it("reads a missing file, and a file with no block, as off", async () => {
    expect(await loadDownloadsConfig(dir)).toBeUndefined();
    write({ site: "https://example.com" });
    expect(await loadDownloadsConfig(dir)).toBeUndefined();
  });

  it("reads the block out of the shared config file", async () => {
    write({ site: "https://example.com", downloads: MINIMAL });
    expect(await loadDownloadsConfig(dir)).toEqual(MINIMAL);
  });

  it("fails on a file that does not parse", async () => {
    fs.writeFileSync(path.join(dir, "index.config.json"), "{ not json");
    await expect(loadDownloadsConfig(dir)).rejects.toThrow(SiteConfigError);
  });
});
