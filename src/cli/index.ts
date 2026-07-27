#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { run } from "./main.js";

// `process.exitCode` rather than `process.exit()` — the latter truncates
// buffered stdout when output is piped.
process.exitCode = await run(process.argv);
