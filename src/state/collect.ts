// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R35, spec §6.10 "hand off". The end of `enrich`: the `enrich/` working
// tree becomes the enrich plane, the plane goes into the store and into
// `<state>/out/`, and `handoff.json` tells the offline `build` what to publish.
import fs from "node:fs";
import path from "node:path";

import type { EnrichResult } from "../enrich/index.js";
import { packMarketplace } from "../enrich/marketplace.js";
import { serializeDeterministic } from "../emit/serialize.js";
import { nextGeneration, publishedTooFarAhead, type BlobRef, type Root } from "../emit/root.js";
import { BLOB_CAP, BlobStore } from "./blobstore.js";
import { collectEntries } from "./entries.js";
import { STATE_DIR, writeHandoff, type Handoff } from "./handoff.js";
import { SHARD_CAP, emitPlane } from "./plane.js";
import type { LoadedPlane } from "./restore.js";
import { formatKey, nextEpoch } from "./statekey.js";

export interface HandOffContext {
  now: Date;
  /** The root the anchor read, if any. */
  published: Root | null;
  /** The plane this run started from, if any: its `state_epoch` carries on. */
  restored: LoadedPlane | null;
  /** `--fresh` or `--purge`: the state epoch starts over. */
  renew?: boolean;
  /** What the refresh decided: the entries, bucket stamps, counters. Absent for a hand-off with no refresh behind it, which reads the tree. */
  run?: Pick<EnrichResult, "entries" | "stamps" | "counters">;
}

/** The marketplace export as one deterministic blob, or `null` when there is none or it would not fit. */
function marketplaceBlob(root: string, store: BlobStore): BlobRef | null {
  const packed = packMarketplace(path.join(root, "enrich", "marketplace"));
  if (packed === null) return null;
  const bytes = Buffer.from(serializeDeterministic(packed));
  if (bytes.length > BLOB_CAP) {
    console.warn(`warn: the marketplace export is ${bytes.length} bytes, over the ${BLOB_CAP} byte blob cap — it is not carried in the enrich plane`);
    return null;
  }
  return store.put(bytes);
}

export function handOff(root: string, store: BlobStore, ctx: HandOffContext): Handoff {
  const entries = ctx.run?.entries ?? collectEntries(root, (bytes) => store.put(bytes), undefined);
  // A restored plane without a usable epoch (`asIndex` dropped a non-integer one) starts a new one, like an absent plane.
  if (ctx.restored && ctx.restored.stateEpoch === undefined) console.warn("warn: the published enrich plane has no usable state_epoch — starting a new one");
  const stateEpoch = nextEpoch(ctx.restored?.stateEpoch, Math.floor(ctx.now.getTime() / 1000), ctx.renew === true);
  const plane = emitPlane(entries, { stamps: ctx.run?.stamps ?? {}, stateEpoch, marketplace: marketplaceBlob(root, store) });
  for (const bucket of plane.oversize) {
    console.warn(`warn: enrich shard ${bucket} is over ${SHARD_CAP} bytes and is left out of the plane — its refs build cold`);
  }

  const out = path.join(root, STATE_DIR, "out");
  let blobs = "";
  for (const file of plane.files) {
    store.put(file.bytes, SHARD_CAP);
    const dest = path.join(out, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.bytes);
    if (file.path === `c/p/sha256/${plane.ref.sha256}.json`) blobs = (JSON.parse(Buffer.from(file.bytes).toString("utf8")) as { blobs: string }).blobs;
  }

  const published = ctx.published?.generation;
  if (published !== undefined && publishedTooFarAhead(ctx.now, published)) {
    console.warn(`warn: the published generation ${published} is more than a day ahead of this clock — ignored, so the build second is used`);
  }
  const generation = nextGeneration(ctx.now, published);

  const handoff: Handoff = {
    generation,
    planes: { enrich: plane.ref },
    state_epoch: stateEpoch,
    next_key: formatKey(stateEpoch, blobs),
    // ponytail: the retention counters read 0 until the closure staging lands (I5), which also prints the build log line.
    counters: {
      retained_files: 0, retained_skipped: 0, failed_buckets: plane.oversize.length,
      probed: 0, deep: 0, calls: 0, probe_ms_p50: 0, deep_ms_p50: 0, budget_min: 0, throttled: 0, backoff_refs: 0, enrich: "complete",
      ...ctx.run?.counters,
    },
  };
  writeHandoff(root, handoff);
  return handoff;
}
