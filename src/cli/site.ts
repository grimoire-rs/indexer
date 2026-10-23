// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer site` — print the URL this index publishes to, as every other
// command resolves it, so CI shell reads the same answer the collectors do.
import path from "node:path";

import { CliError, EXIT, type ExitCode } from "./exit.js";

export async function site(root: string): Promise<ExitCode> {
  const { loadConfig } = await import("../config.js");
  const value = (await loadConfig(path.resolve(root))).site;
  if (value === undefined) throw new CliError("site: `site` is unset in index.config.json and could not be derived", EXIT.data);
  console.log(value);
  return EXIT.ok;
}
