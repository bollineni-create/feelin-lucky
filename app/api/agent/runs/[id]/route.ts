import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { ApiError, agentRoute, intParam, parseBody } from "@/lib/agent-auth";
import { iso, runActivity } from "@/lib/logic";

const Body = z.object({
  status: z.enum(["running", "ok", "failed"]).optional(),
  phase: z.string().optional(),
  counts: z.record(z.string(), z.number()).optional(),
  errors: z.array(z.string()).optional(),
  finished: z.boolean().optional(),
});

export const PATCH = agentRoute(async (req, params) => {
  const id = intParam(params.id);
  const b = await parseBody(req, Body);
  const run = db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
  if (!run) throw new ApiError(404, "run not found");
  const done = b.finished ?? (b.status === "ok" || b.status === "failed");
  const updated = db
    .update(schema.runs)
    .set({
      status: b.status ?? run.status,
      // The agent reports the phase it is entering; the phases the run was started with stay as they are.
      currentPhase: b.phase ?? run.currentPhase,
      counts: b.counts ? { ...(run.counts ?? {}), ...b.counts } : run.counts,
      errors: b.errors ? [...(run.errors ?? []), ...b.errors] : run.errors,
      finishedAt: done ? iso() : run.finishedAt,
    })
    .where(eq(schema.runs.id, id))
    .returning()
    .get();
  return { run: updated };
});

export const GET = agentRoute(async (_req, params) => {
  const run = db.select().from(schema.runs).where(eq(schema.runs.id, intParam(params.id))).get();
  if (!run) throw new ApiError(404, "run not found");
  return { run, activity: runActivity(run) };
});
