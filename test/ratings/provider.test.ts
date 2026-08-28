// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-011 — the provider seam: one interface, two forges, one fake.
//
// The load-bearing case here is the 200 that carries a populated top-level
// `errors` array. `request()` maps its transport catch and its size cap to
// `{status: 0}`, so a 200 with errors and a null `data` passes both checks and
// reads as "genuinely fewer votes observed" — silent emptying arriving through
// the one door R-2 does not watch. Both providers must reject it.
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMarker } from "../../src/ratings/marker.js";
import {
  createRatingProvider,
  ForgeError,
  PAGE_SIZE,
  RateLimited,
  type RatingProvider,
  type RatingProviderConfig,
} from "../../src/ratings/provider.js";
import { memoryProvider } from "../../src/ratings/provider_memory.js";
import { stubFetch, type Call, type Route } from "../validate/helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Route the stub on the GraphQL body rather than the URL — one endpoint serves every query. */
function onQuery(reply: (body: string) => Route | null): Call[] {
  const calls: Call[] = stubFetch(() => reply(calls.at(-1)?.body ?? ""));
  return calls;
}

function json(value: unknown): Route {
  return { body: JSON.stringify(value) };
}

const GITHUB: RatingProviderConfig = {
  api: "https://api.github.com/graphql",
  token: "s3cret",
  project: "acme/index",
  container: "Ratings",
  lockThreads: true,
  trustedBots: [{ login: "github-actions[bot]", id: "99" }],
};

const GITLAB: RatingProviderConfig = {
  api: "https://gitlab.com/api/graphql",
  token: "s3cret",
  project: "acme/index",
  container: "Issue",
  lockThreads: true,
  trustedBots: [{ login: "project_bot", id: "42" }],
};

const GH_REPO = {
  id: "R_1",
  discussionCategories: { nodes: [{ id: "DIC_1", name: "Ratings" }] },
};

function ghDiscussion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "D_1",
    url: "https://github.com/acme/index/discussions/1",
    upvoteCount: 5,
    body: buildMarker("ghcr.io/acme/one"),
    category: { id: "DIC_1" },
    repository: { id: "R_1" },
    author: { databaseId: 99 },
    ...overrides,
  };
}

function ghPage(nodes: unknown[], hasNextPage = false): Route {
  return json({
    data: {
      repository: {
        discussions: { pageInfo: { hasNextPage, endCursor: "cursor" }, nodes },
      },
    },
  });
}

const GL_PROJECT = {
  id: "gid://gitlab/Project/7",
  workItemTypes: { nodes: [{ id: "gid://gitlab/WorkItems::Type/1", name: "Issue" }] },
};

function glWorkItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gid://gitlab/WorkItem/10",
    webUrl: "https://gitlab.com/acme/index/-/work_items/10",
    author: { id: "gid://gitlab/User/42" },
    workItemType: { id: "gid://gitlab/WorkItems::Type/1" },
    widgets: [
      { description: buildMarker("ghcr.io/acme/one") },
      { upvotes: 3, downvotes: 0 },
    ],
    ...overrides,
  };
}

function glPage(nodes: unknown[], hasNextPage = false): Route {
  return json({
    data: {
      project: { workItems: { pageInfo: { hasNextPage, endCursor: "cursor" }, nodes } },
    },
  });
}

describe("the in-memory fake", () => {
  it("satisfies the interface", async () => {
    const provider: RatingProvider = memoryProvider();
    expect(await provider.listAuthored()).toEqual([]);

    const thread = await provider.create("ghcr.io/acme/one");
    expect(thread.ref).toBe("ghcr.io/acme/one");
    expect(thread.up).toBe(0);
    expect(await provider.listAuthored()).toEqual([thread]);
  });

  it("keeps created threads across runs, so a rerun observes them", async () => {
    const provider = memoryProvider();
    await provider.create("ghcr.io/acme/one");
    await provider.create("ghcr.io/acme/two");
    expect((await provider.listAuthored()).map((t) => t.ref)).toEqual([
      "ghcr.io/acme/one",
      "ghcr.io/acme/two",
    ]);
  });

  it("throws RateLimited carrying the pages it did read", async () => {
    const provider = memoryProvider({
      threads: [
        { ref: "a", target: "t1", url: "u1", up: 1 },
        { ref: "b", target: "t2", url: "u2", up: 2 },
      ],
      listLimit: 1,
    });
    await expect(provider.listAuthored()).rejects.toBeInstanceOf(RateLimited);
    const err = await provider.listAuthored().catch((e: unknown) => e as RateLimited);
    expect(err.observed.map((t) => t.ref)).toEqual(["a"]);
  });
});

describe("createRatingProvider", () => {
  it("dispatches on the kind", () => {
    expect(createRatingProvider("github", GITHUB)).toBeDefined();
    expect(createRatingProvider("gitlab", GITLAB)).toBeDefined();
  });
});

describe("a 200 carrying GraphQL errors is a hard error, never an empty tally", () => {
  it("github", async () => {
    onQuery((body) =>
      body.includes("discussionCategories")
        ? json({ data: { repository: GH_REPO } })
        : json({
            data: { repository: null },
            errors: [{ message: "Could not resolve to a Repository", type: "NOT_FOUND" }],
          }),
    );
    const provider = createRatingProvider("github", GITHUB);
    await expect(provider.listAuthored()).rejects.toThrow(/Could not resolve to a Repository/);
  });

  it("gitlab", async () => {
    onQuery((body) =>
      body.includes("workItemTypes")
        ? json({ data: { project: GL_PROJECT } })
        : json({ data: null, errors: [{ message: "insufficient permissions" }] }),
    );
    const provider = createRatingProvider("gitlab", GITLAB);
    await expect(provider.listAuthored()).rejects.toThrow(/insufficient permissions/);
  });

  it("is checked before `data`, so `data: null` never reads as zero threads", async () => {
    onQuery(() => json({ data: null, errors: [{ message: "boom" }] }));
    await expect(createRatingProvider("github", GITHUB).listAuthored()).rejects.toBeInstanceOf(
      ForgeError,
    );
  });

  it("an empty errors array is not an error", async () => {
    onQuery((body) =>
      body.includes("discussionCategories")
        ? json({ data: { repository: GH_REPO }, errors: [] })
        : ghPage([ghDiscussion()]),
    );
    expect(await createRatingProvider("github", GITHUB).listAuthored()).toHaveLength(1);
  });
});

describe("transport and status failures never read as an empty tally", () => {
  it("a `{status: 0}` reply throws", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNRESET")));
    await expect(createRatingProvider("github", GITHUB).listAuthored()).rejects.toBeInstanceOf(
      ForgeError,
    );
  });

  it("a 500 throws", async () => {
    onQuery(() => ({ status: 500, body: "nope" }));
    await expect(createRatingProvider("gitlab", GITLAB).listAuthored()).rejects.toBeInstanceOf(
      ForgeError,
    );
  });

  it("a 2xx that does not parse throws", async () => {
    onQuery(() => ({ status: 200, body: "<html>" }));
    await expect(createRatingProvider("github", GITHUB).listAuthored()).rejects.toBeInstanceOf(
      ForgeError,
    );
  });
});

describe("secondary rate limits", () => {
  it("a 429 during listing throws RateLimited with what was read", async () => {
    let page = 0;
    onQuery((body) => {
      if (body.includes("discussionCategories")) return json({ data: { repository: GH_REPO } });
      page += 1;
      if (page === 1) return ghPage([ghDiscussion()], true);
      return { status: 429, body: "", headers: { "retry-after": "120" } };
    });
    const err = await createRatingProvider("github", GITHUB)
      .listAuthored()
      .catch((e: unknown) => e as RateLimited);
    expect(err).toBeInstanceOf(RateLimited);
    expect(err.observed.map((t) => t.ref)).toEqual(["ghcr.io/acme/one"]);
    expect(err.retryAfterMs).toBe(120_000);
  });

  it("a 403 naming the secondary limit is a rate limit, not a forge error", async () => {
    onQuery((body) =>
      body.includes("discussionCategories")
        ? json({ data: { repository: GH_REPO } })
        : {
            status: 403,
            body: JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
          },
    );
    await expect(createRatingProvider("github", GITHUB).listAuthored()).rejects.toBeInstanceOf(
      RateLimited,
    );
  });

  it("a 403 that is not a rate limit stays a forge error", async () => {
    onQuery((body) =>
      body.includes("discussionCategories")
        ? json({ data: { repository: GH_REPO } })
        : { status: 403, body: JSON.stringify({ message: "Resource not accessible" }) },
    );
    const err = await createRatingProvider("github", GITHUB)
      .listAuthored()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect(err).not.toBeInstanceOf(RateLimited);
  });

  it("a GraphQL RATE_LIMITED error on a 200 is a rate limit", async () => {
    onQuery((body) =>
      body.includes("workItemTypes")
        ? json({ data: { project: GL_PROJECT } })
        : json({ data: null, errors: [{ message: "throttled", extensions: { code: "RATE_LIMITED" } }] }),
    );
    await expect(createRatingProvider("gitlab", GITLAB).listAuthored()).rejects.toBeInstanceOf(
      RateLimited,
    );
  });

  it("falls back to x-ratelimit-reset, then to the documented floor", async () => {
    const reset = Math.floor(Date.now() / 1000) + 90;
    onQuery((body) =>
      body.includes("discussionCategories")
        ? json({ data: { repository: GH_REPO } })
        : { status: 429, body: "", headers: { "x-ratelimit-reset": String(reset) } },
    );
    const withReset = await createRatingProvider("github", GITHUB)
      .listAuthored()
      .catch((e: unknown) => e as RateLimited);
    expect(withReset.retryAfterMs).toBeGreaterThan(60_000);

    onQuery((body) =>
      body.includes("discussionCategories")
        ? json({ data: { repository: GH_REPO } })
        : { status: 429, body: "" },
    );
    const bare = await createRatingProvider("github", GITHUB)
      .listAuthored()
      .catch((e: unknown) => e as RateLimited);
    expect(bare.retryAfterMs).toBe(60_000);
  });
});

describe("R-1 is applied inside listAuthored, never by the caller", () => {
  it("github drops a stranger's thread and keeps the bot's", async () => {
    onQuery((body) =>
      body.includes("discussionCategories")
        ? json({ data: { repository: GH_REPO } })
        : ghPage([
            ghDiscussion({ id: "D_x", author: { databaseId: 1234 } }),
            ghDiscussion(),
            ghDiscussion({ id: "D_y", body: "no marker here" }),
            ghDiscussion({ id: "D_z", category: { id: "DIC_other" } }),
          ]),
    );
    const threads = await createRatingProvider("github", GITHUB).listAuthored();
    expect(threads).toEqual([
      {
        ref: "ghcr.io/acme/one",
        target: "D_1",
        url: "https://github.com/acme/index/discussions/1",
        up: 5,
      },
    ]);
  });

  it("gitlab compares the numeric account id, not the gid", async () => {
    onQuery((body) =>
      body.includes("workItemTypes")
        ? json({ data: { project: GL_PROJECT } })
        : glPage([glWorkItem(), glWorkItem({ id: "gid://gitlab/WorkItem/11", author: { id: "gid://gitlab/User/7" } })]),
    );
    const threads = await createRatingProvider("gitlab", GITLAB).listAuthored();
    expect(threads).toEqual([
      {
        ref: "ghcr.io/acme/one",
        target: "gid://gitlab/WorkItem/10",
        url: "https://gitlab.com/acme/index/-/work_items/10",
        up: 3,
      },
    ]);
  });

  it("a thread with no author binds nothing", async () => {
    onQuery((body) =>
      body.includes("discussionCategories")
        ? json({ data: { repository: GH_REPO } })
        : ghPage([ghDiscussion({ author: null })]),
    );
    expect(await createRatingProvider("github", GITHUB).listAuthored()).toEqual([]);
  });
});

describe("pagination runs to exhaustion", () => {
  it("github follows endCursor", async () => {
    let page = 0;
    const calls = onQuery((body) => {
      if (body.includes("discussionCategories")) return json({ data: { repository: GH_REPO } });
      page += 1;
      return page === 1
        ? ghPage([ghDiscussion()], true)
        : ghPage([ghDiscussion({ id: "D_2", body: buildMarker("ghcr.io/acme/two") })]);
    });
    const threads = await createRatingProvider("github", GITHUB).listAuthored();
    expect(threads.map((t) => t.ref)).toEqual(["ghcr.io/acme/one", "ghcr.io/acme/two"]);
    expect(calls.at(-1)?.body).toContain("cursor");
  });
});

describe("create", () => {
  it("github writes the marker, locks the thread, and never logs the token", async () => {
    const calls = onQuery((body) => {
      if (body.includes("discussionCategories")) return json({ data: { repository: GH_REPO } });
      if (body.includes("createDiscussion")) {
        return json({
          data: {
            createDiscussion: {
              discussion: {
                id: "D_9",
                url: "https://github.com/acme/index/discussions/9",
                upvoteCount: 0,
              },
            },
          },
        });
      }
      return json({ data: { lockLockable: { clientMutationId: null } } });
    });

    const thread = await createRatingProvider("github", GITHUB).create("ghcr.io/acme/new");
    expect(thread).toEqual({
      ref: "ghcr.io/acme/new",
      target: "D_9",
      url: "https://github.com/acme/index/discussions/9",
      up: 0,
    });

    const create = calls.find((c) => c.body?.includes("createDiscussion"));
    expect(create?.method).toBe("POST");
    expect(create?.body).toContain(buildMarker("ghcr.io/acme/new"));
    expect(create?.headers.Authorization).toBe("Bearer s3cret");
    expect(calls.some((c) => c.body?.includes("lockLockable"))).toBe(true);
  });

  it("github skips the lock when lockThreads is false", async () => {
    const calls = onQuery((body) => {
      if (body.includes("discussionCategories")) return json({ data: { repository: GH_REPO } });
      return json({
        data: {
          createDiscussion: { discussion: { id: "D_9", url: "u", upvoteCount: 0 } },
        },
      });
    });
    await createRatingProvider("github", { ...GITHUB, lockThreads: false }).create("r");
    expect(calls.some((c) => c.body?.includes("lockLockable"))).toBe(false);
  });

  it("gitlab creates a work item of the configured type and locks it", async () => {
    const calls = onQuery((body) => {
      if (body.includes("workItemTypes")) return json({ data: { project: GL_PROJECT } });
      if (body.includes("workItemCreate")) {
        return json({
          data: {
            workItemCreate: {
              workItem: {
                id: "gid://gitlab/WorkItem/99",
                webUrl: "https://gitlab.com/acme/index/-/work_items/99",
              },
            },
          },
        });
      }
      return json({ data: { workItemUpdate: { workItem: { id: "gid://gitlab/WorkItem/99" } } } });
    });

    const thread = await createRatingProvider("gitlab", GITLAB).create("ghcr.io/acme/new");
    expect(thread.target).toBe("gid://gitlab/WorkItem/99");
    expect(thread.up).toBe(0);

    const create = calls.find((c) => c.body?.includes("workItemCreate"));
    expect(create?.body).toContain("gid://gitlab/WorkItems::Type/1");
    expect(create?.headers.Authorization).toBe("Bearer s3cret");
    expect(calls.some((c) => c.body?.includes("discussionLocked"))).toBe(true);
  });

  it("a container the forge does not know is a config error, not an outage", async () => {
    onQuery(() => json({ data: { repository: { id: "R_1", discussionCategories: { nodes: [] } } } }));
    const err = await createRatingProvider("github", GITHUB)
      .listAuthored()
      .catch((e: unknown) => e as ForgeError);
    expect(err.code).toBe(65);
    expect(err.message).toContain("Ratings");
  });

  // The page-size regression. `PAGE_SIZE` used to be declared in `provider.ts`,
  // which the factory imports *before* the declaration is reached, and both
  // providers read it at module scope to build their query. Node's ESM made
  // that a temporal dead zone and every `ratings` run died on import -- but
  // this transform resolves the same read against a namespace that is not
  // populated yet, so it yielded `undefined` and every test here still passed.
  //
  // Asserting on the emitted query is therefore the only assertion that catches
  // it: behaviour alone cannot, because a stub does not mind `first:undefined`.
  it.each([
    ["github", GITHUB, "discussions"] as const,
    ["gitlab", GITLAB, "workItems"] as const,
  ])("%s asks for a real page size, not undefined", async (forge, config, field) => {
    const calls = onQuery((body) =>
      body.includes(field)
        ? forge === "github"
          ? ghPage([])
          : glPage([])
        : json({ data: { repository: GH_REPO, project: GL_PROJECT } }),
    );
    await createRatingProvider(forge, config).listAuthored();

    const page = calls.find((c) => c.body?.includes(`${field}(first:`));
    expect(page, `no ${field} query was sent`).toBeDefined();
    expect(page?.body).toContain(`${field}(first:${PAGE_SIZE},`);
    expect(page?.body).not.toContain("first:undefined");
  });
});
