import { z } from "zod";
import { agentRoute, intParam, parseBody } from "@/lib/agent-auth";
import { resolveEmail } from "@/lib/mail";
import { EMAIL_KINDS, STAGES } from "@/db/schema";

// Settles an email from the context's mail.to_review: which application it's about, what it says and, optionally,
// the stage it moves the application to (forward only; never to approved). Without a stage, the kind's usual move
// applies (see emailStageMove); the application's current stage records the email without moving it. Or
// { "dismiss": true } when it isn't about any application in Lodestar.
const Body = z.union([
  z.object({ dismiss: z.literal(true), summary: z.string().max(300).optional() }),
  z.object({
    application_id: z.number().int().positive().optional(),
    kind: z.enum(EMAIL_KINDS),
    stage: z.enum(STAGES).optional(),
    summary: z.string().max(300).optional(),
  }),
]);

export const PATCH = agentRoute(async (req, params) => {
  const id = intParam(params.id);
  const b = await parseBody(req, Body);
  const email =
    "dismiss" in b
      ? resolveEmail(id, { dismiss: true, summary: b.summary }, "agent")
      : resolveEmail(id, { applicationId: b.application_id, kind: b.kind, stage: b.stage, summary: b.summary }, "agent");
  return { email: { id: email.id, status: email.status, kind: email.kind, application_id: email.applicationId } };
});
