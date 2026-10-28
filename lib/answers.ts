// Standard answers: the questions application forms ask that the profile doesn't cover, answered once in Settings
// and used on every form. An approved application whose form asked one that has no answer yet waits ("needs your
// answers") until the user adds it, then goes out on the next run.

import type { StandardAnswer } from "@/db/schema";

/** The questions the forms in the Queue have asked, by group, so Settings can list them ready to fill in. */
export const STANDARD_QUESTIONS: { group: string; hint?: string; questions: string[] }[] = [
  {
    group: "Self-ID and demographics",
    hint: "\"Decline to answer\" is normal and accepted for all of these.",
    questions: ["Gender", "Transgender?", "Hispanic or Latinx?", "Race", "Veteran status", "Disability status", "OK for the employer to keep my demographic data?"],
  },
  {
    group: "Government, clearance and export controls",
    questions: [
      "Do you hold a security clearance now? Ever held one?",
      "Willing to get a clearance or do a security prescreen?",
      "Any U.S. military service?",
      "Any government employment in the last 5 years?",
      "Export controls: \"protected individual\" under 8 U.S.C. 1324b(a)(3)?",
      "U.S. citizenship required for the role: OK to say I'm a permanent resident?",
      "Ties to a government official, myself or a close relative?",
    ],
  },
  {
    group: "Education and skills",
    questions: ["Undergrad GPA", "Grad GPA", "SAT / ACT / GRE scores", "Languages I speak, and how well", "SQL experience", "Python experience"],
  },
  {
    group: "Pay, timing and location",
    questions: [
      "Target base salary",
      "Notice period at my current employer",
      "Earliest start date",
      "Relocate or work onsite in New York?",
      "Relocate to Boston (hybrid)?",
      "Chicago or Menlo Park?",
      "Other locations OK (DC area, other sites)?",
    ],
  },
  {
    group: "Standing answers",
    questions: [
      "How did you hear about us?",
      "Applied to or worked at this company before?",
      "Any referrals at the company?",
      "Full legal name, for typed signatures",
      "Text or WhatsApp messages from employers?",
      "People manager or individual contributor?",
      "Any conflicts of interest to disclose?",
    ],
  },
  {
    group: "Your calls",
    hint: "Say \"no\" or \"leave it for me\" and the agent leaves that application for you to submit.",
    questions: [
      "May the agent accept privacy notices and arbitration agreements for me?",
      "AI-use disclosure: OK to say \"drafted with AI assistance from my resume, reviewed by me\"?",
      "May the agent draft \"Why us?\" and opinion questions from my resume?",
    ],
  },
];

const KNOWN = new Set(STANDARD_QUESTIONS.flatMap((g) => g.questions));

/** Reads the Settings form: one `sa_<i>` field per listed question, plus extra "question | answer" lines. Blanks are dropped. */
export function parseStandardAnswers(get: (k: string) => string | null, extra: string): StandardAnswer[] {
  const out: StandardAnswer[] = [];
  STANDARD_QUESTIONS.flatMap((g) => g.questions).forEach((question, i) => {
    const answer = get(`sa_${i}`)?.trim();
    if (answer) out.push({ question, answer });
  });
  for (const line of extra.split("\n")) {
    const at = line.indexOf("|");
    if (at < 0) continue;
    const question = line.slice(0, at).trim();
    const answer = line.slice(at + 1).trim();
    if (question && answer) out.push({ question, answer });
  }
  return out;
}

/** The extra answers (questions not in STANDARD_QUESTIONS), as "question | answer" lines for the Settings textarea. */
export function extraAnswerLines(answers: StandardAnswer[]): string {
  return answers
    .filter((a) => !KNOWN.has(a.question))
    .map((a) => `${a.question} | ${a.answer}`)
    .join("\n");
}

type Flaggable = { needsAnswers: boolean; answersFlaggedAt: string | null; materialsUpdatedAt: string | null };

/**
 * An application flagged "needs your answers" waits until the user has added something since it was flagged: a
 * standard answer in Settings, or an edit to the job's own answers. Then it goes back to the agent to try again.
 */
export function answersReady(a: Flaggable, standardAnswersUpdatedAt: string | null): boolean {
  if (!a.needsAnswers) return true;
  if (!a.answersFlaggedAt) return true;
  return [standardAnswersUpdatedAt, a.materialsUpdatedAt].some((t) => t != null && t > a.answersFlaggedAt!);
}

export type AnswersWait = { application_id: number; company: string; title: string; missing: string | null; flagged_at: string | null };

/** Splits an approved list into what the agent may try this run and what waits on the user's answers. */
export function splitAnswerWaits<T extends Flaggable & { id: number; portalNote: string | null; job: { companyName: string; title: string } }>(
  items: T[],
  standardAnswersUpdatedAt: string | null,
): { ready: T[]; waiting: AnswersWait[] } {
  const ready: T[] = [];
  const waiting: AnswersWait[] = [];
  for (const a of items) {
    if (answersReady(a, standardAnswersUpdatedAt)) ready.push(a);
    else waiting.push({ application_id: a.id, company: a.job.companyName, title: a.job.title, missing: a.portalNote, flagged_at: a.answersFlaggedAt });
  }
  return { ready, waiting };
}

/**
 * How many applications a finished run left for the user: what the agent reported (`needs_you`, or `flagged` on
 * runs from before it reported that), or the approved ones a submit-only run found waiting before it started.
 */
export function runNeedsYou(counts: Record<string, number> | null | undefined): number {
  if (!counts) return 0;
  return counts.needs_you ?? (counts.flagged ?? 0) + (counts.waiting ?? 0);
}

/** A finished run that had a submit phase and sent nothing while applications wait on the user. */
export function runSentNothing(r: { status: string; phase: string; counts: Record<string, number> | null }): number {
  if (r.status !== "ok") return 0;
  const phases = r.phase.split(",").map((p) => p.trim());
  if (!phases.includes("submit") && !phases.includes("all")) return 0;
  const sent = (r.counts?.submitted ?? 0) + (r.counts?.auto_applied ?? 0);
  return sent ? 0 : runNeedsYou(r.counts);
}
