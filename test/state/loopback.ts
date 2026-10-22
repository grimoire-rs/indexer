// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// A real HTTP server on 127.0.0.1 (never a fixed port), for the claims a stubbed
// `fetch` cannot make: content decoding, redirects and the headers on the wire.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Hit {
  url: string;
  headers: http.IncomingHttpHeaders;
}

export interface Loopback {
  /** `http://127.0.0.1:<port>`, a `site` that qualifies. */
  origin: string;
  hits: Hit[];
  close(): Promise<void>;
}

export async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Loopback> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The `c/root.json` a healthy index serves. */
export function rootJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    flat: null,
    generated_at: "2026-10-21T08:00:00Z",
    generation: 1_792_000_000,
    planes: { catalog: null, enrich: null },
    schema: 1,
    search: null,
    stats: null,
    ...over,
  });
}
