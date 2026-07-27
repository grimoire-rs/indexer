// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { afterEach, describe, expect, it, vi } from "vitest";

import { refReachable, tokenRequest } from "../../src/validate/adapters/registry.js";
import { stubFetch, type Route } from "./helpers.js";

const TAGS = "https://reg.example.com/v2/acme/tool/tags/list";
const CHALLENGE = 'Bearer realm="https://auth.example.com/token",service="reg.example.com"';

afterEach(() => {
  vi.unstubAllGlobals();
});

const unauthorized: Route = {
  status: 401,
  headers: { "WWW-Authenticate": CHALLENGE },
};

describe("refReachable", () => {
  it("is true only when the registry lists a tag", async () => {
    const cases: [string, boolean][] = [
      ['{"tags":["1.0.0"]}', true],
      ['{"tags":[]}', false],
      ["{}", false],
      ['{"tags":"1.0.0"}', false],
      ["not json", false],
    ];
    for (const [body, expected] of cases) {
      stubFetch(() => ({ body }));
      expect(await refReachable("reg.example.com", "acme/tool"), body).toBe(expected);
      vi.unstubAllGlobals();
    }
  });

  it("is false for an unpublished repository", async () => {
    stubFetch(() => ({ status: 404 }));
    expect(await refReachable("reg.example.com", "acme/tool")).toBe(false);
  });

  it("never follows a redirect", async () => {
    const calls = stubFetch(() => ({ status: 302, headers: { Location: "http://169.254.169.254/" } }));
    expect(await refReachable("reg.example.com", "acme/tool")).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe("manual");
  });

  it("runs the bearer-token dance on a 401", async () => {
    let issued = false;
    const calls = stubFetch((url) => {
      if (url.startsWith("https://auth.example.com/token")) {
        issued = true;
        return { body: '{"token":"minted"}' };
      }
      if (url === TAGS) return issued ? { body: '{"tags":["1.0.0"]}' } : unauthorized;
      return null;
    });

    expect(await refReachable("reg.example.com", "acme/tool")).toBe(true);
    const token = calls[1]?.url ?? "";
    expect(token).toContain("scope=repository%3Aacme%2Ftool%3Apull");
    expect(token).toContain("service=reg.example.com");
    expect(calls[2]?.headers.Authorization).toBe("Bearer minted");
  });

  it("gives up when the token endpoint refuses", async () => {
    stubFetch((url) => (url === TAGS ? unauthorized : { status: 403 }));
    expect(await refReachable("reg.example.com", "acme/tool")).toBe(false);
  });

  it("caps an endlessly large response", async () => {
    stubFetch(() => ({ body: `{"tags":["${"a".repeat(2 * 1024 * 1024)}"]}` }));
    expect(await refReachable("reg.example.com", "acme/tool")).toBe(false);
  });
});

describe("tokenRequest — the realm is attacker-controlled", () => {
  it("builds a scoped token URL for a well-formed challenge", () => {
    const target = tokenRequest(CHALLENGE, "reg.example.com", "acme/tool");
    expect(target?.url).toContain("https://auth.example.com/token?");
    expect(target?.url).toContain("scope=repository%3Aacme%2Ftool%3Apull");
  });

  it("refuses realms that would turn the gate into an SSRF probe", () => {
    for (const challenge of [
      "Bearer service=\"x\"",
      'Bearer realm="http://auth.example.com/token"',
      'Bearer realm="https://169.254.169.254/token"',
      'Bearer realm="https://127.0.0.1/token"',
      'Bearer realm="https://[::1]/token"',
      'Bearer realm="https://localhost/token"',
      'Bearer realm="https://user:pass@auth.example.com/token"',
      'Bearer realm="file:///etc/passwd"',
      'Bearer realm="not a url"',
    ]) {
      expect(tokenRequest(challenge, "reg.example.com", "acme/tool"), challenge).toBeNull();
    }
  });

  it("only credentials a realm on the registry itself or on the allowlist", () => {
    const foreign = tokenRequest(CHALLENGE, "reg.example.com", "acme/tool");
    expect(foreign?.credentialed).toBe(false);

    const listed = tokenRequest(CHALLENGE, "reg.example.com", "acme/tool", ["auth.example.com"]);
    expect(listed?.credentialed).toBe(true);

    const sameHost = tokenRequest(
      'Bearer realm="https://reg.example.com/token"',
      "reg.example.com",
      "acme/tool",
    );
    expect(sameHost?.credentialed).toBe(true);
  });

  it("does not send the configured credential to a foreign realm", async () => {
    const calls = stubFetch((url) =>
      url === TAGS ? unauthorized : { body: '{"token":"minted"}' },
    );
    await refReachable("reg.example.com", "acme/tool", { auth: "user:secret" });
    const tokenCall = calls.find((call) => call.url.startsWith("https://auth.example.com"));
    expect(tokenCall).toBeDefined();
    expect(tokenCall?.headers.Authorization).toBeUndefined();
  });

  it("sends it to an allowlisted realm", async () => {
    const calls = stubFetch((url) =>
      url === TAGS ? unauthorized : { body: '{"token":"minted"}' },
    );
    await refReachable("reg.example.com", "acme/tool", {
      auth: "user:secret",
      allowlist: ["reg.example.com", "auth.example.com"],
    });
    const tokenCall = calls.find((call) => call.url.startsWith("https://auth.example.com"));
    expect(tokenCall?.headers.Authorization).toBe(
      `Basic ${Buffer.from("user:secret").toString("base64")}`,
    );
  });
});
