// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Loads enrich/<namespace>/<name>/{readme,changelog}.md. `base` is
// resolved relative to the Astro root, which `buildSite` sets to the index
// repo root — no cwd walk-up, no marker file. The tree is optional:
// glob() degrades to an empty collection when its base dir doesn't exist.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// id = "<namespace>/<name>", matching the page slug, by stripping the
// trailing "/<file>.md" off the glob-relative entry path.
function idFromFile(file: string) {
  const re = new RegExp(`/${file}\\.md$`);
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

export const collections = { readmes, changelogs };
