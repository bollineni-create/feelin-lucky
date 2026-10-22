/**
 * The user's current employer. Jobs there are earmarked "apply internally": found, scored and prepared like any
 * other, but never submitted by the agent. The user applies through the employer's own job site and marks the
 * application applied. Pure name matching lives here so it can be tested without the database.
 */

/** "JPMorgan Chase & Co." → "jpmorganchase"; "J.P. Morgan" → "jpmorgan". Drops punctuation, spaces and legal suffixes. */
export function normalizeCompanyName(name: string) {
  return name
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|limited|plc|co|corp|corporation|company|group|holdings|and)\b/g, "")
    .replace(/&/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Whether a job's company is the current employer: same name once normalized, or one contains the other
 * ("JPMorgan Chase" matches "JPMorgan Chase & Co." and "J.P. Morgan"; "Morgan Stanley" does not). Short names
 * (under 4 characters) must match exactly so "GE" doesn't claim every company with those letters. */
export function isSameEmployer(employer: string | null | undefined, companyName: string | null | undefined) {
  if (!employer || !companyName) return false;
  const a = normalizeCompanyName(employer);
  const b = normalizeCompanyName(companyName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.includes(b) || b.includes(a);
}
