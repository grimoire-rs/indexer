// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { afterEach, describe, expect, it, vi } from "vitest";

import { runValidate } from "../../src/validate/index.js";
import { makeTree, metadata, stubFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const pkg = (name: string, ref: string) => ({
  [`index/github.com/acme/${name}/metadata.json`]: metadata({ name, ref }),
});

const INDEXED = {
  ...pkg("tool", "reg.example.com/acme/tool"),
  ...pkg("stack", "reg.example.com/acme/bundles/stack"),
};

const toml = (include: string[], extra = "") =>
  `[marketplace]\nname = "m"\nowner = { name = "o" }\n\n[plugins.dev]\n${extra}include = [${include.map((r) => JSON.stringify(r)).join(", ")}]\n`;

const lockRow = (kind: string, extra: string) =>
  `[metadata]\nlock_version = 1\n\n[[plugin]]\nname = "dev"\ndeclaration_hash = "sha256:0"\n\n[[${kind}]]\nname = "n"\nplugin = "dev"\n${extra}\n`;

const DIGEST = `@sha256:${"a".repeat(64)}`;

async function gate(files: Record<string, string>, changed: string[]) {
  stubFetch((url) => {
    if (url === "https://api.test/users/acme") {
      return { body: JSON.stringify({ id: 7, login: "acme", type: "User" }) };
    }
    return url.endsWith("/tags/list") ? { body: '{"tags":["1.0.0"]}' } : null;
  });
  const prTree = await makeTree({ ...INDEXED, ...files });
  const root = await makeTree({});
  return runValidate({
    forge: "github",
    root,
    prTree,
    changedFiles: changed,
    author: { login: "acme", id: "7" },
    apiBase: "https://api.test",
  });
}

const REVIEW = (file: string) => `${file}: marketplace changes need maintainer review`;

/** The reasons the member rule added, past the always-present review reason. */
const memberOnly = (reasons: string[]) => reasons.filter((r) => !r.endsWith("need maintainer review"));

describe("marketplace members must be indexed packages", () => {
  it("keeps a member-valid manifest on manual review", async () => {
    const result = await gate(
      { "marketplace.toml": toml(["reg.example.com/acme/tool", "reg.example.com/acme/bundles/stack"]) },
      ["marketplace.toml"],
    );
    expect(result).toEqual({ eligible: false, reasons: [REVIEW("marketplace.toml")] });
  });

  it("reviews every marketplace file the change touches", async () => {
    const result = await gate(
      {
        "marketplace.toml": toml(["reg.example.com/acme/tool"]),
        "marketplace.lock": lockRow("skill", `pinned = "reg.example.com/acme/tool${DIGEST}"`),
      },
      ["marketplace.toml", "marketplace.lock"],
    );
    expect(result.reasons).toEqual([REVIEW("marketplace.toml"), REVIEW("marketplace.lock")]);
  });

  it("names the plugin and the ref of an include that is not indexed", async () => {
    const result = await gate(
      { "marketplace.toml": toml(["reg.example.com/acme/tool", "reg.example.com/acme/missing"]) },
      ["marketplace.toml"],
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toBe(REVIEW("marketplace.toml"));
    expect(result.reasons[1]).toContain('"dev"');
    expect(result.reasons[1]).toContain("reg.example.com/acme/missing");
  });

  it("strips a tag and a digest before comparing", async () => {
    const result = await gate(
      {
        "marketplace.toml": toml([
          "reg.example.com/acme/tool:1.2",
          `reg.example.com/acme/tool${DIGEST}`,
          `reg.example.com/acme/bundles/stack:1${DIGEST}`,
        ]),
      },
      ["marketplace.toml"],
    );
    expect(memberOnly(result.reasons)).toEqual([]);
  });

  it("does not mistake a registry port for a tag", async () => {
    const result = await gate(
      {
        ...pkg("local", "localhost:5000/acme/local"),
        "marketplace.toml": toml(["localhost:5000/acme/local", "localhost:5000/acme/other:2"]),
      },
      ["marketplace.toml"],
    );
    expect(memberOnly(result.reasons)).toHaveLength(1);
    expect(memberOnly(result.reasons)[0]).toContain("localhost:5000/acme/other");
  });

  it("refuses a path member, naming the plugin and the member", async () => {
    const result = await gate(
      { "marketplace.toml": toml(["./skills/local"]) },
      ["marketplace.toml"],
    );
    expect(result.eligible).toBe(false);
    expect(memberOnly(result.reasons)[0]).toContain('"dev"');
    expect(memberOnly(result.reasons)[0]).toContain("./skills/local");
    expect(memberOnly(result.reasons)[0]).toContain("path");
  });

  it("refuses a project member, naming the plugin and the member", async () => {
    const result = await gate(
      { "marketplace.toml": `[plugins.dev]\nproject = "../proj"\n` },
      ["marketplace.toml"],
    );
    expect(result.eligible).toBe(false);
    expect(memberOnly(result.reasons)[0]).toContain('"dev"');
    expect(memberOnly(result.reasons)[0]).toContain("../proj");
    expect(memberOnly(result.reasons)[0]).toContain("project");
  });

  it("checks the lock when only marketplace.lock changed", async () => {
    const bad = await gate(
      { "marketplace.lock": lockRow("skill", `pinned = "reg.example.com/acme/missing${DIGEST}"`) },
      ["marketplace.lock"],
    );
    expect(bad.eligible).toBe(false);
    expect(memberOnly(bad.reasons)[0]).toContain('"dev"');
    expect(memberOnly(bad.reasons)[0]).toContain("reg.example.com/acme/missing");

    const good = await gate(
      { "marketplace.lock": lockRow("skill", `pinned = "reg.example.com/acme/tool${DIGEST}"`) },
      ["marketplace.lock"],
    );
    expect(good.reasons).toEqual([REVIEW("marketplace.lock")]);
  });

  it("refuses a path-sourced lock row", async () => {
    const result = await gate(
      { "marketplace.lock": lockRow("skill", `path = "./skills/local"\nhash = "sha256:0"`) },
      ["marketplace.lock"],
    );
    expect(result.eligible).toBe(false);
    expect(memberOnly(result.reasons)[0]).toContain('"dev"');
    expect(memberOnly(result.reasons)[0]).toContain("./skills/local");
  });

  it("accepts a bundle row whose bundle is indexed, whatever its members pin", async () => {
    const result = await gate(
      {
        "marketplace.lock": lockRow(
          "skill",
          `pinned = "reg.example.com/acme/elsewhere${DIGEST}"\nbundle = "reg.example.com/acme/bundles/stack"\nbundle_tag = "1"`,
        ),
      },
      ["marketplace.lock"],
    );
    expect(result.reasons).toEqual([REVIEW("marketplace.lock")]);
  });

  it("refuses a bundle row whose bundle is not indexed", async () => {
    const result = await gate(
      {
        "marketplace.lock": lockRow(
          "skill",
          `pinned = "reg.example.com/acme/tool${DIGEST}"\nbundle = "reg.example.com/acme/bundles/ghost"`,
        ),
      },
      ["marketplace.lock"],
    );
    expect(memberOnly(result.reasons)).toHaveLength(1);
    expect(memberOnly(result.reasons)[0]).toContain("reg.example.com/acme/bundles/ghost");
    expect(memberOnly(result.reasons)[0]).toContain("not a package in this index");
  });

  // grim writes `[[<kind>.bundles]]` tables with `repo` and `tag`, never strings.
  const bundleTable = (repo: string) => `\n\n[[rule.bundles]]\nrepo = "${repo}"\ntag = "1"`;

  it("refuses an unindexed entry in a bundles table list, and a malformed one", async () => {
    const result = await gate(
      {
        "marketplace.lock": lockRow(
          "rule",
          `pinned = "reg.example.com/acme/tool${DIGEST}"${bundleTable("reg.example.com/acme/bundles/stack")}${bundleTable("reg.example.com/acme/bundles/ghost")}\n\n[[rule.bundles]]\ntag = "1"`,
        ),
      },
      ["marketplace.lock"],
    );
    const reasons = memberOnly(result.reasons);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("bundles/ghost");
    expect(reasons[1]).toContain("bundle");
  });

  it("accepts a bundles table list whose repos are all indexed", async () => {
    const result = await gate(
      {
        "marketplace.lock": lockRow(
          "rule",
          `pinned = "reg.example.com/acme/tool${DIGEST}"${bundleTable("reg.example.com/acme/bundles/stack")}`,
        ),
      },
      ["marketplace.lock"],
    );
    expect(memberOnly(result.reasons)).toEqual([]);
  });

  it("still reads a bundles list of bare strings", async () => {
    const result = await gate(
      {
        "marketplace.lock": lockRow(
          "rule",
          `pinned = "reg.example.com/acme/tool${DIGEST}"\nbundles = ["reg.example.com/acme/bundles/ghost"]`,
        ),
      },
      ["marketplace.lock"],
    );
    expect(memberOnly(result.reasons)[0]).toContain("bundles/ghost");
  });

  it("does not count a metadata.json outside the index path grammar as indexed", async () => {
    const result = await gate(
      {
        "index/stray/metadata.json": metadata({ name: "x", ref: "reg.example.com/acme/stray" }),
        "index/github.com/acme/deep/er/than/metadata.json": metadata({
          name: "than",
          ref: "reg.example.com/acme/deeper",
        }),
        "marketplace.toml": toml(["reg.example.com/acme/stray", "reg.example.com/acme/deeper"]),
      },
      ["marketplace.toml"],
    );
    expect(memberOnly(result.reasons)).toHaveLength(2);
  });

  it("reads the index from the tree after the change", async () => {
    const result = await gate(
      {
        ...pkg("fresh", "reg.example.com/acme/fresh"),
        "marketplace.toml": toml(["reg.example.com/acme/fresh"]),
      },
      ["marketplace.toml"],
    );
    expect(result.reasons).toEqual([REVIEW("marketplace.toml")]);
  });

  it("fails closed on a manifest that is not TOML", async () => {
    const result = await gate({ "marketplace.toml": "[[[" }, ["marketplace.toml"]);
    expect(result.eligible).toBe(false);
    expect(memberOnly(result.reasons)[0]).toContain("invalid TOML");
  });

  it("skips the rule when neither marketplace file changed", async () => {
    // The rule would refuse this manifest if it ran.
    const result = await gate(
      { "marketplace.toml": toml(["reg.example.com/acme/missing"]) },
      ["index/github.com/acme/tool/metadata.json"],
    );
    expect(result).toEqual({ eligible: true, reasons: [] });
  });
});

describe("marketplace gate: malformed input", () => {
  it("gives a reason per member shape it cannot read, never a silent skip", async () => {
    const manifest = [
      "[plugins.a]",
      "include = [7, \"reg.example.com/acme/tool\"]",
      "[plugins.b]",
      "project = 3",
      "[plugins.c]",
      "include = \"reg.example.com/acme/tool\"",
      "[plugins.d]",
      "surprise = \"x\"",
      "[plugins]",
      "e = 1",
      "",
    ].join("\n");
    const result = await gate({ "marketplace.toml": manifest }, ["marketplace.toml"]);
    const reasons = memberOnly(result.reasons);
    expect(reasons.some((r) => r.includes('"a"') && r.includes("include"))).toBe(true);
    expect(reasons.some((r) => r.includes('"b"') && r.includes("project"))).toBe(true);
    expect(reasons.some((r) => r.includes('"c"') && r.includes("include"))).toBe(true);
    expect(reasons.some((r) => r.includes('"d"') && r.includes("surprise"))).toBe(true);
    expect(reasons.some((r) => r.includes('"e"'))).toBe(true);
    expect(reasons).toHaveLength(5);
  });

  it("accepts every metadata key grim's manifest declares", async () => {
    const result = await gate(
      {
        "marketplace.toml": toml(
          ["reg.example.com/acme/tool"],
          'description = "d"\nversion = "1.0.0"\nlicense = "MIT"\nkeywords = ["a"]\ncategory = "c"\n',
        ),
      },
      ["marketplace.toml"],
    );
    expect(memberOnly(result.reasons)).toEqual([]);
  });

  it("gives a reason for lock rows it cannot read", async () => {
    const lock = [
      "mcp = 3",
      "[[skill]]",
      'plugin = "p1"',
      "pinned = 5",
      "[[rule]]",
      'plugin = "p2"',
      'name = "no source at all"',
      "[[agent]]",
      'plugin = "p3"',
      "path = 9",
      "",
    ].join("\n");
    const result = await gate({ "marketplace.lock": lock }, ["marketplace.lock"]);
    const reasons = memberOnly(result.reasons);
    expect(reasons.some((r) => r.includes('"p1"') && r.includes("pinned"))).toBe(true);
    expect(reasons.some((r) => r.includes('"p2"'))).toBe(true);
    expect(reasons.some((r) => r.includes('"p3"') && r.includes("path"))).toBe(true);
    expect(reasons.some((r) => r.includes("mcp"))).toBe(true);
  });

  it("reports a TOML syntax error by line and column, never its source text", async () => {
    for (const file of ["marketplace.toml", "marketplace.lock"]) {
      const result = await gate(
        { [file]: 'secret = "TOPSECRETVALUE"\nnext = TOPSECRETVALUE\n' },
        [file],
      );
      const reason = memberOnly(result.reasons)[0] ?? "";
      expect(reason, file).toContain("invalid TOML");
      expect(reason, file).toMatch(/line \d+, column \d+/);
      expect(reason, file).not.toContain("TOPSECRETVALUE");
    }
  });

  it("escapes hostile plugin names rather than echoing them raw", async () => {
    const result = await gate(
      { "marketplace.toml": '[plugins."a\\nb`rm -rf`"]\ninclude = ["./x"]\n' },
      ["marketplace.toml"],
    );
    const reason = memberOnly(result.reasons)[0] ?? "";
    expect(reason).not.toContain("\n");
    expect(reason).toContain("\\n");
  });
});

describe("marketplace gate: change shapes", () => {
  it("stays ineligible when the change also carries a valid index entry", async () => {
    const result = await gate(
      { "marketplace.toml": toml(["reg.example.com/acme/tool"]) },
      ["marketplace.toml", "index/github.com/acme/tool/metadata.json"],
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(REVIEW("marketplace.toml"));
  });

  it("reviews a deleted marketplace.toml", async () => {
    const result = await gate({}, ["marketplace.toml"]);
    expect(result).toEqual({ eligible: false, reasons: [REVIEW("marketplace.toml")] });
  });

  it("reports an oversize marketplace file instead of reading it", async () => {
    const result = await gate(
      { "marketplace.toml": "#" + "x".repeat(1024 * 1024 + 1) },
      ["marketplace.toml"],
    );
    expect(memberOnly(result.reasons)).toEqual([expect.stringContaining("larger than")]);
  });

  it("refuses a symlinked marketplace file", async () => {
    const result = await gate({ "marketplace.lock": null }, ["marketplace.lock"]);
    expect(memberOnly(result.reasons)).toEqual([expect.stringContaining("symlink")]);
  });
});
