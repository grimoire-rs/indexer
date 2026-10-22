// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Preloaded with `node --import`: moves the clock forward by BENCH_CLOCK_SHIFT_MS.
// scripts/bench-scale.mjs uses it to run the warm `enrich` one revalidate window
// after the cold one; inside the window no bucket is due and a warm run costs 0 calls.
const shift = Number(process.env.BENCH_CLOCK_SHIFT_MS ?? 0);
const Real = Date;

globalThis.Date = class extends Real {
  constructor(...args) {
    if (args.length === 0) super(Real.now() + shift);
    else super(...args);
  }

  static now() {
    return Real.now() + shift;
  }
};
