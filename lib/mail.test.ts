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
  // What setup seeds on every install.
  const { SEED_CRITERIA } = await import("../db/seed-data");
  db.insert(schema.searchCriteria).values({ id: 1, ...SEED_CRITERIA }).run();
  db.insert(schema.profile).values({ id: 1, fullName: "Test", workHistory: [], education: [], skills: [], confirmed: true }).run();
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
  assert.deepEqual({ ...r.summary }, { looked_at: 7, new: 5, recorded: 2, to_review: 3, filed: 2 });

  // A confirmation for an application you approved and sent yourself: applied, confirmed by email.
  assert.equal(app("stripe-sfm").stage, "applied");
  assert.ok(app("stripe-sfm").emailConfirmedAt);
  assert.equal(app("stripe-sfm").needsSignin, false);
  assert.equal(app("stripe-sfm").nextAction, "Follow up");
  // A rejection naming only the company: suggested for the one Plaid application in flight, not recorded on its own.
  assert.equal(app("plaid").stage, "applied");
  assert.equal(app("plaid").nextAction, "Read the email from Plaid");
  assert.equal(emailBy("An update on your application")!.status, "review");
  assert.equal(emailBy("An update on your application")!.applicationId, ids.plaid);
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
  assert.deepEqual(gmail.boxes.find((b) => b.name === "Lodestar")!.msgs.map((m) => m.messageId).sort(), ["g1@greenhouse"]);
  assert.equal(gmail.boxes.find((b) => b.name === "INBOX")!.msgs.find((m) => m.messageId === "g3@visa")!.flagged, true);
  assert.deepEqual(icloud.boxes.find((b) => b.name === "Lodestar")!.msgs.map((m) => m.messageId), ["i2@ashby"]);
  assert.equal(emailBy("Thanks for applying to Ramp")!.mailbox, "Lodestar");
  assert.equal(emailBy("Thank you for applying to Stripe")!.filedTo, "Lodestar");

  // One notification for the first read, not one per email. (Notifications are sent without waiting.)
  for (let i = 0; i < 50 && !fs.existsSync(NOTES); i++) await new Promise((done) => setTimeout(done, 100));
  await new Promise((done) => setTimeout(done, 500));
  const notes = fs.readFileSync(NOTES, "utf8").trim().split("\n");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Read 5 job emails from the last 30 days: 2 confirmations, 3 to look at/);

  // Events on the applications.
  const events = D.db.select().from(D.schema.events).all();
  assert.ok(events.some((e) => e.applicationId === ids.plaid && e.type === "email" && e.title.startsWith("Email to read")));
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
  assert.equal(ctx.to_review_total, 3);
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

test("you settle the Stripe and Plaid ones; the next check files them, out of Junk too", async () => {
  const stripe = emailBy("Your application")!;
  M.resolveEmail(stripe.id, { applicationId: ids["stripe-ta"], kind: "rejection", stage: "closed" }, "you");
  assert.equal(app("stripe-ta").stage, "closed");
  M.resolveEmail(emailBy("An update on your application")!.id, { kind: "rejection" }, "agent");
  assert.equal(app("plaid").stage, "closed");
  assert.equal(app("plaid").closedReason, "rejected");
  assert.equal(M.toReviewCount(), 0);
  const r = await M.checkMail({ launch: true });
  assert.ok(r.ok);
  // Yours is filed; the agent's reading never moves an email out of the inbox.
  assert.equal(r.summary.filed, 1);
  assert.equal(emailBy("An update on your application")!.filedTo, null);
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

// ---------- Regressions found in review ----------

test("a job you set back after an email moved it stays where you put it", async () => {
  assert.equal(app("ramp").stage, "applied");
  L.changeStage(ids.ramp, "found", { source: "you" });
  await new Promise((done) => setTimeout(done, 5));
  assert.ok((await M.checkMail()).ok);
  assert.equal(app("ramp").stage, "found");
});

test("the agent can't mark a found job applied from an email; you can", async () => {
  setMail((s) => {
    const inbox = s.accts[1].boxes[0];
    inbox.msgs.push({ id: s.nextId++, messageId: "r2@ramp", sender: "Ramp Recruiting <recruiting@ramp.com>", subject: "Quick update", date: hoursAgo(2), content: "Thanks for your application to Ramp. We're still reviewing.", flagged: false, junk: false, deleted: false, box: inbox });
  });
  assert.ok((await M.checkMail()).ok);
  const e = emailBy("Quick update")!;
  assert.equal(e.status, "review");
  assert.throws(() => M.resolveEmail(e.id, { applicationId: ids.ramp, kind: "confirmation" }, "agent"), /only the user/);
  assert.equal(app("ramp").stage, "found");
  M.resolveEmail(e.id, { applicationId: ids.ramp, kind: "confirmation" }, "you");
  assert.equal(app("ramp").stage, "applied");
});

test("dismissing an email clears its 'Read the email' and gives the follow-up back", async () => {
  setMail((s) => {
    const inbox = s.accts[0].boxes[0];
    inbox.msgs.push({ id: s.nextId++, messageId: "s9@stripe", sender: "Stripe Recruiting <recruiting@stripe.com>", subject: "Other roles", date: hoursAgo(1), content: "About your application: would you also consider our Treasury team? Any thoughts?", flagged: false, junk: false, deleted: false, box: inbox });
  });
  assert.ok((await M.checkMail()).ok);
  const e = emailBy("Other roles")!;
  assert.equal(e.applicationId, ids["stripe-sfm"]);
  assert.equal(app("stripe-sfm").nextAction, "Read the email from Stripe");
  M.resolveEmail(e.id, { dismiss: true }, "agent");
  assert.equal(app("stripe-sfm").nextAction, "Follow up");
  assert.equal(emailBy("Other roles")!.applicationId, null);
});

test("settling an assessment that doesn't move the stage leaves 'Complete the assessment'", async () => {
  setMail((s) => {
    const inbox = s.accts[0].boxes[0];
    inbox.msgs.push({ id: s.nextId++, messageId: "hr1@hackerrank", sender: "HackerRank <support@hackerrankforwork.com>", subject: "Stripe invites you to a HackerRank test for Strategic Finance Manager", date: hoursAgo(1), content: "Stripe has invited you to take a test for the Strategic Finance Manager role.", flagged: false, junk: false, deleted: false, box: inbox });
  });
  assert.ok((await M.checkMail()).ok);
  const e = emailBy("Stripe invites you to a HackerRank test for Strategic Finance Manager")!;
  assert.equal(e.kind, "assessment");
  M.resolveEmail(e.id, { applicationId: ids["stripe-sfm"], kind: "assessment", summary: "HackerRank test, due in 5 days" }, "agent");
  assert.equal(app("stripe-sfm").stage, "applied");
  assert.equal(app("stripe-sfm").nextAction, "Complete the assessment");
  assert.ok(D.db.select().from(D.schema.events).all().some((ev) => ev.applicationId === ids["stripe-sfm"] && ev.detail?.includes("HackerRank test, due in 5 days")));
});

test("'Wrong? Undo and look again' puts the application back where the email found it", () => {
  const e = emailBy("Thank you for applying to Stripe")!;
  assert.equal(e.movedFrom, "approved");
  assert.equal(e.movedTo, "applied");
  M.reopenEmail(e.id);
  assert.equal(app("stripe-sfm").stage, "approved");
  assert.equal(app("stripe-sfm").emailConfirmedAt, null);
  assert.equal(emailBy("Thank you for applying to Stripe")!.status, "review");
});

test("mail an account downloads late, with an older date, is still read", async () => {
  setMail((s) => {
    const inbox = s.accts[1].boxes[0];
    inbox.msgs.push({ id: s.nextId++, messageId: "late@visa", sender: "Visa <visa@myworkday.com>", subject: "Late arrival", date: hoursAgo(24 * 5), content: "Thank you for applying for the Payments Strategy Manager position at Visa.", flagged: false, junk: false, deleted: false, box: inbox });
  });
  assert.ok((await M.checkMail()).ok);
  assert.ok(emailBy("Late arrival"));
});

test("a scam 'interview' in Junk stays in Junk, unflagged; a spoofed sender changes nothing on its own", async () => {
  setMail((s) => {
    const junk = s.accts[1].boxes.find((b) => b.name === "Junk")!;
    junk.msgs.push({ id: s.nextId++, messageId: "scam@x", sender: "HR Recruitment Team <hr.recruit.dept2026@outlook.com>", subject: "Interview Invitation - Remote Data Entry Position", date: hoursAgo(1), content: "We invite you for an online interview. Add our hiring manager on Telegram.", flagged: false, junk: true, deleted: false, box: junk });
    const inbox = s.accts[0].boxes[0];
    inbox.msgs.push({ id: s.nextId++, messageId: "spoof@x", sender: "Visa Recruiting <visa.careers.team@gmail.com>", subject: "Your application for Treasury Manager", date: hoursAgo(1), content: "Thank you for applying. Unfortunately, we have decided to move forward with other candidates.", flagged: false, junk: false, deleted: false, box: inbox });
  });
  const before = app("visa-tm").stage;
  assert.ok((await M.checkMail({ launch: true })).ok);
  const scam = mailState().accts[1].boxes.find((b) => b.name === "Junk")!.msgs.find((m) => m.messageId === "scam@x")!;
  assert.equal(scam.junk, true);
  assert.equal(scam.flagged, false);
  assert.equal(emailBy("Your application for Treasury Manager")!.status, "review");
  assert.equal(app("visa-tm").stage, before);
});

test("payslips and benefits mail from an HR system aren't kept", async () => {
  setMail((s) => {
    const inbox = s.accts[0].boxes[0];
    inbox.msgs.push({ id: s.nextId++, messageId: "pay@x", sender: "Stripe <stripe@myworkday.com>", subject: "Your payslip for October is available", date: hoursAgo(1), content: "Net pay: $5,000. View your payslip.", flagged: false, junk: false, deleted: false, box: inbox });
  });
  assert.ok((await M.checkMail()).ok);
  assert.equal(emailBy("Your payslip for October is available"), undefined);
});

test("a guess from an address that doesn't vouch for the company waits on the Mail page without a notice", async () => {
  const before = app("ramp").nextAction;
  setMail((s) => {
    const inbox = s.accts[0].boxes[0];
    inbox.msgs.push({ id: s.nextId++, messageId: "scam2@x", sender: "Ramp Talent <ramp.talent.hr@gmail.com>", subject: "Your application for Remote Assistant at Ramp", date: hoursAgo(1), content: "We'd like to invite you to an interview on Telegram today.", flagged: false, junk: false, deleted: false, box: inbox });
  });
  assert.ok((await M.checkMail()).ok);
  const e = emailBy("Your application for Remote Assistant at Ramp")!;
  assert.equal(e.status, "review");
  assert.equal(e.applicationId, ids.ramp);
  assert.equal(app("ramp").nextAction, before);
  assert.ok(!D.db.select().from(D.schema.events).all().some((ev) => ev.title.includes("Remote Assistant")));
  await new Promise((done) => setTimeout(done, 500));
  assert.ok(!fs.readFileSync(NOTES, "utf8").includes("Remote Assistant"));
});

test("a first read with more job mail than one check reads is finished by the next check", async () => {
  M.updateMailSettings({ lastOkAt: null, backfillFrom: null });
  setMail((s) => {
    const inbox = s.accts[1].boxes[0];
    // Older than the 10 days later checks look back.
    for (let i = 0; i < 85; i++) {
      inbox.msgs.push({ id: s.nextId++, messageId: `old${i}@acme`, sender: "Acme <no-reply@greenhouse-mail.io>", subject: `Backfill ${i}`, date: hoursAgo(24 * 20 - i), content: "Thank you for applying to Acme. We received your application.", flagged: false, junk: false, deleted: false, box: inbox });
    }
  });
  const first = await M.checkMail();
  assert.ok(first.ok && first.message.includes("More to read"), first.ok ? first.message : first.error);
  assert.ok(M.getMailSettings().backfillFrom);
  const read = () => D.db.select().from(D.schema.emails).all().filter((e) => e.subject.startsWith("Backfill ")).length;
  assert.equal(read(), 80);
  const second = await M.checkMail();
  assert.ok(second.ok && !second.message.includes("More to read"));
  assert.equal(read(), 85);
  assert.equal(M.getMailSettings().backfillFrom, null);
});

test("job emails in Trash and your folders are read too: Trash is filed, your folder is left as it is", async () => {
  const { db, schema } = D;
  const plaidId = db.select().from(schema.companies).all().find((c) => c.name === "Plaid")!.id;
  const j = db.insert(schema.jobs).values({ companyId: plaidId, companyName: "Plaid", source: "careers", title: "Treasury Associate", dedupeKey: "plaid-tr" }).returning().get();
  ids["plaid-tr"] = db.insert(schema.applications).values({ jobId: j.id, stage: "applied" }).returning().get().id;
  const k = db.insert(schema.jobs).values({ companyId: plaidId, companyName: "Plaid", source: "careers", title: "Finance Partner", dedupeKey: "plaid-fp" }).returning().get();
  ids["plaid-fp"] = db.insert(schema.applications).values({ jobId: k.id, stage: "applied" }).returning().get().id;
  setMail((s) => {
    const icloud = s.accts[1];
    const add = (name: string, msg: { messageId: string; subject: string; content: string }) => {
      let b = icloud.boxes.find((x) => x.name === name);
      if (!b) icloud.boxes.push((b = { name, account: icloud, msgs: [] }));
      b.msgs.push({ id: s.nextId++, sender: "Plaid <no-reply@greenhouse-mail.io>", date: hoursAgo(3), flagged: false, junk: false, deleted: false, box: b, ...msg });
    };
    add("Trash", { messageId: "t1@plaid", subject: "Thanks for applying", content: "Thank you for applying for the Treasury Associate role at Plaid. We received your application." });
    add("Recruiters", { messageId: "f1@plaid", subject: "Let's talk", content: "We'd like to schedule an interview for the Finance Partner role at Plaid. Please share your availability." });
    add("Sent Messages", { messageId: "s1@plaid", subject: "Re: Let's talk", content: "Thank you for applying for the Finance Partner role at Plaid." });
  });
  assert.ok((await M.checkMail({ launch: true })).ok);

  const trashed = emailBy("Thanks for applying")!;
  assert.equal(trashed.status, "done");
  assert.ok(app("plaid-tr").emailConfirmedAt);
  assert.equal(trashed.filedTo, "Lodestar");
  const mine = emailBy("Let's talk")!;
  assert.equal(mine.applicationId, ids["plaid-fp"]);
  assert.equal(mine.mailbox, "folder/Recruiters");
  assert.equal(emailBy("Re: Let's talk"), undefined);

  const icloud = mailState().accts[1];
  assert.ok(icloud.boxes.find((b) => b.name === "Lodestar")!.msgs.some((m) => m.messageId === "t1@plaid"));
  assert.equal(icloud.boxes.find((b) => b.name === "Trash")!.msgs.length, 0);
  assert.deepEqual(icloud.boxes.find((b) => b.name === "Recruiters")!.msgs.map((m) => m.messageId), ["f1@plaid"]);
});
