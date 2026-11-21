// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Paths the fake-grim unit tests cannot prove, run against a real grim: the
// digest probe on a second enrich, the description companion, `export
// marketplace`, and what a grim reading the emitted index sees. Needs the same
// two variables as dependencies.test.ts; see its header.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { build } from "../../src/cli/build.js";
import { enrich } from "../../src/cli/enrich.js";
import { EXIT } from "../../src/cli/exit.js";
import { enrichIndex, spawnGrim, type GrimRunner } from "../../src/enrich/index.js";
import { BlobStore } from "../../src/state/blobstore.js";
import { bucketNumber, isDue, isRot, rotationMs } from "../../src/state/detect.js";
import { STATE_DIR } from "../../src/state/handoff.js";
import { BIN, HAS_MOD, NS, freshPrefix, release, stubGrimEnv, write } from "./harness.js";

const skill = (name: string, extra = ""): string => `---\nname: ${name}\ndescription: The ${name} skill.\n${extra}---\n# ${name}\n`;
const pointer = (name: string, kind: string, ref: string, more: Record<string, unknown> = {}): string =>
  JSON.stringify({ schema: 1, name, kind, ref, description: `The ${name} ${kind}.`, owner: { id: 1, github: "octocat" }, ...more });
const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

describe("the probe and the description companion", () => {
  const WINDOW = 3_600_000;
  let tmp: string;
  let root: string;
  let refs: { plain: string; docs: string };
  const sidecarFile = (name: string, file: string): string => path.join(root, "enrich", NS, name, file);

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "index-live-probe-"));
    root = path.join(tmp, "index-root");
    stubGrimEnv(tmp);
    const prefix = freshPrefix();
    const src = path.join(tmp, "src");
    refs = { plain: `${prefix}/skills/plain`, docs: `${prefix}/skills/docs` };

    write(path.join(src, "plain", "SKILL.md"), skill("plain"));
    release(path.join(src, "plain"), refs.plain);

    // A description companion rides `grim publish`: README, CHANGELOG and a logo beside the manifest.
    const pub = path.join(tmp, "pub");
    write(path.join(pub, "skills", "docs", "SKILL.md"), skill("docs"));
    write(path.join(pub, "README.md"), "# Readme\n");
    write(path.join(pub, "CHANGELOG.md"), "# Changes\n");
    write(path.join(pub, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n');
    const repo = refs.docs.slice(refs.docs.indexOf("/") + 1, refs.docs.lastIndexOf("/skills/"));
    write(path.join(pub, "publish.toml"), `registry = "${refs.docs.slice(0, refs.docs.indexOf("/"))}"\nrepository_prefix = "${repo}/skills"\n[skills.docs]\nversion = "1.0.0"\n`);
    execFileSync(BIN!, ["publish", "--format", "json"], { cwd: pub, encoding: "utf8", timeout: 60_000 });

    write(path.join(root, "index", NS, "plain", "metadata.json"), pointer("plain", "skill", refs.plain));
    write(path.join(root, "index", NS, "docs", "metadata.json"), pointer("docs", "skill", refs.docs));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("a second enrich with the bucket due probes the unchanged refs and leaves them as they were", async () => {
    const calls: string[][] = [];
    const real = spawnGrim(BIN);
    const run: GrimRunner = (args, opts) => {
      calls.push(args);
      return real(args, opts);
    };
    const store = new BlobStore(path.join(root, STATE_DIR));
    const t0 = Math.floor(Date.now() / 1000) * 1000;

    const first = await enrichIndex({ root, run, store, startedAt: t0, revalidateMs: WINDOW });
    expect(first.failures).toEqual([]);
    expect(first.counters.deep).toBe(2);
    const before = Object.fromEntries(["plain", "docs"].map((n) => [n, fs.readFileSync(sidecarFile(n, "data.json"), "utf8")]));

    // The first start at which every bucket is due again but none is a rotation, which would go deep.
    const stamps = Object.entries(first.stamps);
    expect(stamps.length).toBeGreaterThan(0);
    let later: number | undefined;
    for (let delta = WINDOW; delta < 3 * WINDOW && later === undefined; delta += 60_000) {
      const now = t0 + delta;
      const ok = stamps.every(
        ([id, stamp]) =>
          isDue({ now, windowMs: WINDOW, bucket: bucketNumber(id), stamp, pointers: stamp.pointers!, version: stamp.enricher! }) &&
          !isRot({ now, rotationMs: rotationMs(WINDOW), bucket: bucketNumber(id), stamp }),
      );
      if (ok) later = now;
    }
    expect(later, "no start makes every bucket due without a rotation").toBeDefined();

    calls.length = 0;
    const second = await enrichIndex({
      root,
      run,
      store,
      plane: { entries: first.entries, stamps: first.stamps },
      startedAt: later,
      revalidateMs: WINDOW,
    });

    // `plain` has no companion, so its `--description` probe exits 79, which must not fail the ref.
    expect(second.failures).toEqual([]);
    expect(second.counters.probed).toBe(2);
    expect(second.counters.deep).toBe(0);
    for (const ref of [refs.plain, refs.docs]) {
      expect(calls).toContainEqual(["fetch", ref, "--digest-only"]);
      expect(calls).toContainEqual(["fetch", ref, "--description", "--digest-only"]);
    }
    expect(calls.filter((c) => c[0] === "describe")).toEqual([]);
    for (const name of ["plain", "docs"]) expect(fs.readFileSync(sidecarFile(name, "data.json"), "utf8")).toBe(before[name]);
  });

  it("a published description companion reaches the sidecar: README, CHANGELOG and logo", () => {
    const data = readJson(sidecarFile("docs", "data.json"));
    expect(data.hasReadme).toBe(true);
    expect(data.hasChangelog).toBe(true);
    expect(data.logo).toBe(`/logos/${NS}/docs.svg`);
    expect(fs.readFileSync(sidecarFile("docs", "readme.md"), "utf8")).toBe("# Readme\n");
    expect(fs.readFileSync(sidecarFile("docs", "changelog.md"), "utf8")).toBe("# Changes\n");
    expect(fs.existsSync(sidecarFile("docs", "logo.svg"))).toBe(true);
    // A package that publishes none says so.
    const plain = readJson(sidecarFile("plain", "data.json"));
    expect(plain.hasReadme).toBe(false);
    expect(plain.hasChangelog).toBe(false);
  });
});

describe("the marketplace export and the emitted index, read by a real grim", () => {
  let tmp: string;
  let root: string;
  let out: string;
  let server: http.Server;
  let prefix: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "index-live-reader-"));
    root = path.join(tmp, "index-root");
    out = path.join(tmp, "out");
    stubGrimEnv(tmp);
    prefix = freshPrefix();
    const src = path.join(tmp, "src");

    // Marketplace members: one of each kind a plugin can name.
    write(path.join(src, "m-skill", "SKILL.md"), skill("m-skill"));
    write(path.join(src, "m-hook", "hook.toml"), 'schema = 1\nname = "m-hook"\ndescription = "The hook."\n[[hooks]]\nid = "noop"\nevent = "PreToolUse"\ntier = "observer"\nargv = ["sh", "run.sh"]\ntimeout = 5\npayload = "stdin"\n');
    write(path.join(src, "m-hook", "run.sh"), "exit 0\n");
    write(path.join(src, "m-settings.toml"), 'description = "The settings."\n[claude]\nmodel = "sonnet"\n');
    const members = [`${prefix}/mk/skill`, `${prefix}/mk/hook`, `${prefix}/mk/settings`];
    release(path.join(src, "m-skill"), members[0]!, "skill");
    release(path.join(src, "m-hook"), members[1]!, "hook");
    release(path.join(src, "m-settings.toml"), members[2]!, "settings");

    // The packages the index points at.
    write(path.join(src, "mod", "mod.toml"), 'schema = 1\nname = "mod"\ndescription = "The mod."\n');
    write(path.join(src, "mod", "claude", "mod.ts"), "export default {};\n");
    write(path.join(src, "mod", "opencode", "mod.ts"), "export default {};\n");
    const successor = `${prefix}/skills/successor`;
    // `moved` names its successor in the pointer only; `old` in the annotation only; `both` in both.
    const deprecated = (name: string, replacedBy: boolean): string =>
      skill(name, `metadata:\n  deprecated: "use the successor"\n${replacedBy ? `  replaced-by: ${successor}\n` : ""}`);
    write(path.join(src, "moved", "SKILL.md"), deprecated("moved", false));
    write(path.join(src, "old", "SKILL.md"), deprecated("old", true));
    write(path.join(src, "both", "SKILL.md"), deprecated("both", true));
    for (const name of ["moved", "old", "both"]) release(path.join(src, name), `${prefix}/skills/${name}`, "skill");
    write(path.join(root, "index", NS, "moved", "metadata.json"), pointer("moved", "skill", `${prefix}/skills/moved`, { deprecated: "use the successor", replaced_by: successor }));
    write(path.join(root, "index", NS, "old", "metadata.json"), pointer("old", "skill", `${prefix}/skills/old`, { deprecated: "use the successor" }));
    write(path.join(root, "index", NS, "both", "metadata.json"), pointer("both", "skill", `${prefix}/skills/both`, { deprecated: "use the successor", replaced_by: successor }));
    if (HAS_MOD) {
      release(path.join(src, "mod"), `${prefix}/mods/mod`, "mod");
      write(path.join(root, "index", NS, "mod", "metadata.json"), pointer("mod", "mod", `${prefix}/mods/mod`));
    }

    const include = [...members, ...(HAS_MOD ? [`${prefix}/mods/mod`] : [])].map((m) => `"${m}:${"1.0.0"}"`);
    write(path.join(root, "marketplace.toml"), `[marketplace]\nname = "live"\nowner = { name = "Acme" }\n\n[plugins.team]\ninclude = [${include.join(", ")}]\ndescription = "The team plugin"\n`);

    expect(await enrich(root, { grim: BIN! })).toBe(EXIT.ok);
    expect(await build(root, { outDir: out })).toBe(EXIT.ok);

    // The built site is a static package index: grim reads it over plain HTTP from loopback.
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      const file = path.join(out, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
      if (!file.startsWith(out) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": file.endsWith(".json") ? "application/json" : "application/octet-stream" }).end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    fs.appendFileSync(
      path.join(tmp, "grim-home", "grimoire.toml"),
      `\n[[registries]]\nalias = "live"\nindex = "http://127.0.0.1:${port}"\n`,
    );
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("export marketplace: meta.json lists the members by kind and the lock carries the new tables", () => {
    const meta = readJson(path.join(root, "enrich", "marketplace", "meta.json")) as { members: Record<string, { kind: string; name: string }[]> };
    const team = (meta.members.team ?? []).map(({ kind, name }) => `${kind}:${name}`).sort();
    expect(team).toEqual(["hook:hook", "mod:mod", "settings:settings", "skill:skill"].filter((m) => HAS_MOD || !m.startsWith("mod:")));
    const lock = fs.readFileSync(path.join(root, "marketplace.lock"), "utf8");
    expect(lock).toContain("[[settings]]");
    if (HAS_MOD) expect(lock).toContain("[[mod]]");
  });

  /** The rows `grim search` returns from the served index, by name. */
  async function rows(): Promise<Record<string, Record<string, unknown>>> {
    const cwd = path.join(tmp, "empty");
    fs.mkdirSync(cwd, { recursive: true });
    // Async: the index server shares this process, so a blocking spawn would starve it.
    const { stdout } = await promisify(execFile)(BIN!, ["search", "--refresh", "--show-deprecated", "--format", "json"], { cwd, encoding: "utf8", timeout: 60_000 });
    const items = (JSON.parse(stdout) as { items: Record<string, unknown>[] }).items;
    return Object.fromEntries(items.map((r) => [String(r.repo).slice(String(r.repo).lastIndexOf("/") + 1), r]));
  }
  const successor = (): string => `${prefix}/skills/successor`;

  it("a deprecated package whose successor comes from the pointer reads back with it", async () => {
    expect((await rows()).moved?.deprecated).toBeTruthy();
    expect((await rows()).moved?.replaced_by).toBe(successor());
  });

  it.skipIf(!HAS_MOD)("a deprecated package whose successor comes only from the enrich step reads back with it", async () => {
    expect((await rows()).old?.replaced_by).toBe(successor());
  });

  it.skipIf(!HAS_MOD)("a package whose pointer and enrich step both name the successor is still listed, with it", async () => {
    expect((await rows()).both?.replaced_by).toBe(successor());
  });

  it.skipIf(!HAS_MOD)("a mod's row carries the harnesses it serves", async () => {
    expect((await rows()).mod?.kind).toBe("mod");
    expect((await rows()).mod?.serves).toEqual(["claude", "opencode"]);
  });
});
