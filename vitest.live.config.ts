// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { defineConfig } from "vitest/config";

import base, { LIVE } from "./vitest.config.js";

// `npm run test:live`: the default config with only the suite it excludes.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [`${LIVE}/*.test.ts`],
    exclude: (base.test?.exclude ?? []).filter((glob) => glob !== LIVE),
    // A grim release, an enrich and an Astro build per suite.
    hookTimeout: 300_000,
  },
});
