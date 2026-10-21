"use client";

import { useState, useTransition } from "react";

export function RunButton({ action, label, pendingLabel, primary, disabled, doneMessage = "Started — watch Chrome. The run log updates as it goes." }: {
  action: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>;
  label: string;
  pendingLabel: string;
  primary?: boolean;
  disabled?: boolean;
  doneMessage?: string;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="btn-row">
      <button
        type="button"
        className={`btn ${primary ? "btn-primary" : ""}`}
        disabled={pending || disabled}
        onClick={() =>
          start(async () => {
            const r = await action();
            setMsg(r.ok ? (r.message ?? doneMessage) : r.error);
          })
        }
      >
        {pending ? pendingLabel : label}
      </button>
      {msg ? <span className="small secondary" role="status">{msg}</span> : null}
    </span>
  );
}
