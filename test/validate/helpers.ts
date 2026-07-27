// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";

/** A stubbed HTTP reply. `null` from a handler means "no such endpoint". */
export interface Route {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface Call {
  url: string;
  headers: Record<string, string>;
  redirect?: RequestInit["redirect"];
}

const BODYLESS = new Set([204, 205, 304]);

/**
 * Route the global `fetch` through `handler`. Returns the recorded calls, so a
 * test can assert on what was *not* requested — SSRF ordering is a claim about
 * calls that must never happen.
 */
export function stubFetch(
  handler: (url: string) => Route | null | undefined,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      redirect: init?.redirect,
    });
    const route = handler(url);
    if (!route) return Promise.resolve(new Response("", { status: 404 }));
    const status = route.status ?? 200;
    return Promise.resolve(
      new Response(BODYLESS.has(status) ? null : (route.body ?? ""), {
        status,
        headers: route.headers,
      }),
    );
  });
  return calls;
}

/** Materialize a checkout. A `null` value creates a symlink to `/etc/passwd`. */
export async function makeTree(
  files: Record<string, string | null>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "grimoire-index-test-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    if (content === null) await symlink("/etc/passwd", target);
    else await writeFile(target, content);
  }
  return root;
}

export function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    name: "tool",
    kind: "skill",
    ref: "reg.example.com/acme/tool",
    description: "d",
    owner: { github: "acme", id: 7 },
    ...overrides,
  });
}
