// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// A `node:child_process` that records every command the code under test starts and then
// starts it. `vi.mock("node:child_process", async (real) => tapChildProcess(await real()))`
// installs it; the indexer reaches `grim` only through `execFile`, which `promisify` calls
// by its `custom` form, so that form is tapped as well.
import type * as ChildProcess from "node:child_process";
import { promisify } from "node:util";

/** The command of every process started since the last reset, in order. */
export const spawned: string[] = [];

type Starter = (command: unknown, ...rest: unknown[]) => unknown;

/** `grim`, bare or by path, as a program or at the head of a shell command line. */
const GRIM = /(^|[\\/\s])grim(\.exe|\.cmd)?(\s|$)/i;

/** The recorded commands that run `grim`. */
export const grimSpawns = (): string[] => spawned.filter((command) => GRIM.test(command));

export function tapChildProcess(real: typeof ChildProcess): typeof ChildProcess {
  const tap = (start: Starter): Starter => (command, ...rest) => {
    spawned.push(String(command));
    return start(command, ...rest);
  };
  const tapped: Record<string, unknown> = { ...real };
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
    tapped[name] = tap(real[name] as Starter);
  }
  const execFile = real.execFile as unknown as Record<symbol, Starter>;
  tapped.execFile = Object.assign(tapped.execFile as Starter, { [promisify.custom]: tap(execFile[promisify.custom] as Starter) });
  return tapped as typeof ChildProcess;
}
