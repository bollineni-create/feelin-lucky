const COMPANY_SUFFIXES = /\b(inc|llc|ltd|corp|corporation|co|company|plc|group|holdings)\b\.?/g;

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normLocation(s: string | null | undefined): string {
  const l = norm(s)
    .replace(/\b(united states|usa|us)\b/g, "")
    .replace(/\b(wa|ma|ca|il|dc|ny)\b/g, "")
    .replace(/\b(metropolitan area|greater|area)\b/g, "")
    .trim()
    .replace(/\s+/g, " ");
  // "Remote" postings collapse to one bucket regardless of the region text around them.
  if (/\bremote\b/.test(l) && l.replace("remote", "").trim().length === 0) return "remote";
  return l;
}

/** normalized(company + title + location) — the same posting from LinkedIn and a careers site merges into one Job. */
export function dedupeKey(company: string, title: string, location?: string | null): string {
  const c = norm(company).replace(COMPANY_SUFFIXES, "").replace(/\s+/g, " ").trim();
  const t = norm(title);
  return [c, t, normLocation(location)].join("|");
}
