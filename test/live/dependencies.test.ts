// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The one suite that runs a real `grim`. Everywhere else grim is an injected
// runner, which can only print what grim is believed to print; this publishes
// to a scratch registry and runs `enrich` and `build` over an index pointing at
// what it published, so a change in grim's real output shows up here.
//
// `npm run test:live` runs it, never `npm test`. It needs two variables and
// fails without them rather than skipping, so a CI job that lost one cannot
// pass green having tested nothing:
//
//   GRIM_LIVE_BIN       absolute path of the grim under test
//   GRIM_LIVE_REGISTRY  host:port of a writable plain-HTTP OCI registry
//
// CI builds grim at the commit test/live/GRIM_COMMIT names.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { build } from "../../src/cli/build.js";
import { enrich } from "../../src/cli/enrich.js";
import { EXIT } from "../../src/cli/exit.js";

const BIN = process.env.GRIM_LIVE_BIN;
const REGISTRY = process.env.GRIM_LIVE_REGISTRY;
if (!BIN || !path.isAbsolute(BIN) || !REGISTRY) {
  throw new Error(
    "test/live needs GRIM_LIVE_BIN (absolute path of a grim binary) and GRIM_LIVE_REGISTRY (host:port of a writable plain-HTTP OCI registry)",
  );
}

const NS = "github.com/acme";
const VERSION = "1.0.0";

let tmp: string;
let root: string;
let out: string;
/** A fresh repository prefix per run, so a reused registry never answers with a previous run's tags. */
let prefix: string;
/** `dep`'s manifest digest, which `top` pins it by. */
let depDigest: string;

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** Publishes `source` as `<ref>:1.0.0` and returns its manifest digest. */
function release(source: string, ref: string): string {
  const report = execFileSync(BIN!, ["release", source, `${ref}:${VERSION}`, "--no-git", "--format", "json"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return (JSON.parse(report) as { manifest_digest: string }).manifest_digest;
}

function addPackage(name: string, kind: string, ref: string): void {
  write(
    path.join(root, "index", NS, name, "metadata.json"),
    JSON.stringify({ schema: 1, name, kind, ref, description: `The ${name} ${kind}.`, owner: { id: 1, github: "octocat" } }),
  );
}

const sidecar = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(root, "enrich", NS, name, "data.json"), "utf8")) as Record<string, unknown>;

const page = (name: string): string => fs.readFileSync(path.join(out, "p", NS, name, "index.html"), "utf8");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "index-live-"));
  root = path.join(tmp, "index-root");
  out = path.join(tmp, "out");
  prefix = `${REGISTRY}/live-${randomBytes(4).toString("hex")}`;

  // grim's state, cache and credentials stay in the scratch dir, and the
  // scratch registry is spoken to over plain HTTP whatever its port.
  vi.stubEnv("GRIM_HOME", path.join(tmp, "grim-home"));
  vi.stubEnv("DOCKER_CONFIG", path.join(tmp, "docker"));
  vi.stubEnv("GRIM_INSECURE_REGISTRIES", REGISTRY);
  vi.stubEnv("GRIM_OFFLINE", undefined);
  vi.stubEnv("GRIM_DEFAULT_REGISTRY", undefined);

  const src = path.join(tmp, "src");
  // `top` declares one id of each form: `dep` beside it and pinned by digest,
  // `style` one directory up, both indexed, and `ext` absolute and not indexed.
  const rule = (name: string) => `---\ndescription: The ${name} rule.\npaths:\n  - "**/*.rs"\n---\n# ${name}\n`;
  write(path.join(src, "dep", "SKILL.md"), "---\nname: dep\ndescription: A dependency.\n---\n# dep\n");
  write(path.join(src, "style.md"), rule("style"));
  write(path.join(src, "ext.md"), rule("ext"));
  depDigest = release(path.join(src, "dep"), `${prefix}/skills/dep`);
  release(path.join(src, "style.md"), `${prefix}/rules/style`);
  release(path.join(src, "ext.md"), `${prefix}/elsewhere/rules/ext`);
  write(
    path.join(src, "top", "SKILL.md"),
    [
      "---",
      "name: top",
      "description: Needs dep, style and ext.",
      "metadata:",
      `  grim.requires.skills.dep: "./dep:${VERSION}@${depDigest}"`,
      `  grim.requires.rules.style: "../rules/style:${VERSION}"`,
      `  grim.requires.rules.ext: "${prefix}/elsewhere/rules/ext:${VERSION}"`,
      "---",
      "# top",
      "",
    ].join("\n"),
  );
  release(path.join(src, "top"), `${prefix}/skills/top`);

  addPackage("dep", "skill", `${prefix}/skills/dep`);
  addPackage("style", "rule", `${prefix}/rules/style`);
  addPackage("top", "skill", `${prefix}/skills/top`);

  expect(await enrich(root, { grim: BIN })).toBe(EXIT.ok);
  expect(await build(root, { outDir: out })).toBe(EXIT.ok);
});

afterAll(() => {
  vi.unstubAllEnvs();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** A `requires` list in name order, anything else as it is: the order is grim's to choose. */
function byName(requires: unknown): unknown {
  if (!Array.isArray(requires)) return requires;
  return [...(requires as { name: string }[])].sort((a, b) => a.name.localeCompare(b.name));
}

describe("declared dependencies from a real grim", () => {
  it("enrich and the published all.json carry what describe reports, relative ids verbatim", () => {
    const declared = [
      { kind: "skill", name: "dep", id: `./dep:${VERSION}@${depDigest}` },
      { kind: "rule", name: "ext", id: `${prefix}/elsewhere/rules/ext:${VERSION}` },
      { kind: "rule", name: "style", id: `../rules/style:${VERSION}` },
    ];
    expect(byName(sidecar("top").requires)).toEqual(declared);
    const records = JSON.parse(fs.readFileSync(path.join(out, "all.json"), "utf8")) as Record<string, unknown>[];
    expect(byName(records.find((r) => r.name === "top")?.requires)).toEqual(declared);
    // Declaring none is `[]`, which the page tells apart from an unknown `null`.
    expect(sidecar("dep").requires).toEqual([]);
  });

  it("the package page lists them, linking the ones this index carries", () => {
    const html = page("top");
    expect(html).toContain('<label for="panel-dependencies"');
    const panel = html.slice(html.indexOf('id="tab-dependencies"'));
    expect(panel).toContain(`href="/p/${NS}/dep/"`);
    expect(panel).toContain(`href="/p/${NS}/style/"`);
    expect(panel).toMatch(/<span title="not in this index"[^>]*>ext<\/span>/);
    expect(panel).not.toContain("dependencies unknown");
  });

  it("a package declaring none greys the tab as no dependencies", () => {
    expect(page("dep")).toMatch(/<label title="no dependencies"[^>]*>Dependencies<\/label>/);
  });
});
