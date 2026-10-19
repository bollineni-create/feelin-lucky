import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { agentRoute, parseBody } from "@/lib/agent-auth";
import { dedupeKey } from "@/lib/dedupe";
import { changeStage, logEvent, thresholdFor } from "@/lib/logic";

const { jobs, applications, companies } = schema;

const JobIn = z.object({
  company: z.string().min(1),
  company_id: z.number().int().optional(),
  title: z.string().min(1),
  location: z.string().nullish(),
  work_mode: z.enum(["remote", "hybrid", "onsite"]).nullish(),
  source: z.enum(["careers", "linkedin"]),
  external_id: z.string().nullish(),
  url: z.string().nullish(),
  pay_text: z.string().nullish(),
  posted_at: z.string().nullish(),
  description: z.string().nullish(),
  fit_score: z.number().int().min(0).max(100).nullish(),
  fit_reasons: z.array(z.string()).max(5).nullish(),
  linkedin_status: z.string().nullish(),
});

const Body = z.object({ run_id: z.number().int().optional(), jobs: z.array(JobIn).min(1).max(200) });

type Result = { job_id: number; application_id: number; status: "created" | "updated" | "unchanged"; stage: string; dedupe_key: string; note?: string };

export const POST = agentRoute(async (req) => {
  const body = await parseBody(req, Body);
  const results: Result[] = [];

  for (const j of body.jobs) {
    const key = dedupeKey(j.company, j.title, j.location);
    const company =
      (j.company_id ? db.select().from(companies).where(eq(companies.id, j.company_id)).get() : undefined) ??
      db.select().from(companies).where(sql`lower(${companies.name}) = lower(${j.company})`).get();

    const existing = db.select().from(jobs).where(eq(jobs.dedupeKey, key)).get();
    let jobId: number;
    let status: Result["status"];
    let note: string | undefined;

    if (!existing) {
      const row = db
        .insert(jobs)
        .values({
          companyId: company?.id ?? null,
          companyName: company?.name ?? j.company,
          source: j.source,
          externalId: j.external_id ?? null,
          url: j.url ?? null,
          title: j.title,
          location: j.location ?? null,
          workMode: j.work_mode ?? null,
          payText: j.pay_text ?? null,
          postedAt: j.posted_at ?? null,
          description: j.description ?? null,
          fitScore: j.fit_score ?? null,
          fitReasons: j.fit_reasons ?? null,
          dedupeKey: key,
        })
        .returning()
        .get();
      jobId = row.id;
      status = "created";
      db.insert(applications).values({ jobId, stage: "found", linkedinStatus: j.linkedin_status ?? null }).run();
    } else {
      jobId = existing.id;
      // Fill gaps only; never overwrite what an earlier run recorded. A job is scored once.
      const patch: Partial<typeof jobs.$inferInsert> = {};
      if (!existing.url && j.url) patch.url = j.url;
      if (!existing.externalId && j.external_id) patch.externalId = j.external_id;
      if (!existing.workMode && j.work_mode) patch.workMode = j.work_mode;
      if (!existing.payText && j.pay_text) patch.payText = j.pay_text;
      if (!existing.postedAt && j.posted_at) patch.postedAt = j.posted_at;
      if (!existing.description && j.description) patch.description = j.description;
      if (!existing.companyId && company) patch.companyId = company.id;
      if (existing.fitScore == null && j.fit_score != null) {
        patch.fitScore = j.fit_score;
        patch.fitReasons = j.fit_reasons ?? null;
      } else if (existing.fitScore != null && j.fit_score != null && j.fit_score !== existing.fitScore) {
        note = "already scored; new score ignored";
      }
      // Prefer the careers-site URL when the same posting turns up on both.
      if (j.source === "careers" && existing.source === "linkedin" && j.url) {
        patch.url = j.url;
        patch.source = "careers";
      }
      if (Object.keys(patch).length) {
        db.update(jobs).set(patch).where(eq(jobs.id, jobId)).run();
        status = "updated";
      } else status = "unchanged";
      if (j.linkedin_status) db.update(applications).set({ linkedinStatus: j.linkedin_status }).where(eq(applications.jobId, jobId)).run();
    }

    const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    let app = db.select().from(applications).where(eq(applications.jobId, jobId)).get()!;

    // Under threshold → closed/low_fit so it is never re-scored.
    if (app.stage === "found" && job.fitScore != null && job.fitScore < thresholdFor(job.companyId)) {
      app = changeStage(app.id, "closed", { source: "agent", detail: `Fit ${job.fitScore} under threshold`, extra: { closedReason: "low_fit" } });
    } else if (status === "created" && job.fitScore != null) {
      logEvent({ applicationId: app.id, type: "note", title: `New match: ${job.title}`, detail: `Fit ${job.fitScore} · ${job.source === "linkedin" ? "LinkedIn" : "Careers site"}` });
    }

    results.push({ job_id: jobId, application_id: app.id, status, stage: app.stage, dedupe_key: key, ...(note ? { note } : {}) });
  }

  return {
    results,
    summary: {
      created: results.filter((r) => r.status === "created").length,
      updated: results.filter((r) => r.status === "updated").length,
      unchanged: results.filter((r) => r.status === "unchanged").length,
      closed_low_fit: results.filter((r) => r.stage === "closed").length,
    },
  };
});
