// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `.dev/` is `npm run dev`'s scratch index root; Astro generates typed
    // `.astro/` stubs inside it that are not ours to lint.
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".dev/**"],
  },
  ...tseslint.configs.recommended,
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
