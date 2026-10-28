import { test } from "node:test";
import assert from "node:assert/strict";
import { STANDARD_QUESTIONS, answersReady, extraAnswerLines, parseStandardAnswers, runSentNothing, splitAnswerWaits } from "./answers";

const app = (id: number, needsAnswers: boolean, answersFlaggedAt: string | null, materialsUpdatedAt: string | null = null) => ({
  id,
  needsAnswers,
  answersFlaggedAt,
  materialsUpdatedAt,
  portalNote: needsAnswers ? "Undergrad GPA" : null,
  job: { companyName: "SpaceX", title: "Finance Manager" },
});

test("an unflagged application is always ready", () => {
  assert.equal(answersReady(app(1, false, null), null), true);
});

test("a flagged application waits until standard answers or its own answers change after the flag", () => {
  const flagged = app(1, true, "2026-10-27T20:00:00Z");
  assert.equal(answersReady(flagged, null), false);
  assert.equal(answersReady(flagged, "2026-10-27T19:00:00Z"), false);
  assert.equal(answersReady(flagged, "2026-10-28T09:00:00Z"), true);
  assert.equal(answersReady(app(1, true, "2026-10-27T20:00:00Z", "2026-10-28T09:00:00Z"), null), true);
});

test("splitAnswerWaits holds back only the flagged ones with nothing new", () => {
  const { ready, waiting } = splitAnswerWaits([app(1, false, null), app(2, true, "2026-10-27T20:00:00Z"), app(3, true, "2026-10-28T10:00:00Z")], "2026-10-28T09:00:00Z");
  assert.deepEqual(ready.map((a) => a.id), [1, 2]);
  assert.deepEqual(waiting, [{ application_id: 3, company: "SpaceX", title: "Finance Manager", missing: "Undergrad GPA", flagged_at: "2026-10-28T10:00:00Z" }]);
});

test("parseStandardAnswers keeps answered questions and extra lines, drops blanks", () => {
  const first = STANDARD_QUESTIONS[0].questions[0];
  const fields: Record<string, string> = { sa_0: "Decline to answer", sa_1: "  " };
  const out = parseStandardAnswers((k) => fields[k] ?? null, "Willing to travel? | Up to 25%\nno pipe here\n | blank question");
  assert.deepEqual(out, [
    { question: first, answer: "Decline to answer" },
    { question: "Willing to travel?", answer: "Up to 25%" },
  ]);
  assert.equal(extraAnswerLines(out), "Willing to travel? | Up to 25%");
});

test("a submit run that sent nothing while items wait says how many need you", () => {
  assert.equal(runSentNothing({ status: "ok", phase: "submit", counts: { submitted: 0, needs_you: 56 } }), 56);
  assert.equal(runSentNothing({ status: "ok", phase: "submit", counts: { submitted: 0, flagged: 11 } }), 11);
  assert.equal(runSentNothing({ status: "ok", phase: "submit", counts: { submitted: 2, needs_you: 5 } }), 0);
  assert.equal(runSentNothing({ status: "ok", phase: "submit", counts: { submitted: 0 } }), 0);
  assert.equal(runSentNothing({ status: "ok", phase: "find,prepare", counts: { flagged: 3 } }), 0);
  assert.equal(runSentNothing({ status: "failed", phase: "submit", counts: { needs_you: 3 } }), 0);
});
