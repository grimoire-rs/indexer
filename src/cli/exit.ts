// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Process exit codes, aligned with BSD `sysexits.h` (64–78) the same way
 * `grim` itself is — semantic codes start at 64 so they collide with
 * neither the shell-reserved 1–2 nor the signal-derived 128+.
 *
 * `validate` carries an extra contract on top: **0 means eligible for
 * auto-merge, any non-zero means manual review required**. CI branch
 * protection reads nothing but that.
 */
export const EXIT = {
  /** Success. For `validate`: eligible for auto-merge. */
  ok: 0,
  /** Generic failure — used only when nothing more specific applies. */
  failure: 1,
  /** Bad invocation: unknown flag, missing argument, bad enum value (`EX_USAGE`). */
  usage: 64,
  /** Input data malformed: unparseable or invalid `metadata.json` (`EX_DATAERR`). */
  data: 65,
  /** A required resource is missing — e.g. a subcommand's module is not built (`EX_UNAVAILABLE`). */
  unavailable: 69,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error carrying the exit code the process should end with. */
export class CliError extends Error {
  readonly code: ExitCode;

  constructor(message: string, code: ExitCode = EXIT.failure) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}
