#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// A stand-in for `grim` for scripts/bench-scale.mjs: answers every call `enrich`
// makes (describe, fetch, fetch --description, each with and without
// --digest-only) deterministically per ref. `export marketplace` is refused:
// the bench builds an index with no marketplace.toml. FAKE_GRIM_LOG gets one
// line per counted call (`--version` is not one); FAKE_GRIM_LATENCY_MS delays it.
import { createHash } from "node:crypto";
import fs from "node:fs";

const argv = process.argv.slice(2);

if (argv[0] === "--version") {
  console.log("grim 0.20.0");
  process.exit(0);
}

const sha = (text) => createHash("sha256").update(text).digest("hex");
// A valid PNG signature and IHDR prefix: all `logoOk` reads.
const PNG = "89504e470d0a1a0a0000000d49484452";

const [verb, ref] = argv;
const flag = (name) => argv.includes(name);
const body = (label) => `${label} for ${ref}\n\n` + `Deterministic filler, one line per entry. ${ref}\n`.repeat(24);

let answer;
if (verb === "describe") {
  answer = {
    kind: "skill",
    digest: `sha256:${sha(`artifact:${ref}`)}`,
    title: ref.split("/").pop(),
    summary: `Synthetic entry ${ref}.`,
    version: "1.0.0",
    license: "Apache-2.0",
    created: "2026-01-01T00:00:00Z",
    keywords: ["bench", "synthetic"],
    tags: ["1.0.0", "latest"],
    deprecated: null,
    has_description: true,
  };
} else if (verb === "fetch" && flag("--description")) {
  const digest = `sha256:${sha(`companion:${ref}`)}`;
  answer = flag("--digest-only")
    ? { digest }
    : {
        digest,
        files: [
          { path: "README.md", content: body("# README") },
          { path: "CHANGELOG.md", content: body("## 1.0.0") },
          { path: "logo.png", content: Buffer.from(PNG, "hex").toString("base64"), encoding: "base64" },
        ],
      };
} else if (verb === "fetch") {
  answer = flag("--digest-only") ? { digest: `sha256:${sha(`artifact:${ref}`)}` } : { content: body("# SKILL") };
}

if (answer === undefined) {
  console.error(`fake-grim: no answer for ${argv.join(" ")}`);
  process.exit(64);
}

if (process.env.FAKE_GRIM_LOG) fs.appendFileSync(process.env.FAKE_GRIM_LOG, `${argv.join(" ")}\n`);
const latency = Number(process.env.FAKE_GRIM_LATENCY_MS ?? 0);
if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
console.log(JSON.stringify(answer));
