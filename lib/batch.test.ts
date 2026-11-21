import { test } from "node:test";
import assert from "node:assert/strict";
import { batchRequest, extractJson, jobBlock, parseMaterials, parseScore, resultText, scoreSystem } from "./batch";

test("parseScore reads a fenced reply and clamps the score", () => {
  const s = parseScore('Here:\n```json\n{"fit_score": 104.4, "fit_reasons": ["Treasury role", "Seattle", "Pay unknown"]}\n```');
  assert.equal(s.fit_score, 100);
  assert.deepEqual(s.fit_reasons, ["Treasury role", "Seattle", "Pay unknown"]);
});

test("parseScore rejects a reply without a score", () => {
  assert.throws(() => parseScore('{"fit_reasons": []}'));
  assert.throws(() => parseScore("no json here"));
});

test("parseMaterials keeps only real answers and defaults to the resume", () => {
  const long = "x".repeat(60);
  const m = parseMaterials(JSON.stringify({ resume_version: "other", resume_md: long, cover_letter_md: long, answers: [{ question: "Q?", answer: "A" }, { answer: "orphan" }, "junk"] }));
  assert.equal(m.resume_version, "resume");
  assert.deepEqual(m.answers, [{ question: "Q?", answer: "A" }]);
  assert.throws(() => parseMaterials(JSON.stringify({ resume_md: "short", cover_letter_md: long })));
});

test("resultText reports errored and empty results", () => {
  assert.deepEqual(resultText({ result: { type: "succeeded", message: { content: [{ type: "text", text: "{}" }] } } }), { text: "{}" });
  assert.equal(resultText({ result: { type: "errored", error: { type: "overloaded" } } }).error?.startsWith("errored"), true);
  assert.equal(resultText({ result: { type: "succeeded", message: { content: [] } } }).error, "empty reply");
});

test("the scoring prompt leaves out the full resume text", () => {
  const sys = scoreSystem({ criteria: { min_base: 140000 }, profile: { full_name: "N", resume_text: "SECRET RESUME BODY", cv_text: "CV BODY" } });
  assert.ok(sys.includes("140000"));
  assert.ok(!sys.includes("SECRET RESUME BODY"));
});

test("batch requests cache the shared system prompt and cut long postings", () => {
  const r = batchRequest("score-1", "m", "SYS", "USER", 400);
  assert.equal(r.params.system[0].cache_control.type, "ephemeral");
  const block = jobBlock({ job_id: 1, company: "A", title: "T", location: null, description: "d".repeat(20_000) });
  assert.ok(block.length < 12_500);
  assert.deepEqual(extractJson('noise {"a": 1} noise'), { a: 1 });
});
