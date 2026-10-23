// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Print the GitHub release notes for one version: its CHANGELOG.md section
// without the heading, then the compare link the changelog records for it.
//
//   node scripts/release-notes.mjs 0.6.1
import fs from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("usage: release-notes.mjs <version>");
  process.exitCode = 64;
} else {
  const lines = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) {
    console.error(`release-notes: CHANGELOG.md has no section for ${version}`);
    process.exitCode = 65;
  } else {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith("## [") || /^\[[^\]]+\]: /.test(line));
    const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
    const link = lines.find((line) => line.startsWith(`[${version}]: `))?.slice(version.length + 4);
    console.log(link ? `${body}\n\n**Full diff:** ${link}` : body);
  }
}
