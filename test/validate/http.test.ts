// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_RESPONSE_BYTES, request, USER_AGENT } from "../../src/validate/adapters/http.js";
import { stubFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const URL = "https://api.example.com/graphql";

describe("request", () => {
  it("sends the method and the body it was given", async () => {
    const calls = stubFetch(() => ({ body: '{"data":{}}' }));
    const payload = JSON.stringify({ query: "{ viewer { login } }" });

    const response = await request(URL, { Authorization: "Bearer t" }, { method: "POST", body: payload });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBe(payload);
    expect(calls[0].headers.Authorization).toBe("Bearer t");
    expect(calls[0].headers["User-Agent"]).toBe(USER_AGENT);
    expect(calls[0].redirect).toBe("manual");
  });

  // The eight existing call sites (forge.ts:68,85,102,117,136 via `requestJson`,
  // registry.ts:81,100,107) all pass one or two arguments. This pins what that
  // shape puts on the wire, so the additive third parameter cannot alter it.
  it("leaves a two-argument call as the GET it always was", async () => {
    const calls = stubFetch(() => ({ body: "{}" }));

    await request(URL, { Accept: "application/json" });

    expect(calls[0].method).toBeUndefined();
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].redirect).toBe("manual");
  });

  // `{status: 0}` means "no usable response", and deliberately does not
  // distinguish these two. A caller cannot tell an oversized body from a dead
  // socket; both tests exist so that stops being true only on purpose.
  it("reports an over-cap body as status 0", async () => {
    stubFetch(() => ({ body: "x".repeat(MAX_RESPONSE_BYTES + 1) }));

    expect(await request(URL)).toMatchObject({ status: 0, body: "" });
  });

  it("reports a transport failure as status 0", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));

    expect(await request(URL)).toMatchObject({ status: 0, body: "" });
  });

  // Two callers legitimately read more than a small JSON document: the
  // enrichment checkpoint, which is the whole sidecar tree, and a ratings page,
  // which carries every thread's full body. Before the cap was per-call both
  // surfaced as `status: 0` — read by `graphql` as a transport failure, which
  // is how an oversized first page got reported as a dead socket.
  it("reads past the default cap when the caller asks for a larger one", async () => {
    const body = "x".repeat(MAX_RESPONSE_BYTES + 1);
    stubFetch(() => ({ body }));

    const response = await request(URL, {}, { maxBytes: MAX_RESPONSE_BYTES * 2 });

    expect(response.status).toBe(200);
    expect(response.body).toBe(body);
  });

  it("still caps at the larger value", async () => {
    stubFetch(() => ({ body: "x".repeat(MAX_RESPONSE_BYTES + 1) }));

    expect(await request(URL, {}, { maxBytes: MAX_RESPONSE_BYTES })).toMatchObject({ status: 0 });
  });
});
