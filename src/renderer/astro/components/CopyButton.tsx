// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The copy-to-clipboard button a card wears under its install commands.
// Split out of `Catalog.tsx` with the card itself, so an index replacing
// `PackageCard.tsx` still gets the toast behaviour rather than reimplementing
// the custom event `Base.astro` listens for.
import { useState } from "preact/hooks";
import { Check, FolderRoot, Globe } from "lucide-preact";

export function CopyButton({
  command,
  variant = "default",
  name,
}: {
  command: string;
  variant?: "default" | "global";
  /** What the copy toast calls this, e.g. `"global install command"`. */
  name?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      // The toast lives in Base.astro's inline script, outside this island —
      // an event is how a hydrated component reaches it without either side
      // importing the other.
      document.dispatchEvent(
        new CustomEvent("grimoire:copied", {
          detail: { name, value: command },
        }),
      );
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      class={copied ? "copy copied" : "copy"}
      title={command}
      aria-label={`Copy: ${command}`}
      // Out of the Tab sequence: the card is the stop, and the same command
      // is copyable from the detail page Enter opens.
      tabIndex={-1}
      onClick={copy}
    >
      {copied ? (
        <Check size={14} />
      ) : variant === "global" ? (
        <Globe size={14} />
      ) : (
        <FolderRoot size={14} />
      )}
    </button>
  );
}
