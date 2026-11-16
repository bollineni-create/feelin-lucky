"use client";

import { useState } from "react";

/** Copies `text` to the clipboard (the apply prompt for Claude or a Grok bot). */
export function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  const [done, setDone] = useState<string | null>(null);
  return (
    <span className="btn-row">
      <button
        type="button"
        className={`btn ${primary ? "btn-primary" : ""}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone("Copied. Paste it into Claude or your Grok bot.");
          } catch {
            setDone("Couldn't reach the clipboard; the prompt is at the top of APPLY-QUEUE.md.");
          }
        }}
      >
        {label}
      </button>
      {done ? <span className="small secondary" role="status">{done}</span> : null}
    </span>
  );
}
