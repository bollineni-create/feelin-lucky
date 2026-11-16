// Lodestar as a scanner, end to end against a scratch database: the job-board feed scan records matches the way the
// agent's finds are recorded, and the apply handoff writes the queue for Claude or a Grok bot and records what they
// report back, under the same rules as the agent API.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Fetcher } from "./feed-boards";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lodestar-scanner-"));
const LOCAL = path.join(dir, "handoff");
const MIRROR = path.join(dir, "icloud", "grok-bridge", "lodestar");
Object.assign(process.env, { JOBHUNT_DB: path.join(dir, "test.db"), LODESTAR_HANDOFF_LOCAL_DIR: LOCAL, LODESTAR_HANDOFF_DIR: MIRROR });

let D: typeof import("./db");
let L: typeof import("./logic");
let F: typeof import("./feeds");
let H: typeof import("./handoff");
const co: Record<string, number> = {};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let stripeTaken = false;
let stripeDown = false;
const fetcher: Fetcher = async (url) => {
  if (url.includes("/boards/stripe/jobs") && stripeDown) return json({ jobs: [] });
  if (url.includes("/boards/stripe/jobs") && stripeTaken) return json({ jobs: [{ id: 2, title: "Staff Software Engineer", location: { name: "Seattle, WA" }, absolute_url: "https://stripe.com/jobs/2" }] });
  if (url.includes("/boards/stripe/jobs"))
    return json({
      jobs: [
        { id: 1, title: "Treasury Manager", location: { name: "Seattle, WA" }, absolute_url: "https://stripe.com/jobs/1", content: "&lt;p&gt;Own global cash.&lt;/p&gt;" },
        { id: 2, title: "Staff Software Engineer", location: { name: "Seattle, WA" }, absolute_url: "https://stripe.com/jobs/2" },
        { id: 3, title: "Strategic Finance Manager", location: { name: "Dublin, Ireland" }, absolute_url: "https://stripe.com/jobs/3" },
      ],
    });
  if (url.includes("/postings/plaid")) return json([{ id: "p1", text: "Corporate Development Associate", hostedUrl: "https://jobs.lever.co/plaid/p1", categories: { location: "Remote - US" }, workplaceType: "remote", descriptionPlain: "M&A." }]);
  if (url.includes("/job-board/broken")) return json({ error: "down" }, 503);
  return json({}, 404);
};

before(async () => {
  D = await import("./db");
  L = await import("./logic");
  F = await import("./feeds");
  H = await import("./handoff");
  const { db, schema } = D;
  const { SEED_CRITERIA } = await import("../db/seed-data");
  db.insert(schema.searchCriteria).values({ id: 1, ...SEED_CRITERIA, currentEmployer: "JPMorgan Chase" }).run();
  db.insert(schema.profile).values({ id: 1, fullName: "Test User", email: "t@example.com", workHistory: [], education: [], skills: [], confirmed: true }).run();
  const add = (name: string, careersUrl: string | null, priority: "high" | "normal" | "paused" = "normal") =>
    (co[name] = db.insert(schema.companies).values({ name, careersUrl, priority }).returning().get().id);
  add("Stripe", "https://boards.greenhouse.io/stripe", "high");
  add("Plaid", "https://jobs.lever.co/plaid");
  add("Broken Co", "https://jobs.ashbyhq.com/broken");
  add("Paused Co", "https://boards.greenhouse.io/paused", "paused");
  add("Citadel", "https://www.citadel.com/careers");
  add("JPMorgan Chase", null);
});

const company = (name: string) => D.db.select().from(D.schema.companies).where(eq(D.schema.companies.id, co[name])).get()!;

test("the feed scan records matching postings and marks those companies scanned", async () => {
  const s = await F.scanFeeds({ fetcher, companyIds: Object.values(co) });
  assert.equal(s.companies_on_boards, 3, "Stripe, Plaid and Broken Co; not the paused one or the custom site");
  assert.equal(s.companies_ok, 2);
  assert.equal(s.new_jobs, 2);
  assert.match(s.errors[0], /Broken Co \(Ashby\): HTTP 503/);

  const found = L.listApplications(eq(D.schema.applications.stage, "found"));
  assert.deepEqual(found.map((a) => a.job.title).sort(), ["Corporate Development Associate", "Treasury Manager"]);
  const tm = found.find((a) => a.job.title === "Treasury Manager")!;
  assert.equal(tm.job.description, "Own global cash.");
  assert.equal(tm.job.source, "careers");
  assert.equal(tm.job.fitScore, null, "the agent scores it in the prepare phase");
  const ev = D.db.select().from(D.schema.events).where(eq(D.schema.events.applicationId, tm.id)).all();
  assert.ok(ev.some((e) => e.title === "Found: Treasury Manager" && e.detail?.includes("Greenhouse feed")), "feed finds show on the Pipeline feed");

  assert.ok(company("Stripe").lastScannedAt, "read from its board → off the agent's companies_due");
  assert.equal(company("Stripe").atsType, "greenhouse");
  assert.equal(company("Broken Co").lastScannedAt, null, "its board failed → the agent scans it in Chrome");
  assert.equal(company("Broken Co").scanNote, null, "a feed failure isn't the user's problem to fix");

  // A careers URL that points at a marketing page doesn't hide a board Lodestar knows the company posts on.
  assert.deepEqual(F.boardFor({ name: "Plaid", careersUrl: "https://plaid.com/careers" }), { kind: "ashby", token: "plaid" });
  assert.deepEqual(F.boardFor({ name: "Plaid", careersUrl: "https://jobs.lever.co/plaid" }), { kind: "lever", token: "plaid", eu: false }, "its own careers URL wins");
  assert.equal(F.boardFor({ name: "Citadel", careersUrl: "https://www.citadel.com/careers" }), null);

  const again = await F.scanFeeds({ fetcher, companyIds: Object.values(co) });
  assert.equal(again.new_jobs, 0, "a second scan dedupes");
  assert.equal(L.listApplications().length, 2);
});

function prepare(title: string, extra: Partial<typeof D.schema.applications.$inferInsert> = {}) {
  const a = L.listApplications().find((x) => x.job.title === title)!;
  const resume = path.join(dir, `resume-${a.id}.pdf`);
  const cover = path.join(dir, `cover-${a.id}.pdf`);
  fs.writeFileSync(resume, "%PDF resume");
  fs.writeFileSync(cover, "%PDF cover");
  D.db.update(D.schema.applications)
    .set({ resumeMd: "# Resume", coverLetterMd: "Dear team", resumePath: resume, coverLetterPath: cover, resumeVersion: "resume", answers: [{ question: "Sponsorship?", answer: "No" }], ...extra })
    .where(eq(D.schema.applications.id, a.id))
    .run();
  D.db.update(D.schema.jobs).set({ fitScore: 88, fitReasons: ["Treasury match", "Seattle", "High priority"] }).where(eq(D.schema.jobs.id, a.jobId)).run();
  return a.id;
}

test("jobs sent to the apply queue are written out for the apply agent, with copies of the materials", () => {
  const tm = prepare("Treasury Manager");
  const cd = prepare("Corporate Development Associate");
  L.changeStage(tm, "approved", { source: "you" });

  // A job at the current employer, approved by mistake, never reaches the apply agent.
  const jpm = D.db.insert(D.schema.jobs).values({ companyId: co["JPMorgan Chase"], companyName: "JPMorgan Chase", source: "careers", title: "Treasury VP", dedupeKey: "jpm-vp" }).returning().get();
  D.db.insert(D.schema.applications).values({ jobId: jpm.id, stage: "approved", resumeMd: "x", coverLetterMd: "y" }).run();

  const w = H.writeHandoff();
  assert.deepEqual(w.errors, []);
  assert.equal(w.count, 1);
  for (const d of [LOCAL, MIRROR]) {
    const q = JSON.parse(fs.readFileSync(path.join(d, H.QUEUE_JSON), "utf8")) as import("./handoff").ApplyQueue;
    assert.deepEqual(q.items.map((i) => i.application_id), [tm]);
    assert.equal(q.items[0].portal, "greenhouse");
    assert.equal(q.profile.email, "t@example.com");
    const md = fs.readFileSync(path.join(d, H.QUEUE_MD), "utf8");
    assert.match(md, /Treasury Manager · Stripe/);
    assert.match(md, /apply-results\.jsonl/);
    assert.doesNotMatch(md, /Treasury VP/);
  }
  assert.ok(fs.existsSync(path.join(MIRROR, "materials", String(tm), `resume-${tm}.pdf`)), "the mirror folder gets its own copies");
  const mq = JSON.parse(fs.readFileSync(path.join(MIRROR, H.QUEUE_JSON), "utf8")) as import("./handoff").ApplyQueue;
  assert.equal(mq.items[0].resume_file, path.join(MIRROR, "materials", String(tm), `resume-${tm}.pdf`), "the mirror's queue points at its own copies");
  const lq = JSON.parse(fs.readFileSync(path.join(LOCAL, H.QUEUE_JSON), "utf8")) as import("./handoff").ApplyQueue;
  assert.equal(lq.items[0].resume_file, path.join(dir, `resume-${tm}.pdf`));
  assert.ok(!fs.existsSync(path.join(MIRROR, "materials", String(cd))), "only queued jobs");
});

test("results the apply agent writes back are recorded once, under the agent API's rules", () => {
  const tm = L.listApplications().find((a) => a.job.title === "Treasury Manager")!.id;
  const cd = L.listApplications().find((a) => a.job.title === "Corporate Development Associate")!.id;
  fs.appendFileSync(
    path.join(MIRROR, H.RESULTS_FILE),
    [
      JSON.stringify({ application_id: tm, result: "applied", confirmation: "Thanks for applying!", by: "grok" }),
      // Not in the apply queue: the user never sent it, so the apply agent can't mark it applied.
      JSON.stringify({ application_id: cd, result: "applied", by: "grok" }),
      "not json",
    ].join("\n") + "\n",
  );
  const r = H.syncHandoff();
  assert.equal(r.recorded, 1);
  assert.equal(r.refused.length, 2);
  assert.match(r.refused[0], /not in the apply queue/);

  const applied = L.getApplication(tm)!;
  assert.equal(applied.stage, "applied");
  assert.equal(applied.confirmationText, "Thanks for applying!");
  assert.equal(applied.nextAction, "Follow up");
  assert.equal(L.getApplication(cd)!.stage, "found");
  assert.deepEqual(H.recordApplyResult({ application_id: cd, result: "posting_closed" }), { ok: false, error: `#${cd} is "found", not in the apply queue` }, "a job you never queued can't be closed from the results file");

  assert.ok(!fs.existsSync(path.join(MIRROR, H.RESULTS_FILE)), "read lines move to the archive");
  assert.equal(fs.readFileSync(path.join(MIRROR, "apply-results.archive.jsonl"), "utf8").trim().split("\n").length, 3);
  assert.equal(H.syncHandoff().recorded, 0, "nothing is recorded twice");
  assert.equal(JSON.parse(fs.readFileSync(path.join(LOCAL, H.QUEUE_JSON), "utf8")).items.length, 0, "the applied job drops off the queue");
});

test("a sign-in wall or a question only the user can answer goes back to the user", () => {
  const cd = L.listApplications().find((a) => a.job.title === "Corporate Development Associate")!.id;
  L.changeStage(cd, "approved", { source: "you" });
  assert.deepEqual(H.recordApplyResult({ application_id: cd, result: "needs_answers", note: "Desired salary (required)", by: "claude" }), { ok: true, did: "flagged answers" });
  const q = H.buildApplyQueue();
  assert.equal(q.items.length, 0);
  assert.match(q.waiting[0].why, /Desired salary/);
  assert.equal(L.getApplication(cd)!.stage, "approved", "still in the queue, waiting on the user");
});

test("a found job its board no longer lists is closed; an empty board closes nothing", async () => {
  D.db.insert(D.schema.jobs).values({ companyId: co.Stripe, companyName: "Stripe", source: "careers", title: "FP&A Manager", externalId: "gh:99", dedupeKey: "stripe|fp&a manager|seattle" }).run();
  const j = D.db.select().from(D.schema.jobs).where(eq(D.schema.jobs.externalId, "gh:99")).get()!;
  const appId = D.db.insert(D.schema.applications).values({ jobId: j.id, stage: "found" }).returning().get().id;

  stripeDown = true;
  await F.scanFeeds({ fetcher, companyIds: [co.Stripe] });
  assert.equal(L.getApplication(appId)!.stage, "found", "an empty board is an outage, not every posting gone");

  stripeDown = false;
  stripeTaken = true;
  const s = await F.scanFeeds({ fetcher, companyIds: [co.Stripe] });
  assert.equal(s.closed, 1);
  const a = L.getApplication(appId)!;
  assert.equal(a.stage, "closed");
  assert.equal(a.closedReason, "posting_closed");
  // Jobs past "found" (queued, applied) are never closed this way.
  assert.equal(L.listApplications().find((x) => x.job.title === "Treasury Manager")!.stage, "applied");
});

test("an old run stopped in the submit phase resumes with the phases that still exist", () => {
  assert.deepEqual(L.resumePhases({ phase: "submit,find,prepare,track", currentPhase: "submit" }), ["find", "prepare", "track"]);
  assert.deepEqual(L.resumePhases({ phase: "find,prepare,track", currentPhase: "prepare" }), ["prepare", "track"]);
  assert.deepEqual(L.resumePhases({ phase: "submit", currentPhase: "submit" }), ["find", "prepare", "track"]);
});

test("run activity separates the agent's own work from the feed scan's", () => {
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const act = L.runActivity({ startedAt: from, finishedAt: new Date().toISOString() });
  // Everything this file created came from the feeds (with "Found:" events) or was inserted without one.
  assert.ok(act.jobs_found >= act.agent_jobs_found);
  const feedJobs = D.db.select().from(D.schema.events).all().filter((e) => e.source === "feed").length;
  assert.equal(act.jobs_found - act.agent_jobs_found, feedJobs, "feed finds don't count as the agent's");
});

test("standing answers ride in the queue; an agent allowed to make accounts gets sign-in-walled jobs; Grok hears about new ones once", () => {
  const cd = L.listApplications().find((a) => a.job.title === "Corporate Development Associate")!.id;
  D.db.update(D.schema.applications).set({ needsAnswers: false, needsSignin: true, portalNote: "Workday account needed" }).where(eq(D.schema.applications.id, cd)).run();
  D.db.update(D.schema.profile).set({ standingAnswers: [{ question: "How did you hear about us?", answer: "Company careers site" }], agentCreatesAccounts: false }).where(eq(D.schema.profile.id, 1)).run();

  let q = H.buildApplyQueue();
  assert.deepEqual(q.profile.standing_answers, [{ question: "How did you hear about us?", answer: "Company careers site" }]);
  const walled = q.items.length === 0 ? q.waiting.find((w) => w.application_id === cd) : null;
  // The first sign-in-walled job on a portal still gets one look; it only waits once the probe has failed. Either way
  // it's not handed over as account-creatable.
  assert.ok(walled || q.items.every((i) => i.application_id !== cd || i.needs_signin));

  D.db.update(D.schema.profile).set({ agentCreatesAccounts: true }).where(eq(D.schema.profile.id, 1)).run();
  q = H.buildApplyQueue();
  assert.ok(q.items.some((i) => i.application_id === cd && i.needs_signin), "the agent may clear the wall itself");
  assert.equal(q.profile.agent_may_create_accounts, true);
  assert.ok(!q.waiting.some((w) => w.application_id === cd));

  // The mirror's parent holds the bridge files, so Lodestar tells the Grok bots.
  const bridge = path.dirname(MIRROR);
  fs.writeFileSync(path.join(bridge, "TO-GROK.md"), "# to grok\n");
  fs.writeFileSync(path.join(bridge, "INBOX.md"), "# inbox\n");
  fs.writeFileSync(path.join(bridge, "PROTOCOL.md"), "# protocol\n");
  H.writeHandoff();
  const t0 = new Date("2026-11-16T10:00:00Z");
  assert.deepEqual(H.notifyGrok(t0), { sent: true, fresh: q.items.length });
  const toGrok = fs.readFileSync(path.join(bridge, "TO-GROK.md"), "utf8");
  assert.match(toGrok, /^NOTE \[Claude\] T-20261116-LODESTAR: Lodestar apply queue: \d+ new jobs? ready/m);
  assert.match(toGrok, /work lodestar\/APPLY-QUEUE\.md under T-20261116-LODESTAR; report each job in lodestar\/apply-results\.jsonl/);
  assert.match(fs.readFileSync(path.join(bridge, "INBOX.md"), "utf8"), /NOTE \[Claude\] T-20261116-LODESTAR/);
  assert.equal(H.notifyGrok(new Date(t0.getTime() + 5 * 60_000)).sent, false, "nothing new: no second line");
  assert.equal(toGrok.split("NOTE [Claude]").length - 1, 1);
  assert.match(fs.readFileSync(path.join(MIRROR, H.QUEUE_MD), "utf8"), /create one as APPLY\.md rule 2 allows/, "the row tells the agent it may make the account");

  // A job that leaves the queue (held for answers) and comes back is announced again, after the hourly limit.
  D.db.update(D.schema.applications).set({ needsAnswers: true }).where(eq(D.schema.applications.id, cd)).run();
  assert.equal(H.notifyGrok(new Date(t0.getTime() + 10 * 60_000)).sent, false);
  D.db.update(D.schema.applications).set({ needsAnswers: false }).where(eq(D.schema.applications.id, cd)).run();
  assert.deepEqual(H.notifyGrok(new Date(t0.getTime() + 20 * 60_000)), { sent: false, fresh: 1 }, "back, but within the hour");
  assert.equal(H.notifyGrok(new Date(t0.getTime() + 61 * 60_000)).sent, true, "announced again");
  D.db.update(D.schema.profile).set({ agentCreatesAccounts: false, standingAnswers: [] }).where(eq(D.schema.profile.id, 1)).run();
});
