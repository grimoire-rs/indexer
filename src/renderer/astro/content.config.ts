// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Loads enrich/<namespace>/<name>/{readme,changelog,contents}.md plus the
// `contents.json` a bundle or an MCP server carries instead. `base` is
// resolved relative to the Astro root, which `buildSite` sets to the index
// repo root — no cwd walk-up, no marker file. The tree is optional:
// glob() degrades to an empty collection when its base dir doesn't exist.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// id = "<namespace>/<name>", matching the page slug, by stripping the
// trailing "/<file>.<ext>" off the glob-relative entry path.
function idFromFile(file: string, ext = "md") {
  const re = new RegExp(`/${file}\\.${ext}$`);
  return ({ entry }: { entry: string }) => entry.replace(re, "");
}

const readmes = defineCollection({
  loader: glob({ pattern: "**/readme.md", base: "./enrich", generateId: idFromFile("readme") }),
});

const changelogs = defineCollection({
  loader: glob({
    pattern: "**/changelog.md",
    base: "./enrich",
    generateId: idFromFile("changelog"),
  }),
});

// The artifact's own entry point: SKILL.md for a skill, the rule or agent
// markdown for those. Rendered, not quoted — this is the instruction text a
// reader is deciding whether to install.
const contents = defineCollection({
  loader: glob({ pattern: "**/contents.md", base: "./enrich", generateId: idFromFile("contents") }),
});

// A bundle's member list and an MCP server's descriptor are JSON, not prose,
// so they arrive as a data collection rather than a rendered one.
const contentData = defineCollection({
  loader: glob({
    pattern: "**/contents.json",
    base: "./enrich",
    generateId: idFromFile("contents", "json"),
  }),
});

export const collections = { readmes, changelogs, contents, contentData };
