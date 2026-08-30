// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  test: {
    environment: "node",
    // `.agents/worktrees/` holds git worktrees — duplicate checkouts of this
    // same repo, git-ignored, each with its own full suite. Collecting them
    // from here runs every test once per worktree and reports another work
    // package's red stubs as this tree's failures. Spread the defaults: a
    // bare `exclude` replaces them rather than adding to them.
    exclude: [...configDefaults.exclude, "**/.agents/worktrees/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
