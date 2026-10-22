// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The one HTTP call site. Node 22's global `fetch`, no HTTP dependency.
 *
 * Bounded on every axis a hostile endpoint controls: a wall-clock timeout, a
 * response-size cap enforced while streaming, and no redirect following — a
 * `Location` under someone else's control is an SSRF pivot past the host
 * policy that was checked before the call.
 */

export const USER_AGENT = "grim-indexer-bot";
export const TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * The cap for the two calls that legitimately read more than a small JSON
 * document: the enrichment checkpoint, which is the whole sidecar tree, and a
 * ratings page, which carries every thread's full body — including bodies this
 * bot did not write.
 *
 * The same ceiling `enrich` already accepts from one `grim` subprocess
 * (`MAX_OUTPUT_BYTES`), so the largest thing this toolchain holds in memory is
 * one number rather than three.
 */
export const LARGE_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface HttpResponse {
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  body: string;
  header(name: string): string;
  /** Why `status` is 0: the error code, the timeout or the cap. Absent on a real status. */
  reason?: string;
}

/**
 * What to print for a response that is not a success: `HTTP 503`, or why no
 * answer arrived. A bare `HTTP 0` names no cause an operator could act on.
 */
export function describeStatus(res: Pick<HttpResponse, "status" | "reason">): string {
  return res.status === 0 ? `no answer (${res.reason ?? "unknown cause"})` : `HTTP ${res.status}`;
}

/** The code a failed `fetch` carries (undici puts it on `cause`), else the timeout; never free text. */
export function failureReason(err: unknown, timeoutMs = TIMEOUT_MS): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  if (e?.name === "TimeoutError") return `timed out after ${timeoutMs} ms`;
  return "transport error";
}

async function readCapped(
  response: Response,
  cap: number,
  encoding: BufferEncoding,
): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString(encoding);
}

/** Everything past a plain GET. Omitted leaves `fetch`'s own defaults. */
export interface RequestOptions {
  method?: string;
  body?: string;
  /**
   * Response-size cap for this call, in bytes. Defaults to
   * [`MAX_RESPONSE_BYTES`], so every call site that does not ask keeps the
   * reply it already got, byte for byte.
   *
   * Per-call because the default is sized for a small JSON document, and two
   * callers legitimately read more: the enrichment checkpoint is the whole
   * sidecar tree, and a ratings page carries every thread's full body. Both
   * used to surface as `{status: 0}` — indistinguishable from a transport
   * failure, which is how an oversized page got reported as one.
   */
  maxBytes?: number;
  /**
   * How the body is decoded into `HttpResponse.body`. `"latin1"` is the
   * lossless one for a binary payload — `Buffer.from(body, "latin1")` gives
   * the exact bytes back, which the default UTF-8 decode would have mangled.
   */
  encoding?: "utf8" | "latin1";
}

export async function request(
  url: string,
  headers: Record<string, string> = {},
  options: RequestOptions = {},
): Promise<HttpResponse> {
  const cap = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const none = (reason: string): HttpResponse => ({ status: 0, body: "", header: () => "", reason });
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...headers },
      // Both `undefined` for a two-argument call, which is what `fetch` sees
      // when neither is passed — the existing GET call sites are untouched.
      method: options.method,
      body: options.body,
      // ponytail: redirects are refused, not followed. If a real registry ever
      // needs one, re-run the host policy on the Location and follow one hop.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await readCapped(response, cap, options.encoding ?? "utf8");
    if (body === null) return none(`body over the ${cap} byte cap`);
    return {
      status: response.status,
      body,
      header: (name) => response.headers.get(name) ?? "",
    };
  } catch (err) {
    return none(failureReason(err));
  }
}

/** `request` plus a `JSON.parse` that yields `null` instead of throwing. */
export async function requestJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  const response = await request(url, headers);
  if (response.body === "") return { status: response.status, data: null };
  try {
    return { status: response.status, data: JSON.parse(response.body) };
  } catch {
    return { status: response.status, data: null };
  }
}
