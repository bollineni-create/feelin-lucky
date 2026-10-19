export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  if (!iso) return "—";
  // A bare YYYY-MM-DD is a calendar date, not midnight UTC; don't shift it into Pacific time.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(dateOnly ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { ...opts, timeZone: dateOnly ? "UTC" : "America/Los_Angeles" });
}

export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
}

export function ago(iso: string | null | undefined) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

export const sourceLabel = (s: string) => (s === "linkedin" ? "LinkedIn" : "Careers site");
export const modeLabel = (m: string | null) => (m ? m[0].toUpperCase() + m.slice(1) : null);

/** "Los Angeles, CA" → "LA", "Seattle, WA" → "Seattle" for compact criteria lines. */
export function shortCity(l: string) {
  const city = l.replace(/,\s*[A-Z]{2}$/, "").trim();
  return ({ "Los Angeles": "LA", Washington: "DC", "Washington DC": "DC" } as Record<string, string>)[city] ?? city;
}
