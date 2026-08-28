// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The `RatingProvider` seam — one interface, two forges, one in-memory fake.
 *
 * Mirrors `validate/adapters/forge.ts`: an interface, per-forge closures, and a
 * `create*` factory that picks between them. The GraphQL plumbing every
 * provider needs lives here rather than in each of them, because the one rule
 * that must not drift is [`graphql`]'s error branching — a 200 carrying a
 * populated `errors` array is a hard error, and two copies of that check is how
 * one of them turns into an empty tally.
 */

import { CliError, EXIT, type ExitCode } from "../cli/exit.js";
import { LARGE_RESPONSE_BYTES, request, type HttpResponse } from "../validate/adapters/http.js";
import { buildMarker, type AuthorizedThread } from "./marker.js";
import type { TrustedBot } from "../validate/core/ownership.js";
// The factory owns the dispatch, so it imports both implementations while they
// import the shared plumbing back. ESM handles the cycle: everything crossing it
// is a hoisted function declaration, referenced only from inside a closure.
import { githubProvider as github } from "./provider_github.js";
import { gitlabProvider as gitlab } from "./provider_gitlab.js";

/**
 * A thread the reconcile loop may tally. Declared as an alias of R-1's
 * `AuthorizedThread` rather than a second identical interface: R-1 is what
 * produces these, and the type should say so.
 */
export type RatingThread = AuthorizedThread;

export interface RatingProviderConfig {
  /** GraphQL endpoint, e.g. `https://api.github.com/graphql`. */
  api: string;
  /** Credential with write access to threads. Never logged. */
  token: string;
  /** GitHub `owner/repo`; GitLab full project path. */
  project: string;
  /** GitHub Discussions category name; GitLab work item type name. */
  container: string;
  /** Lock threads on creation — votes count, replies are refused. */
  lockThreads: boolean;
  /** `index-policy.json`'s allowlist. R-1 clause 2 reads ids out of it. */
  trustedBots?: readonly TrustedBot[];
}

export interface RatingProvider {
  /**
   * Every thread the bot authored in the configured container, paginated to
   * exhaustion. R-1 filtering is applied **here**, never by the caller.
   *
   * A secondary rate limit part-way through throws [`RateLimited`] carrying the
   * pages already read — a truncated pass is partial, not empty, and the caller
   * needs both facts to publish without wiping what it could not observe.
   */
  listAuthored(): Promise<RatingThread[]>;
  /** Create one thread carrying the marker. The budget is the caller's job. */
  create(ref: string): Promise<RatingThread>;
}

/**
 * The forge answered, and the answer was unusable: a transport failure, a
 * non-2xx, a body that did not parse, or a 200 carrying GraphQL `errors`.
 *
 * A `CliError` subclass rather than a name in `classify()`'s list, following
 * `seed.ts`: that list exists for errors thrown by modules `main.ts` must not
 * import, and `cli/exit.js` is already one of its static imports — so the
 * mapping here is by type, which cannot drift out of sync with a string.
 */
export class ForgeError extends CliError {
  constructor(message: string, code: ExitCode = EXIT.unavailable) {
    super(message, code);
    this.name = "RatingsForgeError";
  }
}

/**
 * A secondary rate limit. Distinguished from [`ForgeError`] because the two are
 * handled oppositely: a forge error fails the run, a rate limit stops it early
 * and publishes what it already got.
 */
export class RateLimited extends ForgeError {
  /** What the forge asked us to wait, by GitHub's documented precedence. */
  readonly retryAfterMs: number;
  /** Threads read before the limit. Empty on the create path. */
  readonly observed: readonly RatingThread[];

  constructor(message: string, retryAfterMs: number, observed: readonly RatingThread[] = []) {
    super(message);
    this.name = "RatingsRateLimited";
    this.retryAfterMs = retryAfterMs;
    this.observed = observed;
  }
}

/** GitHub's documented floor when neither header says how long to wait. */
export const BACKOFF_FLOOR_MS = 60_000;

/**
 * Nodes per page.
 *
 * 50 rather than the API maximum of 100. This used to be a workaround for
 * `request()`'s fixed 1 MiB cap — a page carries every thread's full body,
 * including bodies this bot did not write, so a container holding long human
 * threads overran the cap and [`graphql`] reported it as a transport failure.
 * That was a real failure on first runs, before any bot thread existed.
 *
 * The cap is now per-call (`LARGE_RESPONSE_BYTES`, passed below), so the size
 * argument for keeping this at 50 is gone. It stays at 50 anyway: raising it
 * changes request count and cursor behaviour for every existing index, which
 * is a separate decision from fixing the overrun.
 */
export const PAGE_SIZE = 50;

/**
 * The body every provider writes. The marker sits on its own line, which is the
 * only position R-1's anchored parser accepts; the prose above it is for the
 * human who lands on the thread from the catalog.
 */
export function threadBody(ref: string): string {
  return [
    `Rating thread for \`${ref}\`.`,
    "",
    "Upvote this thread to rate the package. Replies are not read by the tally.",
    "",
    buildMarker(ref),
  ].join("\n");
}

export function field(data: unknown, key: string): unknown {
  if (typeof data !== "object" || data === null) return undefined;
  return (data as Record<string, unknown>)[key];
}

/** `field`, chained. Every GraphQL read here is a path into an `unknown`. */
export function at(data: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((value, key) => field(value, key), data);
}

export function stringAt(data: unknown, ...keys: string[]): string {
  const value = at(data, ...keys);
  return typeof value === "string" ? value : "";
}

export function nodes(data: unknown): unknown[] {
  const value = at(data, "nodes");
  return Array.isArray(value) ? value : [];
}

/**
 * How long the forge asked us to wait: `retry-after` first, then
 * `x-ratelimit-reset`, else the documented floor. GitHub's guidance is explicit
 * that continuing to make requests while rate limited can get an integration
 * banned, so this value is honoured by *stopping*, which is the strongest form
 * of honouring it — a scheduled run resumes on the next tick, and sleeping here
 * would burn CI minutes waiting to make requests the design has already decided
 * not to make.
 */
function retryAfterMs(response: HttpResponse): number {
  const after = Number(response.header("retry-after"));
  if (Number.isFinite(after) && after > 0) return after * 1000;
  const reset = Number(response.header("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const wait = reset * 1000 - Date.now();
    if (wait > 0) return wait;
  }
  return BACKOFF_FLOOR_MS;
}

/**
 * Is this reply a rate limit rather than an ordinary refusal?
 *
 * 429 always. 403 only when it says so — GitHub returns 403 for both a
 * secondary limit and a plain permission failure, and the two are handled
 * oppositely, so the discrimination has to be explicit.
 */
function rateLimitOf(response: HttpResponse): number | null {
  if (response.status === 429) return retryAfterMs(response);
  if (response.status !== 403) return null;
  const secondary =
    /secondary rate limit|rate limit/i.test(response.body) ||
    response.header("retry-after") !== "" ||
    response.header("x-ratelimit-remaining") === "0";
  return secondary ? retryAfterMs(response) : null;
}

function graphqlErrors(parsed: unknown): { message: string; limited: boolean } | null {
  const errors = field(parsed, "errors");
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const message = errors
    .map((err) => stringAt(err, "message") || JSON.stringify(err))
    .join("; ");
  const limited = errors.some(
    (err) =>
      stringAt(err, "type") === "RATE_LIMITED" ||
      stringAt(err, "extensions", "code") === "RATE_LIMITED",
  );
  return { message, limited };
}

/**
 * One GraphQL round trip, with the branching every provider shares.
 *
 * Order matters and is the reason this is one function: a rate limit is
 * classified first (it is the one failure that must not fail the run), then
 * `errors` is checked **independently of the HTTP status and before `data` is
 * touched** — a 200 with `errors` and a null `data` otherwise reads as
 * "genuinely fewer votes observed", which is silent emptying arriving through
 * the one door R-2 does not watch.
 *
 * @param observed Threads already read, attached to a [`RateLimited`] so a
 *   truncated pagination pass stays partial rather than becoming empty.
 */
export async function graphql(
  api: string,
  headers: Record<string, string>,
  query: string,
  variables: Record<string, unknown>,
  observed: readonly RatingThread[] = [],
): Promise<Record<string, unknown>> {
  const response = await request(api, { ...headers, "Content-Type": "application/json" }, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
    // A page is `PAGE_SIZE` threads and every one of their bodies. The default
    // 1 MiB is sized for a small JSON document, and overrunning it lands as
    // `status: 0` below — reported as a transport failure, which is what an
    // oversized first page was being misdiagnosed as.
    maxBytes: LARGE_RESPONSE_BYTES,
  });

  const wait = rateLimitOf(response);
  if (wait !== null) {
    throw new RateLimited(
      `${api}: secondary rate limit (HTTP ${response.status}), retry after ${Math.round(wait / 1000)}s`,
      wait,
      observed,
    );
  }

  let parsed: unknown;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch (err) {
    parseError = (err as Error).message;
  }

  const errors = graphqlErrors(parsed);
  if (errors) {
    if (errors.limited) throw new RateLimited(`${api}: ${errors.message}`, BACKOFF_FLOOR_MS, observed);
    throw new ForgeError(`${api}: ${errors.message}`);
  }

  // `status: 0` is `request()`'s transport catch *and* its response-size cap.
  // Neither says anything about what the forge holds, so both are hard errors.
  if (response.status === 0) {
    throw new ForgeError(`${api}: the request did not complete (transport failure or oversized reply)`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ForgeError(`${api}: HTTP ${response.status}`);
  }
  if (parseError !== null) {
    throw new ForgeError(`${api}: the reply did not parse (${parseError})`);
  }

  const data = field(parsed, "data");
  if (typeof data !== "object" || data === null) {
    throw new ForgeError(`${api}: the reply carried no data`);
  }
  return data as Record<string, unknown>;
}

export function createRatingProvider(
  kind: "github" | "gitlab",
  config: RatingProviderConfig,
): RatingProvider {
  // Deliberately a `?:` and not a registry: two forges, one dispatch site, the
  // same shape `createForge` already uses.
  return kind === "github" ? github(config) : gitlab(config);
}
