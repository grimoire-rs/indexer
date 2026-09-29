// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The pure half of the `/marketplace/` landing page (C-030 / S-027): how the
// configured URL is shown, and which command each client row carries. The
// page itself is checked against a real build in `build.test.ts`.
import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_VERIFIED,
  marketplaceRows,
  marketplaceSource,
} from "../../src/renderer/astro/lib/marketplace.js";

describe("marketplaceSource", () => {
  it.each([
    ["a github.com repo", "https://github.com/acme/marketplace", "acme/marketplace"],
    ["a github.com repo with a trailing slash", "https://github.com/acme/marketplace/", "acme/marketplace"],
    // Not two segments, so `owner/repo` would name something else.
    ["a github.com url with one segment", "https://github.com/acme", "https://github.com/acme"],
    ["a github.com url with three segments", "https://github.com/acme/mk/tree/main", "https://github.com/acme/mk/tree/main"],
    // `owner/repo.git` is not the GitHub shorthand: a client would look up a repo named `mk.git`.
    ["a github.com repo ending .git", "https://github.com/acme/mk.git", "https://github.com/acme/mk.git"],
    // Exactly `github.com`: a lookalike host must not be flattened into a
    // shorthand that the client would resolve against the real one.
    ["a lookalike host", "https://github.com.evil.test/acme/mk", "https://github.com.evil.test/acme/mk"],
    ["a github.com subdomain", "https://gist.github.com/acme/mk", "https://gist.github.com/acme/mk"],
    ["github.com on another port", "https://github.com:8443/acme/mk", "https://github.com:8443/acme/mk"],
    ["a GitLab url", "https://gitlab.com/group/marketplace", "https://gitlab.com/group/marketplace"],
    ["a GitLab url with a trailing slash", "https://gitlab.com/group/mk/", "https://gitlab.com/group/mk"],
    ["a nested GitLab group", "https://gitlab.example.com/a/b/c.git", "https://gitlab.example.com/a/b/c.git"],
    ["an empty middle segment", "https://github.com//acme", "https://github.com//acme"],
  ])("shows %s as expected", (_label, url, shown) => {
    expect(marketplaceSource(url)).toBe(shown);
  });

  it("returns text a template can escape, never markup of its own", () => {
    // The function does not escape: the template interpolates it as text, and
    // Astro escapes at the sink. What matters here is that the hostile value
    // comes back verbatim — no partial sanitising that would hide it.
    const hostile = "https://gitlab.com/<script>alert(1)</script>";
    expect(marketplaceSource(hostile)).toBe(hostile);
  });

  it("falls back to the raw value for a string that is not a URL", () => {
    expect(marketplaceSource("not a url")).toBe("not a url");
  });
});

describe("marketplaceRows", () => {
  const market = { url: "https://github.com/acme/mk", name: "acme-plugins" };
  const all = ["claude", "copilot", "codex", "qoder", "cursor"] as const;

  it("emits one row per listed client, in the listed order", () => {
    const rows = marketplaceRows({ ...market, clients: ["codex", "claude"] });
    expect(rows.map((r) => r.client)).toEqual(["codex", "claude"]);
  });

  it("carries each client's exact add command and install form", () => {
    const by = Object.fromEntries(
      marketplaceRows({ ...market, clients: [...all] }).map((r) => [r.client, r]),
    );
    expect(by.claude).toMatchObject({
      add: "/plugin marketplace add acme/mk",
      install: "/plugin install <plugin>@acme-plugins",
    });
    expect(by.copilot).toMatchObject({
      add: "copilot plugin marketplace add acme/mk",
      install: "copilot plugin install <plugin>@acme-plugins",
    });
    expect(by.codex).toMatchObject({
      add: "codex plugin marketplace add acme/mk",
      install: "codex plugin add <plugin>@acme-plugins",
    });
    expect(by.qoder).toMatchObject({
      add: "qoder plugins marketplace add acme/mk",
      install: "qoder plugins install <plugin>@acme-plugins",
    });
  });

  it("keeps a .git remote whole in the Claude add command", () => {
    const [claude] = marketplaceRows({
      url: "https://github.com/acme/mk.git",
      name: "mk",
      clients: ["claude"],
    });
    expect(claude?.add).toBe("/plugin marketplace add https://github.com/acme/mk.git");
  });

  it("uses the full URL in the add command when the host is not github.com", () => {
    const rows = marketplaceRows({
      url: "https://gitlab.example.com/g/mk.git",
      name: "mk",
      clients: ["claude"],
    });
    expect(rows[0]?.add).toBe("/plugin marketplace add https://gitlab.example.com/g/mk.git");
  });

  it("gives Cursor the dashboard import, not a shell command", () => {
    const [cursor] = marketplaceRows({ ...market, clients: ["cursor"] });
    expect(cursor?.client).toBe("cursor");
    expect(cursor?.add).toBeNull();
    expect(cursor?.steps).toContain("Team Marketplaces");
    expect(cursor?.steps).toContain("Import from Repo");
    expect(cursor?.source).toBe("acme/mk");
  });

  it("date-stamps every row with the verification date", () => {
    expect(MARKETPLACE_VERIFIED).toBe("2026-09-29");
    for (const row of marketplaceRows({ ...market, clients: [...all] })) {
      expect(row.verified).toBe("verified 2026-09-29");
    }
  });

  it("emits no cursor row unless cursor is listed", () => {
    const rows = marketplaceRows({ ...market, clients: ["claude", "copilot", "codex", "qoder"] });
    expect(rows.map((r) => r.client)).not.toContain("cursor");
  });
});
