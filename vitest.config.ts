// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
