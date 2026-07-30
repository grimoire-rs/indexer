// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { afterEach, describe, expect, it, vi } from "vitest";

import { runValidate, type ValidateOptions } from "../../src/validate/index.js";
import { makeTree, metadata, stubFetch, type Call, type Route } from "./helpers.js";

const API = "https://api.test";
const FILE = "index/github.com/acme/tool/metadata.json";
const GL_FILE = "index/gitlab.example.com/platform/ai/tool/metadata.json";

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (value: unknown): Route => ({ body: JSON.stringify(value) });
const TAGS: Route = { body: '{"tags":["1.0.0"]}' };

/** GitHub: `acme` is a user account with id 7; the ref is published. */
function githubRoutes(over: Record<string, Route> = {}) {
  return (url: string): Route | null => {
    if (url in over) return over[url] ?? null;
    if (url === `${API}/users/acme`) return json({ id: 7, login: "acme", type: "User" });
    if (url.endsWith("/tags/list")) return TAGS;
    return null;
  };
}

interface Scenario {
  prFiles?: Record<string, string | null>;
  baseFiles?: Record<string, string | null>;
  routes?: (url: string) => Route | null;
  options?: Partial<ValidateOptions>;
}

async function run(scenario: Scenario = {}) {
  const calls = stubFetch(scenario.routes ?? githubRoutes());
  const prTree = await makeTree(scenario.prFiles ?? { [FILE]: metadata() });
  const root = await makeTree(scenario.baseFiles ?? {});
  const result = await runValidate({
    forge: "github",
    root,
    prTree,
    changedFiles: [FILE],
    author: { login: "acme", id: "7" },
    apiBase: API,
    ...scenario.options,
  });
  return { result, calls, prTree, root };
}

const said = (reasons: string[]) => reasons.join(" | ");
const registryCalls = (calls: Call[]) =>
  calls.filter((call) => call.url.includes("reg.example.com"));

describe("runValidate — eligible", () => {
  it("waves through a new package whose owner owns the namespace", async () => {
    const { result } = await run();
    expect(result).toEqual({ eligible: true, reasons: [] });
  });

  // A deletion is a path that IS in the committed tree and is NOT in the
  // contribution. The base tree has to hold it, or this is not modelling a
  // deletion at all — see the refusal test below, which is what that gap
  // used to be waved through as.
  it("waves through a deletion by the namespace owner", async () => {
    const { result } = await run({
      prFiles: { "index/.keep": "" },
      baseFiles: { [FILE]: metadata() },
    });
    expect(result).toEqual({ eligible: true, reasons: [] });
  });

  it("waves through an update that keeps the committed owner id", async () => {
    const { result } = await run({ baseFiles: { [FILE]: metadata() } });
    expect(result.eligible).toBe(true);
  });

  it("accepts an org namespace on public membership", async () => {
    const { result } = await run({
      routes: githubRoutes({
        [`${API}/users/acme`]: json({ id: 7, login: "acme", type: "Organization" }),
        [`${API}/orgs/acme/public_members/dev`]: { status: 204 },
      }),
      options: { author: { login: "dev", id: "5" } },
    });
    expect(said(result.reasons)).toBe("");
  });

  it("accepts a trusted bot pinned by account id", async () => {
    const { result } = await run({
      options: {
        author: { login: "announce[bot]", id: "77" },
        trustedBots: [{ login: "announce[bot]", id: "77", namespaces: ["acme"] }],
      },
    });
    expect(result.eligible).toBe(true);
  });
});

describe("runValidate — namespace ownership", () => {
  it("refuses a namespace the author does not own", async () => {
    const { result } = await run({ options: { author: { login: "dev", id: "5" } } });
    expect(result.eligible).toBe(false);
    expect(said(result.reasons)).toContain("not owned by");
  });

  it("refuses an id mismatch even when the login matches", async () => {
    // `acme` was renamed away and re-registered: same login, different account.
    const { result } = await run({ options: { author: { login: "acme", id: "999" } } });
    expect(result.eligible).toBe(false);
    expect(said(result.reasons)).toContain("not owned by");
  });

  it("refuses an impostor on a trusted bot's login", async () => {
    const { result } = await run({
      options: {
        author: { login: "announce[bot]", id: "78" },
        trustedBots: [{ login: "announce[bot]", id: "77", namespaces: ["acme"] }],
      },
    });
    expect(result.eligible).toBe(false);
  });

  it("refuses a reserved namespace without asking the forge", async () => {
    const { result, calls } = await run({ options: { reservedNamespaces: ["ACME"] } });
    expect(said(result.reasons)).toContain("is reserved");
    expect(calls).toEqual([]);
  });

  it("refuses a namespace the forge does not know", async () => {
    const { result } = await run({ routes: () => ({ status: 404 }) });
    expect(said(result.reasons)).toContain("does not exist");
  });

  it("refuses a private org membership it cannot see", async () => {
    const { result } = await run({
      routes: githubRoutes({
        [`${API}/users/acme`]: json({ id: 7, login: "acme", type: "Organization" }),
      }),
      options: { author: { login: "dev", id: "5" } },
    });
    expect(result.eligible).toBe(false);
  });
});

describe("runValidate — hostile paths", () => {
  const outOfBounds = [
    ".github/workflows/validate.yml",
    "index/../../etc/passwd",
    "/etc/passwd",
    "index/github.com/acme/../../../etc/metadata.json",
    "index/github.com/acme/tool/../../../../../../etc/passwd/metadata.json",
    "index/gitlab.example.com/acme/tool/metadata.json",
  ];

  for (const file of outOfBounds) {
    it(`refuses ${file} without touching the network`, async () => {
      const { result, calls } = await run({ options: { changedFiles: [file] } });
      expect(result.eligible).toBe(false);
      expect(said(result.reasons)).toContain("outside index/github.com");
      expect(calls).toEqual([]);
    });
  }

  it("refuses a change set that mixes a valid path with an out-of-bounds one", async () => {
    const { result, calls } = await run({
      options: { changedFiles: [FILE, "scripts/build.py"] },
    });
    expect(result.eligible).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses an empty change set", async () => {
    const { result } = await run({ options: { changedFiles: [] } });
    expect(result.reasons).toEqual(["empty change set"]);
  });

  it("refuses a symlinked metadata.json instead of following it", async () => {
    const { result } = await run({ prFiles: { [FILE]: null } });
    expect(result.eligible).toBe(false);
    expect(said(result.reasons)).toContain("symlinks are not accepted");
  });

  it("does not crash when the PR tree is missing", async () => {
    const { result } = await run({ options: { prTree: "/nonexistent/pr-tree" } });
    expect(result.eligible).toBe(false);
    expect(said(result.reasons)).toContain("cannot resolve index root");
  });

  // A path in NEITHER tree used to be read as "a deletion by the namespace
  // owner" and waved through — so a changed-path entry that named an
  // in-bounds file nobody ever wrote authorized a merge with the entry's
  // `ref`, `owner.id` and registry host never once read. That is reachable
  // from a shell-mangled path (`xargs` stripping quotes out of a crafted
  // filename) or simply from a fabricated changed-path list.
  it("refuses an in-bounds path that exists in neither tree", async () => {
    const { result } = await run({ prFiles: { "index/.keep": "" }, baseFiles: {} });
    expect(result.eligible).toBe(false);
    expect(said(result.reasons)).toContain("present in neither the contribution nor this repository");
  });

  // The deletion check must key on proof that something IS committed, not on
  // the absence of a "missing". Written `=== "missing"` it fell through to
  // "authorized deletion" whenever the base read FAILED rather than came back
  // empty — turning a fault into a pass, which is the inversion the whole
  // check exists to prevent.
  it("refuses a deletion it cannot confirm against the committed tree", async () => {
    const { result } = await run({
      prFiles: { "index/.keep": "" },
      options: { root: "/nonexistent/base" },
    });
    expect(result.eligible).toBe(false);
  });

  // The same fault on an UPDATE. An unreadable committed entry used to look
  // like "no committed entry", i.e. a new package — which skips the
  // owner-id continuity check, the one thing stopping a re-registered login
  // from inheriting the previous holder's packages.
  it("refuses an update it cannot read the committed entry for", async () => {
    const { result } = await run({ options: { root: "/nonexistent/base" } });
    expect(result.eligible).toBe(false);
    expect(said(result.reasons)).toContain("committed");
  });
});

describe("runValidate — hostile content", () => {
  it("refuses malformed JSON", async () => {
    const { result } = await run({ prFiles: { [FILE]: "{not json" } });
    expect(said(result.reasons)).toContain("invalid JSON");
  });

  it("refuses an oversized document", async () => {
    const { result } = await run({
      prFiles: { [FILE]: JSON.stringify({ pad: "a".repeat(80_000) }) },
    });
    expect(said(result.reasons)).toContain("larger than");
  });

  it("refuses __proto__ and leaves Object.prototype alone", async () => {
    // Written as text: an object literal's `__proto__:` sets the prototype
    // rather than a key, so it would never reach the file.
    const polluted = metadata().replace(/^\{/, '{"__proto__":{"polluted":true},');
    const { result } = await run({ prFiles: { [FILE]: polluted } });
    expect(said(result.reasons)).toContain("forbidden key");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses an owner login that disagrees with the namespace", async () => {
    const { result } = await run({
      prFiles: { [FILE]: metadata({ owner: { github: "mallory", id: 7 } }) },
    });
    expect(said(result.reasons)).toContain("!= namespace");
  });

  it("refuses an owner id that disagrees with the forge", async () => {
    const { result } = await run({
      prFiles: { [FILE]: metadata({ owner: { github: "acme", id: 8 } }) },
    });
    expect(said(result.reasons)).toContain("owner.id");
  });

  it("refuses an owner id that disagrees with the committed entry", async () => {
    // The login was freed and re-registered: the forge agrees with the new
    // account, the committed entry does not.
    const { result } = await run({
      prFiles: { [FILE]: metadata({ owner: { github: "acme", id: 9 } }) },
      baseFiles: { [FILE]: metadata({ owner: { github: "acme", id: 7 } }) },
      routes: githubRoutes({
        [`${API}/users/acme`]: json({ id: 9, login: "acme", type: "User" }),
      }),
      options: { author: { login: "acme", id: "9" } },
    });
    expect(said(result.reasons)).toContain("committed owner.id");
  });

  it("refuses a package name that disagrees with its directory", async () => {
    const { result } = await run({ prFiles: { [FILE]: metadata({ name: "other" }) } });
    expect(said(result.reasons)).toContain("directory");
  });
});

describe("runValidate — registry truth", () => {
  it("refuses a ref with no published tags", async () => {
    const { result } = await run({
      routes: githubRoutes({
        "https://reg.example.com/v2/acme/tool/tags/list": { body: '{"tags":[]}' },
      }),
    });
    expect(said(result.reasons)).toContain("no reachable tags");
  });

  it("refuses a registry host outside the allowlist before calling it", async () => {
    const { result, calls } = await run({ options: { registryHosts: ["ghcr.io"] } });
    expect(said(result.reasons)).toContain("allowlist");
    expect(registryCalls(calls)).toEqual([]);
  });

  it("refuses a ref aimed at the runner's own network", async () => {
    const { result, calls } = await run({
      prFiles: { [FILE]: metadata({ ref: "169.254.169.254/acme/tool" }) },
    });
    expect(said(result.reasons)).toContain("public DNS name");
    expect(calls.filter((call) => call.url.includes("169.254"))).toEqual([]);
  });

  it("refuses a syntactically invalid ref", async () => {
    const { result } = await run({ prFiles: { [FILE]: metadata({ ref: "no-slash" }) } });
    expect(said(result.reasons)).toContain("no repository part");
  });
});

describe("runValidate — gitlab", () => {
  const gitlabRoutes = (over: Record<string, Route> = {}) => (url: string): Route | null => {
    if (url in over) return over[url] ?? null;
    if (url === `${API}/namespaces/platform%2Fai`) {
      return json({ kind: "group", id: 44, full_path: "platform/ai" });
    }
    if (url === `${API}/groups/platform%2Fai/members/all/5`) return json({ access_level: 40 });
    if (url.endsWith("/tags/list")) return TAGS;
    return null;
  };

  const gitlabMeta = (over: Record<string, unknown> = {}) =>
    metadata({
      ref: "reg.example.com/platform/ai/tool",
      owner: { login: "platform/ai", id: 44 },
      ...over,
    });

  async function runGitlab(scenario: Scenario = {}) {
    stubFetch(scenario.routes ?? gitlabRoutes());
    const prTree = await makeTree(scenario.prFiles ?? { [GL_FILE]: gitlabMeta() });
    const root = await makeTree(scenario.baseFiles ?? {});
    return runValidate({
      forge: "gitlab",
      root,
      prTree,
      changedFiles: [GL_FILE],
      author: { login: "dev", id: "5" },
      apiBase: API,
      host: "gitlab.example.com",
      ...scenario.options,
    });
  }

  it("waves through a nested group namespace with sufficient access", async () => {
    expect(await runGitlab()).toEqual({ eligible: true, reasons: [] });
  });

  it("refuses a member below the access threshold", async () => {
    const result = await runGitlab({
      routes: gitlabRoutes({
        [`${API}/groups/platform%2Fai/members/all/5`]: json({ access_level: 20 }),
      }),
    });
    expect(said(result.reasons)).toContain("not owned by");
  });

  it("refuses a non-member", async () => {
    const result = await runGitlab({
      routes: gitlabRoutes({
        [`${API}/groups/platform%2Fai/members/all/5`]: { status: 404 },
      }),
    });
    expect(result.eligible).toBe(false);
  });

  it("refuses a user namespace claimed by someone else", async () => {
    const result = await runGitlab({
      prFiles: {
        "index/gitlab.example.com/acme/tool/metadata.json": metadata({
          owner: { login: "acme", id: 5 },
        }),
      },
      routes: (url) => {
        if (url === `${API}/namespaces/acme`) return { status: 404 };
        if (url.startsWith(`${API}/users?username=`)) return json([{ id: 9, username: "acme" }]);
        if (url.endsWith("/tags/list")) return TAGS;
        return null;
      },
      options: { changedFiles: ["index/gitlab.example.com/acme/tool/metadata.json"] },
    });
    expect(said(result.reasons)).toContain("not owned by");
  });
});
