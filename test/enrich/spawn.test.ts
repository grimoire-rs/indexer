// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// grim 0.16.0 fetches a description companion of up to 32 MiB (8 MiB before), and
// `fetch --description --format json` carries every member inline, base64 for a binary one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { spawnGrim } from "../../src/enrich/index.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-grim-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A stand-in `grim` whose JSON report is `bytes` long. */
function fakeGrim(bytes: number): string {
  const bin = path.join(dir, `grim-${bytes}`);
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ files: [{ path: "a.bin", content: "A".repeat(${bytes}), encoding: "base64" }] }));\n`,
    { mode: 0o755 },
  );
  return bin;
}

describe("spawnGrim", () => {
  it("reads a companion report as large as grim 0.16.0 can produce (32 MiB, base64: ~43 MiB)", async () => {
    const run = spawnGrim(fakeGrim(Math.ceil((32 * 1024 * 1024 * 4) / 3)));
    const report = (await run(["fetch", "r", "--description"])) as { files: { content: string }[] };
    expect(report.files[0]?.content.length).toBeGreaterThan(40 * 1024 * 1024);
  });
});
