// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `enrich` as a CI cache sees it, minus the CLI: one pass is a refresh plus the
// hand-off, and the next pass starts from the plane that hand-off wrote. Tests
// that need a second run to know what the first one did go through this, so the
// plane they carry is the real one, read back through the real loader.
import fs from "node:fs";
import path from "node:path";

import { enrichIndex, type EnrichOptions, type EnrichResult, type GrimRunner } from "../../src/enrich/index.js";
import { BlobStore } from "../../src/state/blobstore.js";
import { handOff } from "../../src/state/collect.js";
import { STATE_DIR, type Handoff } from "../../src/state/handoff.js";
import { loadPlane, loadPlaneFrom, type LoadedPlane } from "../../src/state/restore.js";

export interface Pass {
  result: EnrichResult;
  handoff: Handoff;
  plane: LoadedPlane;
}

export function pipeline(root: string, clock: () => number) {
  const state = path.join(root, STATE_DIR);
  let store = new BlobStore(state);
  let plane: LoadedPlane | null = null;

  return {
    /** The plane the next pass starts from. Tests edit its stamps to stage a state. */
    get plane(): LoadedPlane {
      if (plane === null) throw new Error("no pass has run");
      return plane;
    },
    get store(): BlobStore {
      return store;
    },
    state,

    async pass(run: GrimRunner, over: Partial<EnrichOptions> = {}): Promise<Pass> {
      const result = await enrichIndex({ root, run, store, plane: plane ?? undefined, clock, concurrency: 1, ...over });
      const handoff = handOff(root, store, { now: new Date(clock()), published: null, restored: plane, run: result });
      plane = loadPlane(store, handoff.planes.enrich!);
      if (plane === null) throw new Error("the plane just written does not load");
      return { result, handoff, plane };
    },

    /**
     * A runner change: the blob store is gone, the plane comes back from the
     * hand-off's own files (standing in for the site's `c/` tree).
     */
    loseStore(handoff: Handoff): void {
      fs.rmSync(path.join(state, "b"), { recursive: true, force: true });
      store = new BlobStore(state);
      const read = (kind: "p" | "s", sha: string): Buffer | null => {
        try {
          return fs.readFileSync(path.join(state, "out", "c", kind, "sha256", `${sha}.json`));
        } catch {
          return null;
        }
      };
      plane = loadPlaneFrom(read, handoff.planes.enrich!);
      if (plane === null) throw new Error("the hand-off's plane does not load");
    },
  };
}
