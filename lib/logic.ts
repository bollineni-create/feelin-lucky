import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { ROOT, db, schema } from "./db";
import type { Application, Job, Stage } from "@/db/schema";
import { isSameEmployer } from "./employer";
import { portalHost } from "./signin";

const { applications, jobs, events, companies, searchCriteria, profile, runs, lookups } = schema;

export const FOLLOW_UP_DAYS = 14;
export const OPEN_STAGES: Stage[] = ["applied", "screening", "interviewing", "offer"];

export const iso = (d = new Date()) => d.toISOString();
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
export const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

export function getCriteria() {
  return db.select().from(searchCriteria).where(eq(searchCriteria.id, 1)).get()!;
}

export function getProfile() {
  return db.select().from(profile).where(eq(profile.id, 1)).get()!;
}

/** Where the user works now: the Settings value, or the profile's current work-history entry (no end date). */
export function currentEmployer(): string | null {
  const set = getCriteria().currentEmployer?.trim();
  if (set) return set;
  const cur = getProfile().workHistory.find((w) => !w.end);
  return cur?.employer?.trim() || null;
}

/** Jobs at the current employer are earmarked "apply internally": prepared, never submitted by the agent. */
export function isInternalJob(job: Pick<Job, "companyName">) {
  return isSameEmployer(currentEmployer(), job.companyName);
}

export function logEvent(e: { applicationId: number | null; type: EventType; title: string; detail?: string | null; source?: string; at?: string }) {
  return db
    .insert(events)
    .values({ applicationId: e.applicationId, type: e.type, title: e.title, detail: e.detail ?? null, source: e.source ?? "agent", at: e.at ?? iso() })
    .returning()
    .get();
}
type EventType = "status_change" | "email" | "portal_update" | "note";

export const STAGE_LABEL: Record<Stage, string> = {
  found: "Found",
  approved: "Approved",
  applied: "Applied",
  screening: "Screening",
  interviewing: "Interviewing",
  offer: "Offer",
  closed: "Closed",
};

/** Moves an application to a new stage and records a status_change event. */
export function changeStage(appId: number, to: Stage, opts: { source: string; detail?: string | null; extra?: Partial<Application> } = { source: "app" }) {
  const app = db.select().from(applications).where(eq(applications.id, appId)).get();
  if (!app) throw new Error(`application ${appId} not found`);
  const updated = db
    .update(applications)
    .set({ ...(opts.extra ?? {}), stage: to, stageChangedAt: iso() })
    .where(eq(applications.id, appId))
    .returning()
    .get();
  if (app.stage !== to) {
    logEvent({
      applicationId: appId,
      type: "status_change",
      title: `${STAGE_LABEL[app.stage]} → ${STAGE_LABEL[to]}`,
      detail: opts.detail ?? null,
      source: opts.source,
    });
  }
  return updated;
}

export function hasMaterials(a: Pick<Application, "resumeMd" | "coverLetterMd">) {
  return Boolean(a.resumeMd && a.coverLetterMd);
}

/** Threshold for a job, lower for high-priority companies (spec §6). */
export function thresholdFor(companyId: number | null) {
  const c = getCriteria();
  if (companyId) {
    const co = db.select({ priority: companies.priority }).from(companies).where(eq(companies.id, companyId)).get();
    if (co?.priority === "high") return c.highPriorityThreshold;
  }
  return c.fitThreshold;
}

/** Applied with no response after 14 days → next_action "Follow up". Idempotent. */
export function sweepFollowUps() {
  const cutoff = iso(daysAgo(FOLLOW_UP_DAYS));
  const stale = db
    .select()
    .from(applications)
    .where(and(eq(applications.stage, "applied"), isNotNull(applications.submittedAt), lt(applications.stageChangedAt, cutoff), isNull(applications.nextAction)))
    .all();
  for (const a of stale) {
    db.update(applications).set({ nextAction: "Follow up", nextActionDue: iso() }).where(eq(applications.id, a.id)).run();
  }
  return stale.length;
}

export type AppWithJob = Application & { job: Job; companyHighlight: string | null; companyPriority: string | null; atsType: string | null; internal: boolean };

/** Watchlist rank: high-priority (red) companies 0, other watchlist companies 1, everyone else 2. */
export function watchTier(a: Pick<AppWithJob, "companyPriority">) {
  return a.companyPriority === "high" ? 0 : a.companyPriority === "normal" ? 1 : 2;
}

/** Watchlist companies first, then fit score. */
/** The job board or portal an application goes through, from the company's ATS or the posting's host. */
export function portalOf(a: Pick<AppWithJob, "atsType"> & { job: Pick<AppWithJob["job"], "url" | "source"> }): string {
  const host = (a.job.url ?? "").toLowerCase();
  if (a.job.source === "linkedin" || host.includes("linkedin.com")) return "linkedin";
  const byHost: [RegExp, string][] = [
    [/greenhouse\.io/, "greenhouse"], [/lever\.co/, "lever"], [/ashbyhq\.com/, "ashby"], [/smartrecruiters\.com/, "smartrecruiters"],
    [/myworkday(?:jobs)?\.com/, "workday"], [/oraclecloud\.com|taleo\.net/, "oracle"], [/eightfold\.ai/, "eightfold"],
    [/successfactors\.com/, "successfactors"], [/icims\.com/, "icims"], [/paylocity\.com/, "paylocity"],
  ];
  return byHost.find(([re]) => re.test(host))?.[1] ?? a.atsType ?? "custom";
}

/** Phase A order: quick boards first, then unknown portals, then the ones that want an account (the agent
 * usually has to flag those), with items already flagged "needs sign-in" last so an untouched item never
 * waits behind one the user hasn't signed in to yet. Ties keep the oldest approval first. */
const PORTAL_RANK: Record<string, number> = { linkedin: 0, greenhouse: 0, lever: 0, ashby: 0, smartrecruiters: 0, custom: 1, workday: 2, oracle: 2, taleo: 2, eightfold: 2, successfactors: 2, icims: 2 };
export const bySubmitOrder = (x: AppWithJob, y: AppWithJob) =>
  Number(x.needsSignin) - Number(y.needsSignin) || (PORTAL_RANK[portalOf(x)] ?? 1) - (PORTAL_RANK[portalOf(y)] ?? 1) || x.stageChangedAt.localeCompare(y.stageChangedAt);

/** Portals that want an account before they take an application (each Workday or Oracle tenant is its own). */
export const ACCOUNT_PORTALS = ["workday", "oracle", "taleo", "eightfold", "successfactors", "icims", "paylocity"];
/** Boards that take an application without an account: these are the ones the agent can send today. */
export const QUICK_PORTALS = ["linkedin", "greenhouse", "lever", "ashby", "smartrecruiters"];

/**
 * The job sites where approved applications wait on an account: those already flagged "needs sign-in", plus
 * those on account portals the agent hasn't tried yet. One entry per site, so the user makes each account once.
 */
export function accountsNeeded() {
  const sites = new Map<string, { host: string; portal: string; companies: string[]; count: number; flagged: number; url: string | null; flaggedAppId: number | null }>();
  for (const a of listApplications(eq(applications.stage, "approved")).sort(bySubmitOrder)) {
    if (a.internal) continue;
    const portal = portalOf(a);
    if (!a.needsSignin && !ACCOUNT_PORTALS.includes(portal)) continue;
    const host = portalHost(a.job.url, a.job.companyName);
    const s = sites.get(host) ?? { host, portal, companies: [], count: 0, flagged: 0, url: a.job.url, flaggedAppId: null };
    s.count++;
    if (a.needsSignin) {
      s.flagged++;
      s.flaggedAppId ??= a.id;
    }
    if (!s.companies.includes(a.job.companyName)) s.companies.push(a.job.companyName);
    sites.set(host, s);
  }
  return [...sites.values()].sort((x, y) => y.count - x.count || x.host.localeCompare(y.host));
}

/** Clears "needs sign-in" on every approved application on the same portal as `a` (one sign-in covers them all). */
export function clearSigninOnPortal(a: Pick<AppWithJob, "job">) {
  const host = portalHost(a.job.url, a.job.companyName);
  const ids = listApplications(and(eq(applications.stage, "approved"), eq(applications.needsSignin, true)))
    .filter((x) => portalHost(x.job.url, x.job.companyName) === host)
    .map((x) => x.id);
  if (ids.length) db.update(applications).set({ needsSignin: false, signinCheckedAt: null }).where(inArray(applications.id, ids)).run();
  return ids.length;
}

export const byWatchlistThenScore =(x: AppWithJob, y: AppWithJob) => watchTier(x) - watchTier(y) || (y.job.fitScore ?? 0) - (x.job.fitScore ?? 0);

/** Phase C order: watchlist tier, then jobs on boards that take an application without an account (the agent can
 * send those today), then fit score. */
export const byWatchlistQuickThenScore = (x: AppWithJob, y: AppWithJob) =>
  watchTier(x) - watchTier(y) || Number(!QUICK_PORTALS.includes(portalOf(x))) - Number(!QUICK_PORTALS.includes(portalOf(y))) || (y.job.fitScore ?? 0) - (x.job.fitScore ?? 0);

export function listApplications(where?: ReturnType<typeof and>): AppWithJob[] {
  const rows = db
    .select({ app: applications, job: jobs, hl: companies.highlight, pr: companies.priority, ats: companies.atsType })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .leftJoin(companies, eq(jobs.companyId, companies.id))
    .where(where)
    .orderBy(desc(applications.stageChangedAt))
    .all();
  const employer = currentEmployer();
  return rows.map((r) => ({ ...r.app, job: r.job, companyHighlight: r.hl, companyPriority: r.pr, atsType: r.ats, internal: isSameEmployer(employer, r.job.companyName) }));
}

export function getApplication(appId: number): AppWithJob | undefined {
  return listApplications(eq(applications.id, appId))[0];
}

export function getApplicationByJob(jobId: number): AppWithJob | undefined {
  return listApplications(eq(applications.jobId, jobId))[0];
}

/** Today's queue: new matches with materials, plus today's approvals/skips so they can be undone. */
export function queueItems() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const all = listApplications(inArray(applications.stage, ["found", "approved", "closed"]));
  return all
    .filter((a) => {
      if (a.stage === "found") return a.job.fitScore != null && hasMaterials(a);
      if (a.stage === "approved") return true;
      return a.closedReason === "skipped" && a.stageChangedAt >= iso(startOfDay);
    })
    .sort((x, y) => {
      const order = (a: AppWithJob) => (a.stage === "found" ? 0 : a.stage === "approved" ? 1 : 2);
      return order(x) - order(y) || byWatchlistThenScore(x, y);
    });
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Why a found application may not be auto-applied, or null if it may. */
export function autoApplyBlocker(a: AppWithJob): string | null {
  const c = getCriteria();
  if (!c.autoApply) return "auto-apply is off";
  if (!getProfile().confirmed) return "profile is not confirmed";
  if (a.stage !== "found") return `stage is "${a.stage}"`;
  if (a.internal) return "it's at your current employer: apply through the internal job site";
  if (!hasMaterials(a) || !a.resumePath) return "materials are not ready";
  if (a.needsSignin) return "portal needs sign-in";
  if (!c.autoApplySources.includes(a.job.source)) return `auto-apply is off for ${a.job.source} jobs`;
  const min = Math.max(c.autoApplyMinScore, thresholdFor(a.job.companyId));
  if (a.job.fitScore == null || a.job.fitScore < min) return `fit score below ${min}`;
  const text = [a.resumeMd, a.coverLetterMd, ...(a.answers ?? []).map((q) => q.answer)].join("\n");
  if (text.includes("[NEEDS YOU")) return "an answer needs your input";
  return null;
}

/** Auto-applications submitted since local midnight. */
export function autoAppliedToday() {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(applications)
    .where(and(eq(applications.autoApplied, true), sql`${applications.submittedAt} >= ${iso(startOfToday())}`))
    .get()!.n;
}

/** Found applications the agent may submit without a Queue approval, watchlist companies first, within today's cap. */
export function autoApplyCandidates(): AppWithJob[] {
  const c = getCriteria();
  if (!c.autoApply) return [];
  const remaining = Math.max(0, c.autoApplyDailyCap - autoAppliedToday());
  return listApplications(eq(applications.stage, "found"))
    .filter((a) => autoApplyBlocker(a) == null)
    .sort(byWatchlistThenScore)
    .slice(0, remaining);
}

export function latestRuns(limit = 8) {
  return db.select().from(runs).orderBy(desc(runs.startedAt)).limit(limit).all();
}

type RunRow = typeof runs.$inferSelect;

// How a run reads when something other than the agent closed it: the script's signal trap, its watchdog, its
// exit check, or the app finding the script gone (closeDeadRuns below).
const INTERRUPTED = /^(Stopped (before it finished|at the \d+-minute limit)|The agent exited .* without closing the run|The run stopped without closing)/;

/**
 * A run that stopped before the agent reached its end-of-run report: stopped from the app, by the time limit,
 * by a crash or a restart, while it was in a phase. Its `note` says the item it was on; the next run can
 * finish from that phase (see resumePhases).
 */
export function runUnfinished(run: Pick<RunRow, "status" | "currentPhase" | "errors">) {
  return run.status === "failed" && !!run.currentPhase && (run.errors ?? []).some((e) => INTERRUPTED.test(e));
}

/** The phases left when a run stopped in `currentPhase`: that phase and the ones after it, in run order. */
export function resumePhases(run: Pick<RunRow, "phase" | "currentPhase">): string[] {
  const phases = run.phase.split(",").map((p) => p.trim()).filter(Boolean);
  const at = run.currentPhase ? phases.indexOf(run.currentPhase) : -1;
  return at >= 0 ? phases.slice(at) : phases;
}

/** The most recent run that is over, with what it left unfinished, for the agent's context and the Pipeline page. */
export function lastFinishedRun() {
  const run = db.select().from(runs).where(ne(runs.status, "running")).orderBy(desc(runs.id)).limit(1).get();
  if (!run) return null;
  const unfinished = runUnfinished(run);
  return { run, unfinished, phasesLeft: unfinished ? resumePhases(run) : [] };
}

const RUN_LOCK = path.join(ROOT, "logs", ".run.lock");

// Alive and not a zombie (a killed process its parent hasn't reaped yet).
const alive = (pid: number) => {
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
  }
};

/** The pid of the scripts/daily-run.sh process that holds the run lock, if it's still alive. */
export function runProcess(): { pid: number; runId: number | null } | null {
  const read = (f: string) => {
    try {
      return Number(fs.readFileSync(path.join(RUN_LOCK, f), "utf8").trim()) || null;
    } catch {
      return null;
    }
  };
  const pid = read("pid");
  if (pid && alive(pid)) return { pid, runId: read("run_id") };
  if (pid) return null;
  // A script from before the lock held a pid.
  try {
    const found = Number(execFileSync("pgrep", ["-f", "scripts/daily-run.sh"], { encoding: "utf8" }).split("\n")[0]);
    return found ? { pid: found, runId: null } : null;
  } catch {
    return null;
  }
}

/** Closes runs left at "running" whose script is gone (the app or Mac restarted under it, or it was killed). */
function closeDeadRuns() {
  const open = db.select().from(runs).where(eq(runs.status, "running")).orderBy(runs.id).all();
  if (open.length === 0) return;
  const proc = runProcess();
  // The script creates the run record a moment before it writes run_id; give a new run that long.
  const grace = iso(new Date(Date.now() - 2 * 60_000));
  for (const r of open) {
    const live = proc && (proc.runId == null ? r.id === open[open.length - 1].id : proc.runId === r.id);
    if (live || r.startedAt > grace) continue;
    db.update(runs)
      .set({ status: "failed", finishedAt: iso(), errors: [...(r.errors ?? []), "The run stopped without closing (the app or Mac restarted under it, or it was stopped)."] })
      .where(eq(runs.id, r.id))
      .run();
  }
}

export function activeRun() {
  closeDeadRuns();
  // A run still "running" after 3 hours is treated as dead.
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.status, "running"), sql`${runs.startedAt} > ${iso(new Date(Date.now() - 3 * 3_600_000))}`))
    .orderBy(desc(runs.startedAt))
    .get();
}

/** What the database shows a run actually did, independent of the counts the agent reports about itself. */
export function runActivity(run: Pick<typeof runs.$inferSelect, "startedAt" | "finishedAt">) {
  const from = run.startedAt;
  const to = run.finishedAt ?? iso();
  const scanned = db
    .select({ n: sql<number>`count(*)` })
    .from(companies)
    .where(and(sql`${companies.lastScannedAt} >= ${from}`, sql`${companies.lastScannedAt} <= ${to}`))
    .get()!.n;
  const found = db
    .select({ source: jobs.source, n: sql<number>`count(*)` })
    .from(jobs)
    .where(and(sql`${jobs.firstSeenAt} >= ${from}`, sql`${jobs.firstSeenAt} <= ${to}`))
    .groupBy(jobs.source)
    .all();
  const bySource = Object.fromEntries(found.map((r) => [r.source, r.n]));
  // Jobs this run scored under the fit threshold: found, but closed on arrival and kept off the board.
  const lowFit = db
    .select({ n: sql<number>`count(*)` })
    .from(applications)
    .where(and(eq(applications.stage, "closed"), eq(applications.closedReason, "low_fit"), sql`${applications.stageChangedAt} >= ${from}`, sql`${applications.stageChangedAt} <= ${to}`))
    .get()!.n;
  // Companies the agent left unscanned during this run, with the reason on the company (a site Claude in
  // Chrome won't open, a page that wouldn't load). The watchlist shows the note; the run just names them.
  const unscanned = db
    .select({ name: companies.name })
    .from(companies)
    .where(and(isNotNull(companies.scanNote), sql`${companies.scanNoteAt} >= ${from}`, sql`${companies.scanNoteAt} <= ${to}`))
    .orderBy(companies.name)
    .all()
    .map((c) => c.name);
  // Lookups (a title or company the user asked for) the agent settled during this run.
  const lookupsDone = db
    .select({ n: sql<number>`count(*)` })
    .from(lookups)
    .where(and(eq(lookups.status, "done"), sql`${lookups.doneAt} >= ${from}`, sql`${lookups.doneAt} <= ${to}`))
    .get()!.n;
  return {
    companies_scanned: scanned,
    companies_unscanned: unscanned,
    lookups_done: lookupsDone,
    jobs_found: found.reduce((s, r) => s + r.n, 0),
    jobs_found_careers: bySource.careers ?? 0,
    jobs_found_linkedin: bySource.linkedin ?? 0,
    jobs_closed_low_fit: lowFit,
  };
}

// ---------- Lookups: what the user asked the agent to look for next scan ----------

/** One line naming a lookup: "Head of Treasury at Brex", "Head of Treasury", "Brex". */
export function lookupLabel(l: Pick<schema.Lookup, "title" | "company">) {
  return l.title && l.company ? `${l.title} at ${l.company}` : (l.title ?? l.company ?? "");
}

/** Lookups still waiting for a scan, oldest first (the agent takes them in this order). */
export function pendingLookups() {
  return db.select().from(lookups).where(eq(lookups.status, "pending")).orderBy(lookups.createdAt, lookups.id).all();
}

/** Lookups the agent has settled, newest first, each with the jobs it posted for it. */
export function doneLookups(limit = 8) {
  const rows = db.select().from(lookups).where(eq(lookups.status, "done")).orderBy(desc(lookups.doneAt), desc(lookups.id)).limit(limit).all();
  return rows.map((l) => ({ ...l, jobs: listApplications(eq(jobs.lookupId, l.id)) }));
}

/** The watchlist company a lookup's company names, matched on the name, so the agent gets its careers page. */
export function matchCompany(name: string | null | undefined) {
  if (!name) return undefined;
  return db.select().from(companies).where(sql`lower(${companies.name}) = lower(${name.trim()})`).get();
}
