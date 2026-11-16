import { ApiError, agentRoute, intParam } from "@/lib/agent-auth";
import { getApplicationByJob } from "@/lib/logic";

export const dynamic = "force-dynamic";

/** One job with its stored description, so the agent can score a feed-found job without opening the posting. */
export const GET = agentRoute(async (_req, params) => {
  const jobId = intParam(params.id);
  const a = getApplicationByJob(jobId);
  if (!a) throw new ApiError(404, "job not found");
  const j = a.job;
  return {
    job_id: j.id,
    application_id: a.id,
    stage: a.stage,
    company: j.companyName,
    title: j.title,
    location: j.location,
    work_mode: j.workMode,
    url: j.url,
    pay_text: j.payText,
    posted_at: j.postedAt,
    fit_score: j.fitScore,
    description: j.description,
  };
});
