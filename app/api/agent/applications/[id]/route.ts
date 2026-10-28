import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { ApiError, agentRoute, intParam, parseBody } from "@/lib/agent-auth";
import { FOLLOW_UP_DAYS, autoApplyCandidates, autoApplyBlocker, changeStage, clearSigninOnPortal, daysFromNow, getApplication, iso, logEvent } from "@/lib/logic";
import { normalizeClosedReason } from "@/lib/outcome";
import { STAGES, type Application, type Stage } from "@/db/schema";

const Body = z.object({
  stage: z.enum(STAGES).optional(),
  submitted_at: z.string().optional(),
  next_action: z.string().nullable().optional(),
  next_action_due: z.string().nullable().optional(),
  needs_signin: z.boolean().optional(),
  needs_answers: z.boolean().optional(),
  portal_note: z.string().nullable().optional(),
  closed_reason: z.string().optional(),
  confirmation_text: z.string().optional(),
  linkedin_status: z.string().optional(),
  detail: z.string().optional(),
});

// The agent can move an application forward, but approval belongs to the user alone.
// found → applied is allowed only for auto-apply candidates, checked below.
const AGENT_TRANSITIONS: Record<Stage, Stage[]> = {
  found: ["closed"],
  approved: ["applied", "closed"],
  applied: ["screening", "interviewing", "offer", "closed"],
  screening: ["interviewing", "offer", "closed"],
  interviewing: ["offer", "closed"],
  offer: ["closed"],
  closed: [],
};

export const PATCH = agentRoute(async (req, params) => {
  const id = intParam(params.id);
  const b = await parseBody(req, Body);
  const app = getApplication(id);
  if (!app) throw new ApiError(404, "application not found");

  const extra: Partial<Application> = {};
  if (b.next_action !== undefined) extra.nextAction = b.next_action;
  if (b.next_action_due !== undefined) extra.nextActionDue = b.next_action_due;
  if (b.portal_note !== undefined) extra.portalNote = b.portal_note;
  if (b.confirmation_text !== undefined) extra.confirmationText = b.confirmation_text;
  if (b.linkedin_status !== undefined) extra.linkedinStatus = b.linkedin_status;
  if (b.needs_signin !== undefined) extra.needsSignin = b.needs_signin;
  if (b.needs_signin === true) extra.signinCheckedAt = iso();
  if (b.needs_answers !== undefined) extra.needsAnswers = b.needs_answers;
  if (b.needs_answers === true) extra.answersFlaggedAt = iso();

  if (b.stage && b.stage !== app.stage) {
    let detail = b.detail ?? b.closed_reason ?? null;
    // Jobs at the user's current employer go through the internal job site; the agent never submits one.
    if (b.stage === "applied" && app.internal) throw new ApiError(403, "this job is at the user's current employer: they apply through the internal job site, the agent does not submit it");
    const autoApply = app.stage === "found" && b.stage === "applied";
    if (autoApply) {
      const blocker = autoApplyBlocker(app);
      if (blocker) throw new ApiError(403, `not eligible for auto-apply: ${blocker}`);
      if (!autoApplyCandidates().some((a) => a.id === id)) throw new ApiError(403, "not eligible for auto-apply: today's auto-apply cap is reached");
      extra.autoApplied = true;
      detail = `Auto-applied (fit ${app.job.fitScore})${b.detail ? `: ${b.detail}` : ""}`;
    } else if (!AGENT_TRANSITIONS[app.stage].includes(b.stage)) {
      throw new ApiError(403, `agent may not move an application from "${app.stage}" to "${b.stage}"`);
    }
    if (b.stage === "applied") {
      extra.submittedAt = b.submitted_at ?? iso();
      extra.needsSignin = false;
      extra.needsAnswers = false;
      extra.nextAction ??= "Follow up";
      extra.nextActionDue ??= iso(daysFromNow(FOLLOW_UP_DAYS));
    }
    if (b.stage === "closed") {
      const reason = normalizeClosedReason(b.closed_reason);
      if (!reason) throw new ApiError(400, "closed_reason is required when closing");
      extra.closedReason = reason;
      extra.nextAction = null;
      extra.nextActionDue = null;
    }
    if (b.stage === "screening" || b.stage === "interviewing" || b.stage === "offer") {
      if (b.next_action === undefined) extra.nextAction = null;
    }
    const updated = changeStage(id, b.stage, { source: "agent", detail, extra });
    // It got through, so the portal's sign-in works now: the others approved on it go out with the next context.
    if (b.stage === "applied") clearSigninOnPortal(app);
    return { application: updated };
  }

  if (b.needs_signin === true && !app.needsSignin) {
    logEvent({ applicationId: id, type: "portal_update", title: "Needs you: portal sign-in", detail: b.portal_note ?? b.detail ?? "Portal asked for an account, password or CAPTCHA." });
  }
  if (b.needs_answers === true && !app.needsAnswers) {
    logEvent({ applicationId: id, type: "portal_update", title: "Needs you: answers for the form", detail: b.portal_note ?? b.detail ?? "The form asked something your profile and standard answers don't cover." });
  }
  if (!Object.keys(extra).length) return { application: app, unchanged: true };
  const updated = db.update(schema.applications).set(extra).where(eq(schema.applications.id, id)).returning().get();
  return { application: updated };
});
