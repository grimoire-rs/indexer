// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The scaffold's tiny template engine, shared by `init` and `ci`. Both write
// files into somebody else's repository from the same `templates/` tree, so
// they read and substitute through one implementation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CliError, EXIT } from "./cli/exit.js";

/** Scaffold templates ship beside `dist/`, so this resolves identically from `src/` and `dist/`. */
export const TEMPLATE_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

/** `{{name}}`, but never GitHub Actions' `${{ ... }}` — hence the `$` lookbehind. */
const PLACEHOLDER = /(?<!\$)\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;

export function readTemplate(rel: string): string {
  const file = path.join(TEMPLATE_DIR, rel);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    throw new CliError(
      `scaffold template ${rel} is missing from ${TEMPLATE_DIR} — the installed package is incomplete`,
      EXIT.unavailable,
    );
  }
}

/**
 * Substitute `{{key}}` placeholders. Single pass: a value that itself
 * contains a placeholder is left alone, so a composed block (the enrich
 * steps, say) has to be rendered before it is handed in as a value.
 */
export function render(template: string, vars: Record<string, string>, rel: string): string {
  return template.replace(PLACEHOLDER, (match, key: string) => {
    if (!(key in vars)) {
      throw new CliError(`scaffold template ${rel} references unknown placeholder {{${key}}}`);
    }
    return vars[key] as string;
  });
}

/** Read and substitute in one step — the common case. */
export function fromTemplate(rel: string, vars: Record<string, string>): string {
  return render(readTemplate(rel), vars, rel);
}
