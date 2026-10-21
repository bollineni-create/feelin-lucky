// Email tracking end to end, without a Mac: lib/mail.ts reads a stand-in Mail (scripts/mail/fake-mail.ts) through the
// real bridge (scripts/mail/mail.js), run by a stand-in osascript (scripts/mail/fake-osascript.ts), into a scratch
// database. Checks what gets recorded on which application, what's left for review, what's filed and flagged in
// Mail, and what the agent and you can do with an email afterwards.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { buildAccounts, dumpState, loadState, type AcctSpec } from "../scripts/mail/fake-mail";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lodestar-mail-"));
const STATE = path.join(dir, "mail.json");
const NOTES = path.join(dir, "notes.txt");
const wrapper = path.join(dir, "osascript");
fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" --import tsx "${path.resolve("scripts/mail/fake-osascript.ts")}" "$@"\n`, { mode: 0o755 });
Object.assign(process.env, { JOBHUNT_DB: path.join(dir, "test.db"), JOBHUNT_ALLOW_NON_MAC: "1", JOBHUNT_OSASCRIPT: wrapper, FAKE_MAIL_STATE: STATE, FAKE_MAIL_NOTES: NOTES });

// Loaded after the environment above is set: lib/db reads JOBHUNT_DB when it's first imported.
let L: typeof import("./logic");
let M: typeof import("./mail");
let D: typeof import("./db");

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const saved = () => JSON.parse(fs.readFileSync(STATE, "utf8"));
const mailState = () => loadState(JSON.stringify(saved().state));
function setMail(change: (s: ReturnType<typeof mailState>, raw: Record<string, unknown>) => void) {
  const raw = saved();
  const s = loadState(JSON.stringify(raw.state));
  change(s, raw);
  raw.state = JSON.parse(dumpState(s));
  fs.writeFileSync(STATE, JSON.stringify(raw));
}

const ids: Record<string, number> = {};
const app = (k: string) => L.getApplication(ids[k])!;
const emailBy = (subject: string) => D.db.select().from(D.schema.emails).all().find((e) => e.subject === subject);

before(async () => {
  D = await import("./db");
  L = await import("./logic");
  M = await import("./mail");
  const { db, schema } = D;
  const co = (name: string, careersUrl: string | null) => db.insert(schema.companies).values({ name, careersUrl }).returning().get().id;
  const companies = { Stripe: co("Stripe", "https://stripe.com/jobs"), Plaid: co("Plaid", "https://plaid.com/careers"), Ramp: co("Ramp", null), Visa: co("Visa", "https://usa.visa.com/careers") };
  const job = (key: string, company: keyof typeof companies, title: string, stage: "found" | "approved" | "applied") => {
    const j = db.insert(schema.jobs).values({ companyId: companies[company], companyName: company, source: "careers", title, dedupeKey: key }).returning().get();
    ids[key] = db.insert(schema.applications).values({ jobId: j.id, stage, needsSignin: stage === "approved" }).returning().get().id;
  };
  job("stripe-sfm", "Stripe", "Strategic Finance Manager", "approved");
  job("stripe-ta", "Stripe", "Treasury Analyst", "applied");
  job("plaid", "Plaid", "Corporate Development Associate", "applied");
  job("ramp", "Ramp", "Strategic Finance Associate", "found");
  job("visa", "Visa", "Payments Strategy Manager", "applied");
  M.updateMailSettings({ enabled: true });

  const accounts: AcctSpec[] = [
    {
      name: "Gmail",
      gmail: true,
      inbox: [
        { messageId: "g1@greenhouse", sender: "Stripe <no-reply@us.greenhouse-mail.io>", subject: "Thank you for applying to Stripe", date: hoursAgo(50), content: "Hi Naren, thank you for applying for the Strategic Finance Manager role at Stripe. We'll review your application." },
        { messageId: "g2@plaid", sender: "Plaid Talent <talent@plaid.com>", subject: "An update on your application", date: hoursAgo(40), content: "Thank you for your interest in Plaid. Unfortunately, we have decided to move forward with other candidates." },
        { messageId: "g3@visa", sender: "Jane Smith <jane@visa.com>", subject: "Payments Strategy Manager - next steps", date: hoursAgo(30), content: "Hi Naren, I'm the recruiter for the Payments Strategy Manager role at Visa. I'd love to set up a time to chat this week." },
        { messageId: "g4@chase", sender: "Chase <no-reply@alertsp.chase.com>", subject: "Thank you for your application", date: hoursAgo(20), content: "We received your credit card application." },
        { messageId: "g5@linkedin", sender: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", subject: "Strategic Finance Manager at Stripe and 9 more jobs", date: hoursAgo(10), content: "Stripe is hiring. Be an early applicant." },
        { messageId: "g0@old", sender: "x <x@greenhouse-mail.io>", subject: "Thank you for applying", date: hoursAgo(24 * 45), content: "Too old to read." },
      ],
    },
    {
      name: "iCloud",
      inbox: [{ messageId: "i2@ashby", sender: "Ramp <no-reply@ashbyhq.com>", subject: "Thanks for applying to Ramp", date: hoursAgo(35), content: "We received your application for Strategic Finance Associate." }],
      junk: [{ messageId: "i1@stripe", sender: "Stripe <no-reply@stripe.com>", subject: "Your application", date: hoursAgo(45), content: "Unfortunately we won't be moving forward." }],
    },
  ];
  fs.writeFileSync(STATE, JSON.stringify({ running: true, denied: false, state: JSON.parse(dumpState(buildAccounts(accounts))) }));
});

test("the first check records what it's sure of, leaves the rest for review, and files and flags in Mail", async () => {
  const r = await M.checkMail({ launch: true });
  assert.ok(r.ok, !r.ok ? r.error : "");
  assert.deepEqual({ ...r.summary }, { looked_at: 7, new: 5, recorded: 3, to_review: 2, filed: 3 });

  // A confirmation for an application you approved and sent yourself: applied, confirmed by email.
  assert.equal(app("stripe-sfm").stage, "applied");
  assert.ok(app("stripe-sfm").emailConfirmedAt);
  assert.equal(app("stripe-sfm").needsSignin, false);
  assert.equal(app("stripe-sfm").nextAction, "Follow up");
  // A rejection from the one Plaid application in flight.
  assert.equal(app("plaid").stage, "closed");
  assert.equal(app("plaid").closedReason, "rejected");
  // A found job you applied to outside Lodestar, matched on its title.
  assert.equal(app("ramp").stage, "applied");
  // A recruiter asking to talk: noted, waiting for review, nothing moved.
  assert.equal(app("visa").stage, "applied");
  assert.equal(app("visa").nextAction, "Read the email from Visa");
  assert.equal(emailBy("Payments Strategy Manager - next steps")!.status, "review");
  assert.equal(emailBy("Payments Strategy Manager - next steps")!.kind, "interview");
  // Two Stripe applications in flight and no title: left for review with both.
  const stripe = emailBy("Your application")!;
  assert.equal(stripe.status, "review");
  assert.deepEqual(stripe.candidateIds?.sort(), [ids["stripe-sfm"], ids["stripe-ta"]].sort());
  assert.equal(app("stripe-ta").stage, "applied");
  // Bank and job-alert mail isn't kept.
  assert.equal(emailBy("Thank you for your application"), undefined);
  assert.equal(D.db.select().from(D.schema.emails).all().length, 5);

  // In Mail: Gmail keeps the labelled messages in the inbox; iCloud moves them; the interview request is flagged.
  const mail = mailState();
  const gmail = mail.accts.find((a) => a.name === "Gmail")!;
  const icloud = mail.accts.find((a) => a.name === "iCloud")!;
  assert.deepEqual(gmail.boxes.find((b) => b.name === "Lodestar")!.msgs.map((m) => m.messageId).sort(), ["g1@greenhouse", "g2@plaid"]);
  assert.equal(gmail.boxes.find((b) => b.name === "INBOX")!.msgs.find((m) => m.messageId === "g3@visa")!.flagged, true);
  assert.deepEqual(icloud.boxes.find((b) => b.name === "Lodestar")!.msgs.map((m) => m.messageId), ["i2@ashby"]);
  assert.equal(emailBy("Thanks for applying to Ramp")!.mailbox, "Lodestar");
  assert.equal(emailBy("Thank you for applying to Stripe")!.filedTo, "Lodestar");

  // One notification for the first read, not one per email. (Notifications are sent without waiting.)
  for (let i = 0; i < 50 && !fs.existsSync(NOTES); i++) await new Promise((done) => setTimeout(done, 100));
  await new Promise((done) => setTimeout(done, 500));
  const notes = fs.readFileSync(NOTES, "utf8").trim().split("\n");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Read 5 job emails from the last 30 days/);

  // Events on the applications.
  const events = D.db.select().from(D.schema.events).all();
  assert.ok(events.some((e) => e.applicationId === ids.plaid && e.type === "email" && e.title === "Rejection email"));
  assert.ok(events.some((e) => e.applicationId === ids.visa && e.title.startsWith("Email to read")));
});

test("a second check finds nothing new and changes nothing", async () => {
  const before = D.db.select().from(D.schema.events).all().length;
  const r = await M.checkMail();
  assert.ok(r.ok);
  assert.equal(r.summary.new, 0);
  assert.equal(r.summary.filed, 0);
  assert.equal(D.db.select().from(D.schema.events).all().length, before);
});

test("the agent sees the emails to review, and settles one; it can't touch it again", () => {
  const ctx = M.mailContext();
  assert.equal(ctx.to_review_total, 2);
  const stripe = ctx.to_review.find((e) => e.subject === "Your application")!;
  assert.equal(stripe.guess, "rejection");
  assert.equal(stripe.could_be.length, 2);

  const visa = emailBy("Payments Strategy Manager - next steps")!;
  M.resolveEmail(visa.id, { applicationId: ids.visa, kind: "interview", stage: "screening", summary: "Recruiter wants a call this week" }, "agent");
  assert.equal(app("visa").stage, "screening");
  assert.equal(app("visa").nextAction, "Reply to Visa to schedule");
  assert.throws(() => M.resolveEmail(visa.id, { applicationId: ids.visa, kind: "rejection" }, "agent"), /already recorded/);
  // Backwards or to approved is refused.
  assert.throws(() => M.resolveEmail(stripe.email_id, { applicationId: ids["stripe-ta"], kind: "update", stage: "approved" }, "agent"), /can't move/);
});

test("you settle the Stripe one; the next check files it out of Junk", async () => {
  const stripe = emailBy("Your application")!;
  M.resolveEmail(stripe.id, { applicationId: ids["stripe-ta"], kind: "rejection", stage: "closed" }, "you");
  assert.equal(app("stripe-ta").stage, "closed");
  assert.equal(M.toReviewCount(), 0);
  const r = await M.checkMail({ launch: true });
  assert.ok(r.ok);
  assert.equal(r.summary.filed, 1);
  const icloud = mailState().accts.find((a) => a.name === "iCloud")!;
  const filed = icloud.boxes.find((b) => b.name === "Lodestar")!.msgs.find((m) => m.messageId === "i1@stripe")!;
  assert.equal(filed.junk, false);
  // The visa email isn't flagged any less for having been settled as an interview.
  assert.equal(mailState().accts[0].boxes[0].msgs.find((m) => m.messageId === "g3@visa")!.flagged, true);
});

test("during a run a confirmation doesn't move a found job; after the run it does", async () => {
  const { db, schema } = D;
  const visaId = db.select().from(schema.companies).all().find((c) => c.name === "Visa")!.id;
  const j = db.insert(schema.jobs).values({ companyId: visaId, companyName: "Visa", source: "careers", title: "Treasury Manager", dedupeKey: "visa-tm" }).returning().get();
  ids["visa-tm"] = db.insert(schema.applications).values({ jobId: j.id, stage: "found" }).returning().get().id;
  setMail((s) => {
    const inbox = s.accts[0].boxes[0];
    inbox.msgs.push({ id: s.nextId++, messageId: "g6@workday", sender: "Visa <visa@myworkday.com>", subject: "Thank you", date: hoursAgo(1), content: "Thank you for applying for the Treasury Manager position at Visa.", flagged: false, junk: false, deleted: false, box: inbox });
  });
  const run = db.insert(schema.runs).values({ phase: "submit", status: "running" }).returning().get();
  let r = await M.checkMail();
  assert.ok(r.ok);
  assert.equal(r.summary.recorded, 1);
  assert.equal(app("visa-tm").stage, "found");
  assert.ok(app("visa-tm").emailConfirmedAt);

  db.update(schema.runs).set({ status: "ok", finishedAt: new Date().toISOString() }).where(eq(schema.runs.id, run.id)).run();
  r = await M.checkMail();
  assert.ok(r.ok);
  assert.equal(app("visa-tm").stage, "applied");
});

test("when Mail is closed, the background check leaves it alone", async () => {
  setMail((_s, raw) => (raw.running = false));
  const r = await M.checkMail();
  assert.ok(r.ok);
  assert.match(r.summary.skipped ?? "", /Mail isn't open/);
  setMail((_s, raw) => (raw.running = true));
});

test("when macOS says no, the error says where to allow it", async () => {
  setMail((_s, raw) => (raw.denied = true));
  const r = await M.checkMail();
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /Privacy & Security → Automation.*"node"/);
  assert.match(M.getMailSettings().lastError ?? "", /Automation/);
  setMail((_s, raw) => (raw.denied = false));
  assert.ok((await M.checkMail()).ok);
  assert.equal(M.getMailSettings().lastError, null);
});
