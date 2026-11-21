import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { ApiError, agentRoute, intParam, parseBody } from "@/lib/agent-auth";
import { renderMaterials } from "@/lib/render";
import { getApplicationByJob, iso, logEvent } from "@/lib/logic";

const Body = z.object({
  resume_version: z.enum(["resume", "cv"]),
  resume_md: z.string().min(50),
  cover_letter_md: z.string().min(50),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
});

export const POST = agentRoute(async (req, params) => {
  const jobId = intParam(params.id);
  const b = await parseBody(req, Body);
  const app = getApplicationByJob(jobId);
  if (!app) throw new ApiError(404, "job not found");
  // "approved" (in the apply queue) may be refreshed too: scripts/batch-prepare.ts `refresh` rewrites queued jobs'
  // materials with a stronger model before the apply agent sends them.
  if (app.stage !== "found" && app.stage !== "approved") throw new ApiError(409, `materials can only be set while the application is "found" or "approved" (it is "${app.stage}")`);
  // A refresh with no screening answers keeps the ones already there.
  const answers = b.answers.length || app.stage === "found" ? b.answers : (app.answers ?? []);

  const rendered = await renderMaterials(jobId, b.resume_md, b.cover_letter_md, b.resume_version);
  db.update(schema.applications)
    .set({
      resumeVersion: b.resume_version,
      resumeMd: b.resume_md,
      coverLetterMd: b.cover_letter_md,
      answers,
      resumePath: rendered.resumePath,
      coverLetterPath: rendered.coverLetterPath,
      materialsUpdatedAt: iso(),
    })
    .where(eq(schema.applications.id, app.id))
    .run();
  logEvent({ applicationId: app.id, type: "note", title: app.stage === "approved" ? "Materials refreshed" : "Materials ready", detail: `Tailored ${b.resume_version}, cover letter, ${answers.length} screening answers` });
  return { application_id: app.id, files: rendered.files, queued: true };
});
