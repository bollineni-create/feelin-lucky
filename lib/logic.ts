import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "./db";
import type { Application, Job, Stage } from "@/db/schema";

const { applications, jobs, events, companies, searchCriteria, profile, runs } = schema;

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

export type AppWithJob = Application & { job: Job; companyHighlight: string | null; companyPriority: string | null; atsType: string | null };

export function listApplications(where?: ReturnType<typeof and>): AppWithJob[] {
  const rows = db
    .select({ app: applications, job: jobs, hl: companies.highlight, pr: companies.priority, ats: companies.atsType })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .leftJoin(companies, eq(jobs.companyId, companies.id))
    .where(where)
    .orderBy(desc(applications.stageChangedAt))
    .all();
  return rows.map((r) => ({ ...r.app, job: r.job, companyHighlight: r.hl, companyPriority: r.pr, atsType: r.ats }));
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
      return order(x) - order(y) || (y.job.fitScore ?? 0) - (x.job.fitScore ?? 0);
    });
}

export function latestRuns(limit = 8) {
  return db.select().from(runs).orderBy(desc(runs.startedAt)).limit(limit).all();
}

export function activeRun() {
  // A run still "running" after 3 hours is treated as dead.
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.status, "running"), sql`${runs.startedAt} > ${iso(new Date(Date.now() - 3 * 3_600_000))}`))
    .get();
}
