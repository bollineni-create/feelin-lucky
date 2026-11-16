import { z } from "zod";
import { agentRoute, parseBody } from "@/lib/agent-auth";
import { ApplyResult, buildApplyQueue, recordApplyResult, syncHandoff } from "@/lib/handoff";

export const dynamic = "force-dynamic";

/** The apply queue: what the apply agent (Claude or a Grok bot) should apply to, after reading any results it left. */
export const GET = agentRoute(async () => {
  syncHandoff();
  return buildApplyQueue();
});

const Body = z.object({ results: z.array(ApplyResult).min(1).max(100) });

/** Results straight from the apply agent, the same shape as the lines in apply-results.jsonl. */
export const POST = agentRoute(async (req) => {
  const b = await parseBody(req, Body);
  const out = b.results.map((r) => ({ application_id: r.application_id, ...recordApplyResult(r) }));
  syncHandoff();
  return { results: out };
});
