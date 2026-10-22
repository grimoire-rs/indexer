// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// A named pipe where a regular file should be. A plain `open(O_RDONLY)` on one
// blocks until a writer appears, and a synchronous block cannot be timed out
// from inside the test. A writer that shows up after `LATE_MS` ends the block,
// so a reader that waits fails the elapsed-time check instead of hanging.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

export const LATE_MS = 2000;
/** What a reader that does not wait finishes within, with a wide margin. */
export const PROMPT_MS = 1000;

export const canMakeFifo = process.platform !== "win32";

const writers: ChildProcess[] = [];

/** Makes `file` a FIFO and starts the late writer. */
export function plantFifo(file: string): void {
  execFileSync("mkfifo", [file]);
  // `<>` opens read-write, which never blocks and counts as a writer for a reader already waiting.
  const writer = spawn("sh", ["-c", `sleep ${LATE_MS / 1000}; exec 3<>"$1"`, "sh", file], { stdio: "ignore" });
  writers.push(writer);
}

/** Milliseconds `fn` takes. */
export function timed(fn: () => void): number {
  const start = Date.now();
  fn();
  return Date.now() - start;
}

export function reapWriters(): void {
  for (const w of writers.splice(0)) w.kill();
}
