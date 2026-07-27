// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The build-time bridge. `buildSite` replaces `__GRIMOIRE_DATA__` with a
// JSON literal through Vite `define`, so this module is server-only by
// construction — importing it from a hydrated island would inline the
// whole catalog into the client bundle. Islands take what they need as props.
import type { GrimoireData } from "../../types.js";

declare const __GRIMOIRE_DATA__: GrimoireData;

export const data: GrimoireData = __GRIMOIRE_DATA__;
