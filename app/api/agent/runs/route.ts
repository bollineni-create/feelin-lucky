import { z } from "zod";
import { db, schema } from "@/lib/db";
import { agentRoute, parseBody } from "@/lib/agent-auth";

const Body = z.object({ phase: z.string().default("all"), trigger: z.string().default("agent"), log_path: z.string().optional() });

export const POST = agentRoute(async (req) => {
  const b = await parseBody(req, Body);
  const run = db.insert(schema.runs).values({ phase: b.phase, trigger: b.trigger, logPath: b.log_path ?? null }).returning().get();
  return { run_id: run.id, started_at: run.startedAt };
});
