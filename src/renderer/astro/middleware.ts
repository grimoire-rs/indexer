// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { shikiCss } from "./lib/code.js";

// Set by `inlineConfig` through Vite `define`, as `__GRIMOIRE_DATA__` is.
declare const __GRIMOIRE_DEV__: boolean;

/**
 * Dev only: the stand-in for `postProcessSite`, which links the Shiki sheet
 * into a finished build. A page cannot carry its own rules from inside the
 * template: Astro starts rendering later siblings while an earlier one is
 * still pending, so the registry is read before the last block fills it.
 * Here the body is read to its end first, so the sheet is complete, and it
 * is the same `@layer grimoire` rules the build serves from a file.
 */
export async function onRequest(_context: unknown, next: () => Promise<Response>): Promise<Response> {
  const response = await next();
  if (!__GRIMOIRE_DEV__ || !response.headers.get("content-type")?.includes("text/html")) return response;
  // `next()` resolves at the first byte, so the registry is read only after
  // the whole body has been rendered.
  const page = await response.text();
  const css = shikiCss();
  const html = css ? page.replace("</body>", () => `<style>${css}</style></body>`) : page;
  return new Response(html, { status: response.status, headers: response.headers });
}
