import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { ApiError, agentRoute, intParam, parseBody } from "@/lib/agent-auth";
import { iso } from "@/lib/logic";

const { lookups, jobs } = schema;

// The agent settles a lookup once it has searched for it: `done` with one line on what it found. A lookup it
// couldn't get to stays pending for the next run, so there's nothing to send for that.
const Body = z.object({
  done: z.literal(true),
  run_id: z.number().int().optional(),
  result: z.string().trim().max(300).optional(),
});

export const PATCH = agentRoute(async (req, params) => {
  const id = intParam(params.id);
  const b = await parseBody(req, Body);
  const lookup = db.select().from(lookups).where(eq(lookups.id, id)).get();
  if (!lookup) throw new ApiError(404, "lookup not found");
  const found = db.select({ n: sql<number>`count(*)` }).from(jobs).where(eq(jobs.lookupId, id)).get()!.n;
  const updated = db
    .update(lookups)
    .set({
      status: "done",
      doneAt: iso(),
      runId: b.run_id ?? lookup.runId,
      result: b.result || (found ? `Found ${found} ${found === 1 ? "job" : "jobs"}` : "Nothing found"),
    })
    .where(eq(lookups.id, id))
    .returning()
    .get();
  return { lookup: updated, jobs_found: found };
});
