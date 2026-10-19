import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { ApiError, agentRoute, parseBody } from "@/lib/agent-auth";
import { logEvent } from "@/lib/logic";

const Body = z.object({
  application_id: z.number().int().optional(),
  job_id: z.number().int().optional(),
  type: z.enum(["status_change", "email", "portal_update", "note"]),
  title: z.string().min(1).max(200),
  detail: z.string().max(4000).nullish(),
  at: z.string().optional(),
});

export const POST = agentRoute(async (req) => {
  const b = await parseBody(req, Body);
  let appId = b.application_id ?? null;
  if (!appId && b.job_id) {
    appId = db.select().from(schema.applications).where(eq(schema.applications.jobId, b.job_id)).get()?.id ?? null;
  }
  if (appId && !db.select().from(schema.applications).where(eq(schema.applications.id, appId)).get()) {
    throw new ApiError(404, "application not found");
  }
  const event = logEvent({ applicationId: appId, type: b.type, title: b.title, detail: b.detail ?? null, source: "agent", at: b.at });
  return { event };
});
