// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-017, IX-R41; spec §5.1 "Blob naming".
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sha256Hex } from "../emit/digest.js";
import type { BlobRef } from "../emit/root.js";
import { READ_FLAGS, readRegular } from "../marketplace/read.js";

/** Companion files are truncated to this on ingest, before they are hashed. */
export const BLOB_CAP = 1024 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;

/** `{sha256, size}` with a lowercase 64-hex digest and a positive safe integer size, else `null`. */
export function asBlobRef(v: unknown): BlobRef | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const { sha256, size } = v as Record<string, unknown>;
  if (typeof sha256 !== "string" || !HEX64.test(sha256)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;
  return { sha256, size };
}

/**
 * The bytes of `file` when they hash to `sha256` and fit `max`; `null` for
 * anything else, a symlink and a missing file included. Every read of cached
 * state goes through here: a cache file is only as trustworthy as its hash.
 */
export function readHashed(file: string, sha256: string, max: number): Buffer | null {
  const read = readRegular(file, max);
  return "bytes" in read && sha256Hex(read.bytes) === sha256 ? read.bytes : null;
}

/**
 * Up to `cap` bytes from the head of a regular file, else `null`. Opened with
 * `O_NOFOLLOW`, so a companion that is a link reads nothing, and sized from the
 * descriptor, so a file far over the cap is never read whole.
 */
export function readHead(file: string, cap: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, READ_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const buf = Buffer.alloc(Math.min(stat.size, cap));
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The reference `BlobStore.put` would return for `bytes`, without storing them. */
export function blobRefOf(bytes: Uint8Array, cap = BLOB_CAP): BlobRef {
  const body = bytes.length > cap ? bytes.subarray(0, cap) : bytes;
  return { sha256: sha256Hex(body), size: body.length };
}

/** Pipeline-local content store at `<state>/b/sha256/<hh>/<hex>`; never published. */
export class BlobStore {
  private unwritable = false;

  constructor(readonly stateDir: string) {}

  private file(sha256: string): string {
    return path.join(this.stateDir, "b", "sha256", sha256.slice(0, 2), sha256);
  }

  /** Truncate to `cap`, then hash and store. Plane files pass their own, larger, cap. */
  put(bytes: Uint8Array, cap = BLOB_CAP): BlobRef {
    const body = bytes.length > cap ? bytes.subarray(0, cap) : bytes;
    const sha256 = sha256Hex(body);
    const file = this.file(sha256);
    // A present blob is kept only if it still hashes: a swapped file under its own name is healed here.
    if (readHashed(file, sha256, cap) === null) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Rename within one directory, so a reader never sees half a blob.
        const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
        fs.writeFileSync(tmp, body);
        try {
          fs.renameSync(tmp, file);
        } catch (err) {
          fs.rmSync(tmp, { force: true });
          throw err;
        }
      } catch (err) {
        // A restored cache can be damaged past reading. The blob is then simply not cached: the next run finds it missing and fetches it again.
        if (!this.unwritable) console.warn(`warn: the blob store is not writable (${err instanceof Error ? err.message : String(err)}) — blobs are not cached this run`);
        this.unwritable = true;
      }
    }
    return { sha256, size: body.length };
  }

  /** Remove one blob (`--purge`); a digest off the plane is validated before it names a path. Absent is fine. */
  delete(sha256: string): void {
    if (HEX64.test(sha256)) this.remove(this.file(sha256), false);
  }

  /** Empty the store (`--fresh`). */
  clear(): void {
    this.remove(path.join(this.stateDir, "b"), true);
  }

  /** A file where a directory belongs makes `rmSync` fail ENOTDIR, but then there is nothing to remove. */
  private remove(target: string, recursive: boolean): void {
    try {
      fs.rmSync(target, { recursive, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
    }
  }

  /** Re-hashed on every read; a mismatch counts as missing. A digest off the plane is validated before it names a path. */
  get(sha256: string, max = BLOB_CAP): Buffer | null {
    return HEX64.test(sha256) ? readHashed(this.file(sha256), sha256, max) : null;
  }
}
