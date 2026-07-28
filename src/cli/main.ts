// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Argument parsing and the single place errors become exit codes. The bin
// entry (`index.ts`) does nothing but call `run` and set `process.exitCode`.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, Option } from "commander";

import { build } from "./build.js";
import { CliError, EXIT, type ExitCode } from "./exit.js";
import { init, type Forge } from "./init.js";
import { validate, type ValidateFlags } from "./validate.js";

interface InitCliOptions {
  quick?: boolean;
  name?: string;
  title?: string;
  baseUrl?: string;
  registry?: string;
  registryHost?: string;
  logo?: string;
  forge?: Forge;
  git?: boolean;
  withSkills?: boolean;
  force?: boolean;
}

/** Read from disk rather than imported, so `rootDir: src` stays intact. */
function packageVersion(): string {
  const manifest = fileURLToPath(new URL("../../package.json", import.meta.url));
  const parsed: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" ? version : "0.0.0";
}

/**
 * Map a thrown value to an exit code, printing whatever the user needs to
 * see. Commander has already written its own usage text by the time its
 * errors land here.
 */
function classify(err: unknown): ExitCode {
  if (err instanceof CommanderError) {
    // `--help` and `--version` also arrive here, with exitCode 0.
    return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
  }
  if (err instanceof CliError) {
    if (err.code !== EXIT.ok) console.error(err.message);
    return err.code;
  }
  if (err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") {
    console.error(
      `${err.message}\nthis build of grimoire-indexer is incomplete — run \`npm run build\``,
    );
    return EXIT.unavailable;
  }
  // How the compiler, the config loader, and the renderer reject bad input
  // — a data problem in the repo being built, not a bug in the tool. Matched
  // by name so `build`'s modules stay dynamically imported.
  if (
    err instanceof Error &&
    ["IndexValidationError", "SiteConfigError", "RenderInputError"].includes(err.name)
  ) {
    console.error(err.message);
    return EXIT.data;
  }
  console.error(err instanceof Error ? err.message : String(err));
  return EXIT.failure;
}

export async function run(argv: string[]): Promise<number> {
  const version = packageVersion();
  let code: ExitCode = EXIT.ok;

  const program = new Command()
    .name("grimoire-indexer")
    .description("Run your own grim package index")
    .version(version)
    .exitOverride();

  program
    .command("init")
    .argument("[dir]", "directory to scaffold into", ".")
    .description("scaffold an index repo")
    .option("--quick", "skip every prompt and take defaults (for CI)")
    .option("--name <name>", "index identifier")
    .option("--title <title>", "display title")
    .option("--base-url <url>", "URL the index is served from")
    .option("--registry <alias>", "registry alias packages are published under")
    .option("--registry-host <host>", "OCI registry host", "ghcr.io")
    .option("--logo <path>", "brand logo path or URL")
    .addOption(new Option("--forge <forge>", "CI to scaffold").choices(["github", "gitlab", "both"]))
    .option("--no-git", "do not run `git init`")
    .option(
      "--with-skills",
      "scaffold the combined layout: this repo holds its skills and its index",
    )
    .option("--force", "overwrite files that differ from the scaffold")
    .action(async (dir: string, opts: InitCliOptions, cmd: Command) => {
      code = await init(
        dir,
        // `--no-git` defaults `git` to true, which would silently answer the
        // interactive prompt; only an explicit flag counts as an answer.
        { ...opts, git: cmd.getOptionValueSource("git") === "cli" ? opts.git : undefined },
        version,
      );
    });

  program
    .command("build")
    .argument("[root]", "index repo root", ".")
    .description("compile index/** and render the site into dist/")
    .option("--out-dir <dir>", "output directory", "dist")
    .action(async (root: string, opts: { outDir?: string }) => {
      code = await build(root, { outDir: opts.outDir });
    });

  program
    .command("validate")
    .argument("[files...]", "changed index/** paths from the PR/MR diff")
    .description("contribution gate: exit 0 = eligible for auto-merge")
    .option("--root <dir>", "trusted base checkout — the committed state", ".")
    // Required, but enforced in `validate` rather than by commander: the gate
    // contract puts a missing `--pr-tree` in the 65 bucket, not commander's 64.
    .option("--pr-tree <dir>", "checkout of the PR head, read as data only")
    .option("--policy <file>", "path to index-policy.json")
    .addOption(
      new Option("--forge <forge>", "forge hosting the contribution").choices([
        "github",
        "gitlab",
      ]),
    )
    .option("--author-login <login>", "contribution author's forge login")
    .option("--author-id <id>", "contribution author's numeric forge id")
    .action(async (files: string[], opts: ValidateFlags) => {
      code = await validate(files, opts);
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    return classify(err);
  }
  return code;
}
