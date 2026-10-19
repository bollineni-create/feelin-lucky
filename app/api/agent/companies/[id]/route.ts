import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { ApiError, agentRoute, intParam, parseBody } from "@/lib/agent-auth";
import { iso } from "@/lib/logic";

const Body = z.object({
  careers_url: z.string().url().nullable().optional(),
  ats_type: z.string().max(60).nullable().optional(),
  last_scanned_at: z.string().optional(),
  scanned: z.boolean().optional(),
});

export const PATCH = agentRoute(async (req, params) => {
  const id = intParam(params.id);
  const b = await parseBody(req, Body);
  const company = db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
  if (!company) throw new ApiError(404, "company not found");
  const patch: Partial<typeof schema.companies.$inferInsert> = {};
  if (b.careers_url !== undefined) patch.careersUrl = b.careers_url;
  if (b.ats_type !== undefined) patch.atsType = b.ats_type;
  if (b.last_scanned_at) patch.lastScannedAt = b.last_scanned_at;
  else if (b.scanned) patch.lastScannedAt = iso();
  if (!Object.keys(patch).length) return { company, unchanged: true };
  const updated = db.update(schema.companies).set(patch).where(eq(schema.companies.id, id)).returning().get();
  return { company: updated };
});
