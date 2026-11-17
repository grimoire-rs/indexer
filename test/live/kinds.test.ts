// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// One minimal package of each of the seven kinds, published with a real grim.
// The fake-grim unit tests can only print what grim is believed to print for
// an agent, bundle, MCP server, hook or settings package; this reads it.
// Needs the same two variables as dependencies.test.ts; see its header.
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
const KINDS = ["skill", "rule", "agent", "bundle", "mcp", "hook", "settings"] as const;

let tmp: string;
let root: string;

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const enrichFile = (name: string, file: string): string => path.join(root, "enrich", NS, name, file);
const sidecar = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(enrichFile(name, "data.json"), "utf8")) as Record<string, unknown>;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "index-live-kinds-"));
  root = path.join(tmp, "index-root");
  const prefix = `${REGISTRY}/live-${randomBytes(4).toString("hex")}`;

  vi.stubEnv("GRIM_HOME", path.join(tmp, "grim-home"));
  vi.stubEnv("DOCKER_CONFIG", path.join(tmp, "docker"));
  vi.stubEnv("GRIM_INSECURE_REGISTRIES", REGISTRY);
  vi.stubEnv("GRIM_OFFLINE", undefined);
  vi.stubEnv("GRIM_DEFAULT_REGISTRY", undefined);
  // Hooks and settings are experimental kinds: grim publishes them only once
  // the global config opts in.
  write(path.join(tmp, "grim-home", "grimoire.toml"), "[options.experimental]\nsettings = true\nhooks = true\n");

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

  const source: Record<(typeof KINDS)[number], string> = {
    skill: path.join(src, "skill"),
    rule: path.join(src, "rule.md"),
    agent: path.join(src, "agent.md"),
    bundle: path.join(src, "bundle.toml"),
    mcp: path.join(src, "mcp.toml"),
    hook: path.join(src, "hook"),
    settings: path.join(src, "settings.toml"),
  };
  for (const kind of KINDS) {
    const ref = `${prefix}/kinds/${kind}`;
    execFileSync(BIN!, ["release", source[kind], `${ref}:1.0.0`, "--kind", kind, "--no-git", "--format", "json"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    write(
      path.join(root, "index", NS, kind, "metadata.json"),
      JSON.stringify({ schema: 1, name: kind, kind, ref, description: `The ${kind}.`, owner: { id: 1, github: "octocat" } }),
    );
  }

  expect(await enrich(root, { grim: BIN })).toBe(EXIT.ok);
  expect(await build(root, { outDir: path.join(tmp, "out") })).toBe(EXIT.ok);
});

afterAll(() => {
  vi.unstubAllEnvs();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("every artifact kind from a real grim", () => {
  it("the published record carries each package's kind", () => {
    const records = JSON.parse(fs.readFileSync(path.join(tmp, "out", "all.json"), "utf8")) as { name: string; kind: string }[];
    expect(Object.fromEntries(records.map((r) => [r.name, r.kind]))).toEqual(Object.fromEntries(KINDS.map((k) => [k, k])));
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
