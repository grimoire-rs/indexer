// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output only — nothing here ships or executes, which is the bar
    // an ignore entry has to clear.
    //
    // `.dev/` is `npm run dev`'s scratch index root; Astro generates typed
    // `.astro/` stubs inside it that are not ours to lint. `site/` is
    // `task docs:build`'s output — minified vendor JS, 800-odd findings, none
    // of it authored here.
    // `.agents/worktrees/` holds git worktrees — duplicate checkouts of this
    // same repo, git-ignored, each linted by its own gate in its own tree.
    // Linting them from here is not extra coverage, and it breaks the parser
    // outright: it finds a tsconfig.json per worktree and refuses to guess
    // which root to resolve against.
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      ".dev/**",
      "site/**",
      ".agents/worktrees/**",
      // `task quality:web` artifacts — two generated catalog sites and the
      // Lighthouse reports for each.
      ".lhci-*/**",
      ".lighthouseci/**",
      ".lighthouseci-bulk/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    // `scripts/lhci-posix-tmpdir.cjs` is CommonJS by necessity: it is preloaded
    // with `node --require` to intercept a CommonJS module resolution, which an
    // ES module cannot do.
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      // `const { descDigest: _drop, ...rest } = sidecar` is the idiomatic way to
      // omit a key. Allow it, and allow a leading underscore to mark any other
      // binding as deliberately unused, rather than contorting the code.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
