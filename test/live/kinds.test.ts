// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// One minimal package of each kind, published with a real grim.
// The fake-grim unit tests can only print what grim is believed to print for
// an agent, bundle, MCP server, hook or settings package; this reads it.
// Needs the same two variables as dependencies.test.ts; see its header.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { build } from "../../src/cli/build.js";
import { enrich } from "../../src/cli/enrich.js";
import { EXIT } from "../../src/cli/exit.js";
import { KINDS as PROGRAM_KINDS } from "../../src/validate/core/metadata.js";
import { BIN, HAS_MOD, NS, freshPrefix, release, stubGrimEnv, write } from "./harness.js";

// Every kind the program knows, each with a case below: a kind added to the program without one fails the first test.
const KINDS = ["skill", "rule", "agent", "bundle", "mcp", "hook", "settings", "mod"] as const;
// The kinds this grim can publish.
const LIVE = KINDS.filter((k) => k !== "mod" || HAS_MOD);

let tmp: string;
let root: string;

const enrichFile = (name: string, file: string): string => path.join(root, "enrich", NS, name, file);
const sidecar = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(enrichFile(name, "data.json"), "utf8")) as Record<string, unknown>;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "index-live-kinds-"));
  root = path.join(tmp, "index-root");
  const prefix = freshPrefix();
  stubGrimEnv(tmp);

  const src = path.join(tmp, "src");
  write(path.join(src, "skill", "SKILL.md"), "---\nname: skill\ndescription: The skill.\n---\n# skill\n");
  write(path.join(src, "rule.md"), "---\ndescription: The rule.\npaths:\n  - \"**/*.rs\"\n---\n# rule\n");
  write(path.join(src, "agent.md"), "---\nname: agent\ndescription: The agent.\n---\nYou review code.\n");
  // A member is written relative to the bundle: `./skill` is its sibling.
  write(path.join(src, "bundle.toml"), 'description = "The bundle."\n[skills]\nskill = "./skill:1"\n[rules]\nrule = "./rule:1"\n');
  write(
    path.join(src, "mcp.toml"),
    'description = "The MCP server."\nsummary = "demo mcp"\n[server]\ntransport = "stdio"\ncommand = "demo-mcp"\n',
  );
  write(
    path.join(src, "hook", "hook.toml"),
    [
      "schema = 1",
      'name = "hook"',
      'description = "The hook."',
      "[[hooks]]",
      'id = "noop"',
      'event = "PreToolUse"',
      'tier = "observer"',
      'argv = ["sh", "run.sh"]',
      "timeout = 5",
      'payload = "stdin"',
      "",
    ].join("\n"),
  );
  write(path.join(src, "hook", "run.sh"), "exit 0\n");
  write(path.join(src, "settings.toml"), 'description = "The settings."\n[claude]\nmodel = "sonnet"\n');

  // A mod is `<name>/mod.toml` and one directory per harness; the entry defaults to the file named like the mod.
  write(
    path.join(src, "mod", "mod.toml"),
    'schema = 1\nname = "mod"\ndescription = "The mod."\nsummary = "Build status band"\nkeywords = "ci,status"\n',
  );
  write(path.join(src, "mod", "claude", "mod.ts"), "export default {};\n");
  write(path.join(src, "mod", "opencode", "mod.ts"), "export default {};\n");

  const source: Record<(typeof KINDS)[number], string> = {
    skill: path.join(src, "skill"),
    rule: path.join(src, "rule.md"),
    agent: path.join(src, "agent.md"),
    bundle: path.join(src, "bundle.toml"),
    mcp: path.join(src, "mcp.toml"),
    hook: path.join(src, "hook"),
    settings: path.join(src, "settings.toml"),
    mod: path.join(src, "mod"),
  };
  for (const kind of LIVE) {
    const ref = `${prefix}/kinds/${kind}`;
    release(source[kind], ref, kind);
    write(
      path.join(root, "index", NS, kind, "metadata.json"),
      JSON.stringify({ schema: 1, name: kind, kind, ref, description: `The ${kind}.`, owner: { id: 1, github: "octocat" } }),
    );
  }

  expect(await enrich(root, { grim: BIN! })).toBe(EXIT.ok);
  expect(await build(root, { outDir: path.join(tmp, "out") })).toBe(EXIT.ok);
});

afterAll(() => {
  vi.unstubAllEnvs();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("every artifact kind from a real grim", () => {
  it("has a live case for every kind the program knows", () => {
    expect([...KINDS].sort()).toEqual([...PROGRAM_KINDS].sort());
  });

  it("the published record carries each package's kind", () => {
    const records = JSON.parse(fs.readFileSync(path.join(tmp, "out", "all.json"), "utf8")) as { name: string; kind: string }[];
    expect(Object.fromEntries(records.map((r) => [r.name, r.kind]))).toEqual(Object.fromEntries(LIVE.map((k) => [k, k])));
  });

  const record = (name: string): Record<string, unknown> | undefined =>
    (JSON.parse(fs.readFileSync(path.join(tmp, "out", "all.json"), "utf8")) as Record<string, unknown>[]).find((r) => r.name === name);

  it.skipIf(!HAS_MOD)("mod: enrich records the harnesses it serves, sorted, and the record carries them", () => {
    expect(sidecar("mod").serves).toEqual(["claude", "opencode"]);
    expect(record("mod")?.serves).toEqual(["claude", "opencode"]);
  });

  it.skipIf(!HAS_MOD)("mod: the authored summary and keywords reach the sidecar and the record", () => {
    expect(sidecar("mod").summary).toBe("Build status band");
    expect(sidecar("mod").keywords).toEqual(["ci", "status"]);
    expect(record("mod")?.summary).toBe("Build status band");
    expect(record("mod")?.keywords).toEqual(["ci", "status"]);
  });

  it.each(["skill", "rule", "agent"])("%s: enrich records the package and its entry-point markdown", (kind) => {
    expect(sidecar(kind).version).toBe("1.0.0");
    expect(fs.existsSync(enrichFile(kind, "contents.md"))).toBe(true);
  });

  it("bundle: enrich lists its members", () => {
    const contents = JSON.parse(fs.readFileSync(enrichFile("bundle", "contents.json"), "utf8")) as { members: unknown };
    expect(contents.members).toEqual([
      { kind: "skill", name: "skill", id: "./skill:1" },
      { kind: "rule", name: "rule", id: "./rule:1" },
    ]);
  });

  it("mcp: enrich writes the server descriptor", () => {
    const contents = JSON.parse(fs.readFileSync(enrichFile("mcp", "contents.json"), "utf8")) as Record<string, unknown>;
    expect(contents.server).toEqual({ transport: "stdio", command: "demo-mcp" });
  });

  it("settings: enrich writes the settings document", () => {
    const contents = JSON.parse(fs.readFileSync(enrichFile("settings", "contents.json"), "utf8")) as Record<string, unknown>;
    expect(contents.claude).toEqual({ model: "sonnet" });
  });

  it("hook: enrich records the package and, by design, no contents", () => {
    expect(sidecar("hook").version).toBe("1.0.0");
    expect(sidecar("hook").hasContents).toBe(false);
    expect(fs.existsSync(enrichFile("hook", "contents.md"))).toBe(false);
    expect(fs.existsSync(enrichFile("hook", "contents.json"))).toBe(false);
  });
});
