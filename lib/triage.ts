// Triage: a cheap, rule-based guess at how promising an unscored job is, so the agent spends its scoring time on the
// best ones first. It isn't the fit score (the agent gives that, reading the posting) and never closes a job on its
// own; it only orders `jobs_needing_score` and decides which ones wait for a later run when there are more than a run
// can score (a first job-board scan can bring in a thousand).

export type TriageInput = {
  title: string;
  location: string | null;
  workMode: string | null;
  postedAt: string | null;
  priority: string | null; // the company's watchlist priority, null off the watchlist
  lookupId: number | null;
};
export type TriageCriteria = { primaryLocations: string[]; secondaryLocations: string[]; workModes: string[]; lookbackDays: number };

/** Title phrases that are squarely the user's core functions, and ones that are near them. A broad "finance" or
 * "strategy" match gets neither. */
const CORE = /\b(treasury|treasurer|corporate development|corp dev|m&a|mergers|strategic finance|fp&a|financial planning|payments?|cash management|liquidity|capital markets|corporate banking|commercial banking|banker)\b/i;
const NEAR = /\b(strategy (and|&) operations|business operations|bizops|partnerships?|chief of staff|corporate strategy|product manager|strategic initiatives)\b/i;
const TOO_SENIOR = /\b(chief|head of|svp|evp|senior vice president|executive vice president|managing director|executive director|(sr\.?|senior) director|director|general manager|partner)\b/i;
const NOT_SENIOR_ENOUGH = /\b(intern|internship|entry[- ]level|junior|jr\.?|new grad|graduate program|apprentice)\b/i;
const IN_RANGE = /\b(associate|analyst|manager|lead|senior|sr\.?|vp|vice president|specialist|strategist|principal)\b/i;

const city = (loc: string) => loc.split(",")[0].trim().toLowerCase();

export function triageScore(j: TriageInput, c: TriageCriteria, now = new Date()): number {
  if (j.lookupId != null) return 101; // the user asked for it: ahead of anything else
  let s = 40;
  const t = j.title;
  if (CORE.test(t)) s += 25;
  else if (NEAR.test(t)) s += 12;
  // "Partner" in "Partnerships Manager" isn't seniority.
  const senior = TOO_SENIOR.test(t.replace(/partnerships?/gi, ""));
  if (NOT_SENIOR_ENOUGH.test(t)) s -= 30;
  else if (senior && !/\bassociate director\b/i.test(t)) s -= 15;
  else if (IN_RANGE.test(t)) s += 5;

  const loc = (j.location ?? "").toLowerCase();
  if ((j.workMode === "remote" || /\bremote\b/.test(loc)) && c.workModes.includes("remote")) s += 10;
  else if (c.primaryLocations.some((l) => loc.includes(city(l)))) s += 10;
  else if (c.secondaryLocations.some((l) => loc.includes(city(l)))) s += 5;

  s += j.priority === "high" ? 10 : j.priority === "normal" ? 5 : 0;

  if (j.postedAt) {
    const age = (now.getTime() - Date.parse(j.postedAt)) / 86_400_000;
    if (age <= Math.max(c.lookbackDays, 7)) s += 10;
    else if (age > 45) s -= 10;
  }
  return Math.max(0, Math.min(100, s));
}
