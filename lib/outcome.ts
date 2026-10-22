import type { Application } from "@/db/schema";

/**
 * Why an application closed. "rejected": the employer said no. "declined": you didn't take it (turned down an
 * interview or offer, or withdrew). "posting_closed": it stopped taking applications. "skipped" and "low_fit" are
 * jobs never pursued, kept off the board.
 */
export const CLOSED_REASONS = ["rejected", "declined", "posting_closed", "skipped", "low_fit"] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export const CLOSED_REASON_LABEL: Record<ClosedReason, string> = {
  rejected: "Rejected",
  declined: "You didn't take it",
  posting_closed: "Posting closed",
  skipped: "Skipped",
  low_fit: "Low fit",
};

// The other words the agent, older data or you have used for the same reasons.
const REASON_ALIASES: Record<string, ClosedReason> = {
  reject: "rejected", rejection: "rejected", not_selected: "rejected", not_moving_forward: "rejected",
  decline: "declined", withdrawn: "declined", withdrew: "declined", withdraw: "declined", not_taken: "declined",
  didnt_take: "declined", turned_down: "declined", declined_offer: "declined", offer_declined: "declined",
  closed: "posting_closed", posting_removed: "posting_closed", no_longer_accepting: "posting_closed",
};

/** A closed reason in one of the known words, or the text as given (lower case, underscores) if it's none of them. */
export function normalizeClosedReason(reason: string | null | undefined): string | null {
  const r = reason?.trim().toLowerCase().replace(/['’]/g, "").replace(/[\s-]+/g, "_");
  if (!r) return null;
  return (CLOSED_REASONS as readonly string[]).includes(r) ? r : (REASON_ALIASES[r] ?? r);
}

/** The reason a closed application reads as, for the board and the job page. */
export function closedReasonLabel(reason: string | null | undefined) {
  const r = normalizeClosedReason(reason);
  if (!r) return "Closed";
  return CLOSED_REASON_LABEL[r as ClosedReason] ?? r.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Where a closed application belongs: rejected, not taken by you, never pursued, or closed for another reason. */
export function closedOutcome(a: Pick<Application, "stage" | "closedReason">): "rejected" | "declined" | "not_pursued" | "other" | null {
  if (a.stage !== "closed") return null;
  const r = normalizeClosedReason(a.closedReason);
  if (r === "rejected" || r === "declined") return r;
  if (r === "skipped" || r === "low_fit") return "not_pursued";
  return "other";
}
