// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The checkpoint exists for one measurable reason: a CI run that starts from an
// empty `enrich/` re-downloads every companion and re-dates every artifact that
// carries no `created`. So the headline tests here are not "did the files come
// back" but "did the registry stay untouched" and "did `updated` hold still" —
// both asserted through `fakeGrim`'s recorded calls, because a seed that
// restored the tree but still re-fetched everything would look identical on
// disk and buy nothing.
//
// The second theme is that a checkpoint is data off the network, so it may lie.
// A document that claims a README it does not carry must not leave behind a
// digest that stops the real one ever being fetched again — that failure is
// silent, permanent, and invisible on disk, which is why it gets its own cases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enrichIndex, type GrimRunner } from "../../src/enrich/index.js";
import {
  CHECKPOINT_FILE,
  SCHEMA_VERSION,
  packCheckpoint,
  seedFromCheckpoint,
  type CheckpointEntry,
} from "../../src/enrich/checkpoint.js";
import { stubFetch } from "../validate/helpers.js";

const URL_ = `https://index.example.com/${CHECKPOINT_FILE}`;

let dir: string;
let outDir: string;

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
  kind: "skill",
  digest: "sha256:art",
  title: "Foo",
  summary: "A foo.",
  version: "1.2.3",
  license: "Apache-2.0",
  keywords: ["a"],
  tags: ["1.2.3", "latest"],
  deprecated: null,
  has_description: true,
};

const COMPANION = [
  { path: "README.md", content: "# Foo\n" },
  { path: "CHANGELOG.md", content: "## 1.2.3\n" },
  { path: "logo.svg", content: Buffer.from("<svg/>").toString("base64"), encoding: "base64" },
];

interface FakeOptions {
  describe?: Record<string, unknown>;
  digest?: string;
}

/** Records every `grim` call, so "did it re-download?" is directly assertable. */
function fakeGrim(opts: FakeOptions = {}): { run: GrimRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GrimRunner = (args) => {
    calls.push(args);
    if (args[0] === "describe") return Promise.resolve({ ...DESCRIBE, ...opts.describe });
    if (args.includes("--digest-only")) return Promise.resolve({ digest: opts.digest ?? "sha256:aaa" });
    if (!args.includes("--description")) return Promise.resolve({ content: "# Entry\n" });
    return Promise.resolve({ files: COMPANION });
  };
  return { run, calls };
}

function sidecarDir(namespace: string, name: string): string {
  return path.join(dir, "enrich", namespace, name);
}

function sidecar(namespace: string, name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(sidecarDir(namespace, name), "data.json"), "utf8"),
  ) as Record<string, unknown>;
}

/** Every entry `compileIndex` would hand `packCheckpoint` for this tree. */
function entries(): CheckpointEntry[] {
  return [{ namespace: "github.com/acme", name: "foo", dir: sidecarDir("github.com/acme", "foo") }];
}

/** Pack the current tree, then delete it — the shape a fresh CI checkout has. */
function packAndWipe(): string {
  packCheckpoint(outDir, entries());
  const body = fs.readFileSync(path.join(outDir, CHECKPOINT_FILE), "utf8");
  fs.rmSync(path.join(dir, "enrich"), { recursive: true, force: true });
  return body;
}

/** Serve `body` at the checkpoint URL and seed from it. */
async function seed(body: string, status = 200): Promise<number> {
  stubFetch((url) => (url === URL_ ? { status, body } : null));
  return seedFromCheckpoint({ root: dir, url: URL_ });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-checkpoint-"));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-checkpoint-out-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("packCheckpoint", () => {
  it("round trips the sidecar tree byte for byte", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo:1.2.3");
    await enrichIndex({ root: dir, run: fakeGrim().run });

    const before = sidecar("github.com/acme", "foo");
    const files = ["readme.md", "changelog.md", "logo.svg", "contents.md"].map((name) =>
      fs.readFileSync(path.join(sidecarDir("github.com/acme", "foo"), name)),
    );

    expect(await seed(packAndWipe())).toBe(1);

    expect(sidecar("github.com/acme", "foo")).toEqual(before);
    files.forEach((content, i) => {
      const name = ["readme.md", "changelog.md", "logo.svg", "contents.md"][i];
      expect(fs.readFileSync(path.join(sidecarDir("github.com/acme", "foo"), name))).toEqual(content);
    });
  });

  it("writes nothing when no package has a sidecar", () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    packCheckpoint(outDir, entries());
    expect(fs.existsSync(path.join(outDir, CHECKPOINT_FILE))).toBe(false);
  });

  it("omits `files` for a package that carries none", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    // No companion and no contents: a bundle kind writes neither.
    await enrichIndex({
      root: dir,
      run: fakeGrim({ describe: { has_description: false, kind: "unknown" } }).run,
    });

    packCheckpoint(outDir, entries());
    const doc = JSON.parse(fs.readFileSync(path.join(outDir, CHECKPOINT_FILE), "utf8")) as {
      packages: Record<string, Record<string, unknown>>;
    };
    expect(doc.packages["github.com/acme/foo"]).not.toHaveProperty("files");
  });
});

describe("seedFromCheckpoint", () => {
  /** Enrich once, publish the checkpoint, wipe, seed, and enrich again. */
  async function reseed(): Promise<string[][]> {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo:1.2.3");
    await enrichIndex({ root: dir, run: fakeGrim().run });
    await seed(packAndWipe());

    const second = fakeGrim();
    await enrichIndex({ root: dir, run: second.run });
    return second.calls;
  }

  it("leaves the registry alone for a package that has not moved", async () => {
    const calls = await reseed();

    // `describe` always runs; it is the probe, not a download. What must not
    // happen is either `fetch` — the companion or the artifact payload.
    expect(calls.filter((args) => args[0] === "describe")).toHaveLength(1);
    expect(calls.filter((args) => args.includes("--digest-only"))).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "fetch" && !args.includes("--digest-only"))).toEqual([]);
  });

  it("holds `updated` still across the seed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo:1.2.3");
    await enrichIndex({ root: dir, run: fakeGrim().run });
    const stamped = sidecar("github.com/acme", "foo").updated;
    expect(stamped).toBe("2026-01-01T00:00:00Z");

    await seed(packAndWipe());
    // A later build must not re-date an artifact that never moved. Without the
    // checkpoint this is exactly where every package picks up the build clock.
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    await enrichIndex({ root: dir, run: fakeGrim().run });

    expect(sidecar("github.com/acme", "foo").updated).toBe(stamped);
  });

  it("never overwrites a sidecar that is already on disk", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    await enrichIndex({ root: dir, run: fakeGrim().run });

    packCheckpoint(outDir, entries());
    const published = fs.readFileSync(path.join(outDir, CHECKPOINT_FILE), "utf8");

    fs.writeFileSync(
      path.join(sidecarDir("github.com/acme", "foo"), "readme.md"),
      "# Local edit\n",
    );
    expect(await seed(published)).toBe(0);
    expect(
      fs.readFileSync(path.join(sidecarDir("github.com/acme", "foo"), "readme.md"), "utf8"),
    ).toBe("# Local edit\n");
  });

  it("ignores a package the index does not list", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    const body = JSON.stringify({
      schema_version: SCHEMA_VERSION,
      packages: {
        "../../etc": { data: { hasReadme: false }, files: { "readme.md": "eA==" } },
        "github.com/other/bar": { data: { hasReadme: false } },
      },
    });

    expect(await seed(body)).toBe(0);
    expect(fs.existsSync(path.join(dir, "enrich"))).toBe(false);
  });

  it("ignores a filename outside the whitelist", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    const body = JSON.stringify({
      schema_version: SCHEMA_VERSION,
      packages: {
        "github.com/acme/foo": {
          data: { hasReadme: false, hasChangelog: false, hasContents: false },
          files: {
            "readme.md": Buffer.from("# ok\n").toString("base64"),
            "../escape.md": Buffer.from("no\n").toString("base64"),
            "logo.": Buffer.from("no\n").toString("base64"),
            "logo.a/b": Buffer.from("no\n").toString("base64"),
            "notes.txt": Buffer.from("no\n").toString("base64"),
          },
        },
      },
    });

    expect(await seed(body)).toBe(1);
    const out = sidecarDir("github.com/acme", "foo");
    expect(fs.readdirSync(out).sort()).toEqual(["data.json", "readme.md"]);
    expect(fs.existsSync(path.join(dir, "escape.md"))).toBe(false);
  });

  it("drops descDigest when the document claims a README it does not carry", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo:1.2.3");
    await enrichIndex({ root: dir, run: fakeGrim().run });

    packCheckpoint(outDir, entries());
    const doc = JSON.parse(fs.readFileSync(path.join(outDir, CHECKPOINT_FILE), "utf8")) as {
      packages: Record<string, { files: Record<string, string> }>;
    };
    // The lie: the flag and the digest both still say there is a README.
    delete doc.packages["github.com/acme/foo"].files["readme.md"];
    fs.rmSync(path.join(dir, "enrich"), { recursive: true, force: true });

    expect(await seed(JSON.stringify(doc))).toBe(1);
    const data = sidecar("github.com/acme", "foo");
    expect(data.hasReadme).toBe(false);
    expect(data).not.toHaveProperty("descDigest");

    // And the digest being gone is what makes the next run go and get it.
    const second = fakeGrim();
    await enrichIndex({ root: dir, run: second.run });
    expect(second.calls.some((args) => args.includes("--description") && !args.includes("--digest-only"))).toBe(true);
    expect(sidecar("github.com/acme", "foo").hasReadme).toBe(true);
  });

  it("drops contentDigest when the document claims contents it does not carry", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo:1.2.3");
    await enrichIndex({ root: dir, run: fakeGrim().run });

    packCheckpoint(outDir, entries());
    const doc = JSON.parse(fs.readFileSync(path.join(outDir, CHECKPOINT_FILE), "utf8")) as {
      packages: Record<string, { files: Record<string, string> }>;
    };
    delete doc.packages["github.com/acme/foo"].files["contents.md"];
    fs.rmSync(path.join(dir, "enrich"), { recursive: true, force: true });

    expect(await seed(JSON.stringify(doc))).toBe(1);
    const data = sidecar("github.com/acme", "foo");
    expect(data.hasContents).toBe(false);
    expect(data).not.toHaveProperty("contentDigest");
  });

  // A sidecar written before a flag existed simply omits it, and omission says
  // the same thing `false` does. Reading that as a disagreement would drop a
  // digest that is still perfectly good and re-download the file it guards.
  it("does not treat an absent flag as a lie", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    const body = JSON.stringify({
      schema_version: SCHEMA_VERSION,
      packages: {
        "github.com/acme/foo": {
          data: { summary: "old", descDigest: "sha256:keep", contentDigest: "sha256:keep-too" },
        },
      },
    });

    expect(await seed(body)).toBe(1);
    const data = sidecar("github.com/acme", "foo");
    expect(data.descDigest).toBe("sha256:keep");
    expect(data.contentDigest).toBe("sha256:keep-too");
    expect(data.hasReadme).toBe(false);
  });

  it("reconciles a logo carried under a different extension", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo:1.2.3");
    await enrichIndex({ root: dir, run: fakeGrim().run });

    packCheckpoint(outDir, entries());
    const doc = JSON.parse(fs.readFileSync(path.join(outDir, CHECKPOINT_FILE), "utf8")) as {
      packages: Record<string, { files: Record<string, string> }>;
    };
    const files = doc.packages["github.com/acme/foo"].files;
    files["logo.png"] = files["logo.svg"];
    delete files["logo.svg"];
    fs.rmSync(path.join(dir, "enrich"), { recursive: true, force: true });

    expect(await seed(JSON.stringify(doc))).toBe(1);
    const data = sidecar("github.com/acme", "foo");
    // The record must name the file that actually landed, or `compileIndex`
    // publishes a card pointing at a logo it never copied.
    expect(data.logo).toBe("/logos/github.com/acme/foo.png");
    expect(data).not.toHaveProperty("descDigest");
  });

  it.each([
    ["a 404", 404, ""],
    ["a 500", 500, ""],
    ["a redirect it will not follow", 302, ""],
    ["a body that does not parse", 200, "{"],
    ["a document that is not an object", 200, "[]"],
    ["a document with no packages object", 200, `{"schema_version":1}`],
    ["a version this build does not read", 200, `{"schema_version":99,"packages":{}}`],
  ])("seeds nothing and keeps going on %s", async (_label, status, body) => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");

    expect(await seed(body, status)).toBe(0);
    expect(fs.existsSync(path.join(dir, "enrich"))).toBe(false);

    // The run still has to produce a complete site.
    const after = fakeGrim();
    await enrichIndex({ root: dir, run: after.run });
    expect(sidecar("github.com/acme", "foo").hasReadme).toBe(true);
  });

  it("seeds nothing when the request never completes", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));

    expect(await seedFromCheckpoint({ root: dir, url: URL_ })).toBe(0);
    expect(fs.existsSync(path.join(dir, "enrich"))).toBe(false);
  });

  it("asks for a cap larger than the default", async () => {
    addPackage("github.com/acme", "foo", "ghcr.io/acme/skills/foo");
    const calls = stubFetch(() => ({ status: 404 }));

    await seedFromCheckpoint({ root: dir, url: URL_ });

    // A checkpoint is the whole sidecar tree; the 1 MiB default would read a
    // real index's document as a transport failure.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_);
    expect(calls[0].redirect).toBe("manual");
  });
});
