// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `enrich` is the only part of the toolchain that talks to a registry, so
// every test here drives it through an injected runner: no `grim` binary, no
// network, and the hostile cases (a companion member naming a path outside
// its own directory) are expressible at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enrichIndex, type GrimRunner } from "../../src/enrich/index.js";

let dir: string;

function addPackage(namespace: string, name: string, ref: string): void {
  const pkg = path.join(dir, "index", namespace, name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "metadata.json"),
    JSON.stringify({
      schema: 1,
      name,
      kind: "skill",
      ref,
      description: `The ${name} skill.`,
      owner: { id: 1, github: "octocat" },
    }),
  );
}

const DESCRIBE = {
  title: "Foo",
  summary: "A foo.",
  version: "1.2.3",
  license: "Apache-2.0",
  created: "2026-07-01T00:00:00+02:00",
  keywords: ["a"],
  tags: ["1.2.3", "latest"],
  deprecated: null,
  has_description: true,
};

/** Companion members as `grim fetch --description --format json` reports them. */
const COMPANION = [
  { path: "README.md", content: "# Foo\n" },
  { path: "CHANGELOG.md", content: "## 1.2.3\n" },
  { path: "logo.svg", content: Buffer.from("<svg/>").toString("base64"), encoding: "base64" },
];

interface FakeOptions {
  describe?: Record<string, unknown>;
  digest?: string;
  files?: Array<{ path: string; content: string; encoding?: string }>;
}

/** Records every `grim` invocation so "did it re-download?" is assertable. */
function fakeGrim(opts: FakeOptions = {}): { run: GrimRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GrimRunner = (args) => {
    calls.push(args);
    if (args[0] === "describe") return Promise.resolve({ ...DESCRIBE, ...opts.describe });
    if (args.includes("--digest-only")) {
      return Promise.resolve({ digest: opts.digest ?? "sha256:aaa" });
    }
    return Promise.resolve({ files: opts.files ?? COMPANION });
  };
  return { run, calls };
}

function sidecar(namespace: string, name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "enrich", namespace, name, "data.json"), "utf8"),
  ) as Record<string, unknown>;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-enrich-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("enrichIndex", () => {
  it("writes the sidecar and every companion the site renders", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo:1.2.3");
    const { run } = fakeGrim();

    expect(await enrichIndex({ root: dir, run })).toEqual({
      total: 1,
      enriched: 1,
      failures: [],
    });

    expect(sidecar("github.com/acme", "foo")).toEqual({
      title: "Foo",
      summary: "A foo.",
      version: "1.2.3",
      license: "Apache-2.0",
      created: "2026-07-01T00:00:00+02:00",
      keywords: ["a"],
      tags: ["1.2.3", "latest"],
      deprecated: null,
      descDigest: "sha256:aaa",
      hasReadme: true,
      hasChangelog: true,
      logo: "/logos/github.com/acme/foo.svg",
    });

    const out = path.join(dir, "enrich/github.com/acme/foo");
    expect(fs.readFileSync(path.join(out, "readme.md"), "utf8")).toBe("# Foo\n");
    expect(fs.readFileSync(path.join(out, "changelog.md"), "utf8")).toBe("## 1.2.3\n");
    expect(fs.readFileSync(path.join(out, "logo.svg"), "utf8")).toBe("<svg/>");
  });

  it("carries an optional field through only when the registry has one", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    const { run } = fakeGrim({
      describe: { license: null, replaced_by: "acme/bar", deprecated: "use acme/bar" },
    });

    await enrichIndex({ root: dir, run });

    const data = sidecar("github.com/acme", "foo");
    expect(data).not.toHaveProperty("license");
    expect(data.replacedBy).toBe("acme/bar");
    expect(data.deprecated).toBe("use acme/bar");
  });

  it("skips the download when the companion digest has not moved", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    const first = fakeGrim();
    await enrichIndex({ root: dir, run: first.run });
    expect(first.calls.map((c) => c[0])).toEqual(["describe", "fetch", "fetch"]);

    const second = fakeGrim();
    await enrichIndex({ root: dir, run: second.run });

    // describe (cheap, always) + the digest probe. No second full fetch.
    expect(second.calls).toHaveLength(2);
    expect(second.calls[1]).toContain("--digest-only");
    // …and the cached companion state survives, rather than resetting to false.
    expect(sidecar("github.com/acme", "foo")).toMatchObject({
      hasReadme: true,
      hasChangelog: true,
      logo: "/logos/github.com/acme/foo.svg",
    });
  });

  it("drops a companion file the registry no longer serves", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    await enrichIndex({ root: dir, run: fakeGrim().run });

    // The digest moved and CHANGELOG.md is gone upstream. The detail page
    // globs the directory, so a leftover file would render forever.
    const { run } = fakeGrim({ digest: "sha256:bbb", files: [{ path: "README.md", content: "v2" }] });
    await enrichIndex({ root: dir, run });

    const out = path.join(dir, "enrich/github.com/acme/foo");
    expect(fs.existsSync(path.join(out, "changelog.md"))).toBe(false);
    expect(fs.existsSync(path.join(out, "logo.svg"))).toBe(false);
    expect(fs.readFileSync(path.join(out, "readme.md"), "utf8")).toBe("v2");
    expect(sidecar("github.com/acme", "foo")).toMatchObject({
      hasReadme: true,
      hasChangelog: false,
    });
    expect(sidecar("github.com/acme", "foo")).not.toHaveProperty("logo");
  });

  it("clears the companions when the description is withdrawn entirely", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    await enrichIndex({ root: dir, run: fakeGrim().run });

    const { run, calls } = fakeGrim({ describe: { has_description: false } });
    await enrichIndex({ root: dir, run });

    const out = path.join(dir, "enrich/github.com/acme/foo");
    expect(fs.readdirSync(out)).toEqual(["data.json"]);
    expect(calls).toHaveLength(1); // nothing to probe
    expect(sidecar("github.com/acme", "foo")).toMatchObject({
      hasReadme: false,
      hasChangelog: false,
    });
  });

  it("refuses a logo whose name would write outside its own directory", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    const { run } = fakeGrim({
      files: [
        { path: "logo.a/b", content: "x" },
        { path: "logo.../../evil", content: "x" },
        { path: "logo.", content: "x" },
        { path: "logo.svg", content: "ok" },
      ],
    });

    await enrichIndex({ root: dir, run });

    const out = path.join(dir, "enrich/github.com/acme/foo");
    expect(fs.readdirSync(out).sort()).toEqual(["data.json", "logo.svg"]);
    expect(fs.existsSync(path.join(dir, "enrich/github.com/acme/evil"))).toBe(false);
    expect(sidecar("github.com/acme", "foo").logo).toBe("/logos/github.com/acme/foo.svg");
  });

  it("keeps the stale sidecar when one package fails, and reports it", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    addPackage("github.com/acme", "bar", "ghcr.io/acme/skills/bar");
    await enrichIndex({ root: dir, run: fakeGrim().run });

    const run: GrimRunner = (args) => {
      if (args[1] === "ghcr.io/acme/skills/foo") return Promise.reject(new Error("registry 503"));
      return fakeGrim({ digest: "sha256:ccc" }).run(args);
    };
    const result = await enrichIndex({ root: dir, run });

    expect(result).toEqual({
      total: 2,
      enriched: 1,
      failures: ["ghcr.io/acme/skills/foo: registry 503"],
    });
    // Stale beats empty: foo keeps what the last good run wrote.
    expect(sidecar("github.com/acme", "foo").descDigest).toBe("sha256:aaa");
    expect(sidecar("github.com/acme", "bar").descDigest).toBe("sha256:ccc");
  });

  it("is a no-op on a repo with no packages yet", async () => {
    expect(await enrichIndex({ root: dir, run: fakeGrim().run })).toEqual({
      total: 0,
      enriched: 0,
      failures: [],
    });
  });
});
