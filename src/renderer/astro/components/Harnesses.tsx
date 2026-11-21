// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The harnesses a package serves, one small badge each, in the record's order.
import { BrandMark } from "./BrandMark.js";
import { CLAWD } from "../lib/commands.js";
import { validServes } from "../lib/catalog.js";

/**
 * Only `claude` has a mark. There is none for OpenCode: no licence basis is
 * recorded for one. Every other name, known or not, is plain text.
 */
const MARKS: Readonly<Record<string, string>> = { claude: CLAWD };

/** Renders nothing for a record without a valid `serves`. */
export function Harnesses({ serves }: { serves: unknown }) {
  const names = validServes(serves);
  if (!names) return null;
  return (
    <span class="harnesses" role="group" aria-label={`Serves ${names.join(", ")}`}>
      {names.map((name) => (
        <span class="harness" data-harness={name} key={name}>
          {Object.hasOwn(MARKS, name) && <BrandMark path={MARKS[name]!} size={12} />}
          {name}
        </span>
      ))}
    </span>
  );
}
