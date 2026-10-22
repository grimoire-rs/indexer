// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { gzipSync } from "node:zlib";

/**
 * One member, mtime 0, no name or comment, level 9, header OS byte `0xff`: the
 * same input gives the same bytes on every platform zlib.
 */
export function gzipDeterministic(bytes: Uint8Array): Buffer {
  const out = gzipSync(bytes, { level: 9 });
  // zlib stamps the build platform here; the CRC covers the data, not the header.
  out[9] = 0xff;
  return out;
}
