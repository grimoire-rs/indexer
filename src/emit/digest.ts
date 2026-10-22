// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { createHash } from "node:crypto";

/** The lowercase hex SHA-256 of `data`; a string is hashed as UTF-8. */
export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
