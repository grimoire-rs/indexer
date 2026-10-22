// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Preloaded with `node --import`: writes this process's peak resident set size (KiB) to
// BENCH_RSS_FILE on exit. scripts/bench-scale.mjs reads it for V-19's memory figure.
import fs from "node:fs";

const file = process.env.BENCH_RSS_FILE;
if (file) process.on("exit", () => fs.writeFileSync(file, String(process.resourceUsage().maxRSS)));
