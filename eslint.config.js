// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
);
