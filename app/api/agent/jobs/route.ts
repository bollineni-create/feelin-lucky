import { z } from "zod";
import { ApiError, agentRoute, parseBody } from "@/lib/agent-auth";
import { IngestError, JobIn, ingestJob, type IngestResult } from "@/lib/ingest";

const Body = z.object({ run_id: z.number().int().optional(), jobs: z.array(JobIn).min(1).max(200) });

export const POST = agentRoute(async (req) => {
  const body = await parseBody(req, Body);
  const results: IngestResult[] = [];
  for (const j of body.jobs) {
    try {
      results.push(ingestJob(j));
    } catch (e) {
      if (e instanceof IngestError) throw new ApiError(400, e.message);
      throw e;
    }
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
