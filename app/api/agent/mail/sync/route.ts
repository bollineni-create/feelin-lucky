import { agentRoute } from "@/lib/agent-auth";
import { checkMail } from "@/lib/mail";

export const dynamic = "force-dynamic";

// Checks Apple Mail now (opening it if it isn't running) and records what's about the job search. Answers 200 either
// way: { ok: true, summary, message } or { ok: false, error }, e.g. when email tracking is off.
export const POST = agentRoute(async () => checkMail({ launch: true }));
