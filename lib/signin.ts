// Approved applications whose portal wanted a sign-in. One sign-in covers every application on that portal (a
// Workday or Oracle tenant, LinkedIn), so the agent looks at one per portal, and only every few days: a wall it
// found yesterday is still there today unless the user signed in, and they say so with "I've signed in".

export const SIGNIN_RECHECK_DAYS = 3;

/** The portal's host (a Workday tenant, an Oracle pod, linkedin.com), or the company name when the URL has none. */
export function portalHost(url: string | null | undefined, companyName: string): string {
  try {
    const host = new URL(url ?? "").hostname.toLowerCase().replace(/^www\./, "");
    if (host) return host.endsWith("linkedin.com") ? "linkedin.com" : host;
  } catch {}
  return companyName.trim().toLowerCase();
}

type Flaggable = { needsSignin: boolean; signinCheckedAt: string | null; job: { url: string | null; companyName: string } };

export type SigninWait = { portal_host: string; count: number; companies: string[]; last_checked_at: string | null; recheck_after: string | null };

/**
 * Splits an approved list (already in submit order) into what the agent works on this run and what waits.
 * Unflagged items all go out. Of the flagged ones, a portal checked within SIGNIN_RECHECK_DAYS waits whole;
 * otherwise its first item goes out as the one to look at and the rest wait behind it.
 */
export function splitSigninWaits<T extends Flaggable>(items: T[], now = new Date()): { toSubmit: T[]; waiting: SigninWait[] } {
  const lastCheck = new Map<string, string | null>();
  for (const a of items) {
    if (!a.needsSignin) continue;
    const host = portalHost(a.job.url, a.job.companyName);
    const prev = lastCheck.get(host) ?? null;
    lastCheck.set(host, a.signinCheckedAt && (!prev || a.signinCheckedAt > prev) ? a.signinCheckedAt : prev);
  }
  const cutoff = new Date(now.getTime() - SIGNIN_RECHECK_DAYS * 86_400_000).toISOString();
  const probed = new Set<string>();
  const waits = new Map<string, SigninWait>();
  const toSubmit: T[] = [];
  for (const a of items) {
    if (!a.needsSignin) {
      toSubmit.push(a);
      continue;
    }
    const host = portalHost(a.job.url, a.job.companyName);
    const checked = lastCheck.get(host) ?? null;
    if (!probed.has(host) && (!checked || checked < cutoff)) {
      probed.add(host);
      toSubmit.push(a);
      continue;
    }
    const w = waits.get(host) ?? {
      portal_host: host,
      count: 0,
      companies: [],
      last_checked_at: checked,
      // null: one on this portal goes out this run, and these follow it once it gets through.
      recheck_after: probed.has(host) || !checked ? null : new Date(new Date(checked).getTime() + SIGNIN_RECHECK_DAYS * 86_400_000).toISOString(),
    };
    w.count++;
    if (!w.companies.includes(a.job.companyName)) w.companies.push(a.job.companyName);
    waits.set(host, w);
  }
  return { toSubmit, waiting: [...waits.values()] };
}
