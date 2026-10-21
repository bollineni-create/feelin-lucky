// Email tracking through Apple Mail. The app server reads the Mail accounts on this Mac through
// scripts/mail/mail.js (JavaScript for Automation, run with osascript), keeps the emails that are about the job
// search, ties each to its application and records what it says: a confirmation that an application landed, a
// rejection, an interview request. It files what it has recorded in a "Lodestar" mailbox and flags what needs a
// reply. Only this process talks to Mail, so macOS asks for permission once; the agent and the pages go through it.
import { execFile } from "node:child_process";
import path from "node:path";
import { and, count, desc, eq, gte, inArray, isNull, ne, notLike, or, sql } from "drizzle-orm";
import { ROOT, db, schema } from "./db";
import { ApiError } from "./agent-auth";
import { FOLLOW_UP_DAYS, activeRun, autoApplyBlocker, changeStage, daysAgo, getApplication, iso, listApplications, logEvent } from "./logic";
import { LIVE_STAGES, classify, companyDomain, emailStageMove, isJobEmail, matchEmail, parseSender, prefilter, type Candidate, type Sender } from "./mail-rules";
import type { Application, Email, EmailKind, MailCheckSummary, MailSettings, Stage } from "@/db/schema";

const { emails, mailSettings, applications, companies } = schema;

const BRIDGE = path.join(ROOT, "scripts", "mail", "mail.js");
// An absolute path: launchd starts the server with a bare PATH. JOBHUNT_OSASCRIPT stands in a fake Mail for tests.
const OSASCRIPT = process.env.JOBHUNT_OSASCRIPT || "/usr/bin/osascript";
const DAY = 86_400_000;
/** Bodies kept per email, and read per check (the rest wait for the next check). */
const BODY_CHARS = 6000;
const MAX_BODIES = 80;
/**
 * Each check reads the last 10 days again (the first one, lookbackDays). Mail dates a message by when the server
 * got it, so an account that syncs late (a Mac asleep over the weekend, an account offline) delivers older mail;
 * messages already seen are skipped, so a wide window costs little.
 */
const RECHECK_DAYS = 10;
/** Moves and flags per bridge call (a Gmail move takes a few seconds to check), and per check. */
const FILE_BATCH = 10;
const FILE_PER_CHECK = 40;
/** Emails Lodestar still files or flags, by age. */
const FILE_WINDOW_DAYS = 60;

export const KIND_LABEL: Record<EmailKind, string> = {
  confirmation: "Confirmation",
  rejection: "Rejection",
  interview: "Interview or next step",
  assessment: "Assessment",
  offer: "Offer",
  update: "Status update",
  other: "Other",
};

const KIND_TITLE: Record<EmailKind, string> = {
  confirmation: "Application confirmed by email",
  rejection: "Rejection email",
  interview: "Interview or next step (email)",
  assessment: "Assessment request (email)",
  offer: "Offer (email)",
  update: "Status update (email)",
  other: "Email about this application",
};

const NEXT_ACTION: Partial<Record<EmailKind, (company: string) => string>> = {
  interview: (c) => `Reply to ${c} to schedule`,
  assessment: () => "Complete the assessment",
  offer: () => "Review the offer",
};

/** Kinds that ask something of you: flagged in Mail and left in the inbox. */
const NEEDS_REPLY: EmailKind[] = ["interview", "assessment", "offer"];
/** Kinds that are only a record once they're on their application: moved to the Lodestar mailbox. */
const RECORD_ONLY: EmailKind[] = ["confirmation", "rejection", "update"];

export function getMailSettings(): MailSettings {
  const row = db.select().from(mailSettings).where(eq(mailSettings.id, 1)).get();
  if (row) return row;
  db.insert(mailSettings).values({ id: 1 }).onConflictDoNothing().run();
  return db.select().from(mailSettings).where(eq(mailSettings.id, 1)).get()!;
}

export function updateMailSettings(patch: Partial<MailSettings>) {
  getMailSettings();
  db.update(mailSettings).set(patch).where(eq(mailSettings.id, 1)).run();
}

export const toReviewCount = () => db.select({ n: count() }).from(emails).where(eq(emails.status, "review")).get()!.n;

/** A message:// link that opens the email in Mail. */
export function mailLink(messageId: string) {
  return `message://${encodeURIComponent(`<${messageId.replace(/^<|>$/g, "")}>`)}`;
}

// ---------- The bridge ----------

type BridgeMessage = { message_id: string; mail_id: number | null; account: string | null; account_id?: string | null; where: "inbox" | "junk"; sender: string; subject: string | null; received_at: string; body: string | null };
type ListOut = { ok: true; running: boolean; accounts?: string[]; scanned?: number; newest?: string | null; truncated?: boolean; unread?: number; problems?: string[]; messages?: BridgeMessage[] };
type FileResult = { message_id: string; moved_to?: string; mail_id?: number | null; still_in_inbox?: boolean; rescued?: boolean; flagged?: boolean; gone?: boolean; skipped?: string; error?: string };
type FileOut = { ok: true; results: FileResult[] };

export const NOT_A_MAC = "Email tracking reads Apple Mail, so it only works with Lodestar running on your Mac.";

/** What went wrong talking to Mail, in words that say what to do about it. */
export function explainMailError(raw: string, code?: number | null): string {
  const text = raw.trim();
  if (code === -1743 || /-1743|not authori[sz]ed to send apple events/i.test(text)) {
    // Started through npm (an install from before email tracking, or `npm start` by hand), macOS refuses without asking.
    if (["start", "dev"].includes(process.env.npm_lifecycle_event ?? "")) {
      return "macOS won't let Lodestar use Mail while its server is started through npm. Run Install Job Hunt.command again (or scripts/install-launchd.sh --app-only) so it runs as node, then click Check mail now and choose OK. (Allowed under System Settings → Privacy & Security → Automation.)";
    }
    return 'macOS hasn\'t allowed Lodestar to use Mail. Open System Settings → Privacy & Security → Automation, find "node" (the program Lodestar\'s server runs as) and turn on Mail under it, then click Check mail now. If node isn\'t listed, macOS hasn\'t asked yet: click Check mail now while you\'re at the Mac and choose OK. No prompt? Run Install Job Hunt.command again so the server runs as node. (A server started in Terminal is listed under Terminal.)';
  }
  if (code === -1744 || /-1744|user consent|consent is required/i.test(text)) {
    return "macOS needs your OK before Lodestar can use Mail. Click Check mail now while you're at the Mac and choose OK when macOS asks whether node may control Mail.";
  }
  if (code === -600 || /-600|isn't running|is not running|not running/i.test(text)) return "Mail isn't running, or quit while Lodestar was reading it. Open Mail, or click Check mail now to open it.";
  if (code === -609) return "Mail quit while Lodestar was reading it. Lodestar tries again on its next check.";
  if (code === -1712 || /-1712|timed out|timeout/i.test(text)) return "Mail didn't answer in time (it may be busy downloading mail). Lodestar tries again on its next check.";
  if (/ENOENT/.test(text)) return NOT_A_MAC;
  return text.slice(0, 400) || "Mail didn't answer.";
}

class MailError extends Error {}

function bridge<T>(input: Record<string, unknown>, timeoutMs = 240_000): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(OSASCRIPT, ["-l", "JavaScript", BRIDGE, JSON.stringify(input)], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out: { ok?: boolean; error?: string; number?: number } | null = null;
      try {
        out = JSON.parse(stdout.trim().split("\n").pop() || "null");
      } catch {
        out = null;
      }
      if (out?.ok) return resolve(out as T);
      const killed = (err as { killed?: boolean } | null)?.killed;
      const raw = out?.error ?? (killed ? "timed out" : `${stderr || ""} ${err?.message ?? ""}`);
      reject(new MailError(explainMailError(raw, out?.number)));
    });
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Opens Mail in the background (no window brought forward) if it isn't running, and waits for it. */
async function launchMail() {
  if ((await bridge<{ running: boolean }>({ cmd: "status" })).running) return;
  await new Promise<void>((resolve) => execFile("open", ["-g", "-a", "Mail"], () => resolve()));
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if ((await bridge<{ running: boolean }>({ cmd: "status" })).running) {
      // Give it a moment to connect to its accounts.
      await sleep(4000);
      return;
    }
  }
  throw new MailError("Mail didn't open within 30 seconds.");
}

function notify(message: string, subtitle?: string) {
  // Cut first, then escape, so a cut can't land inside an escape.
  const q = (s: string) => `"${s.slice(0, 220).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const script = `display notification ${q(message)} with title "Lodestar"${subtitle ? ` subtitle ${q(subtitle)}` : ""}`;
  execFile(OSASCRIPT, ["-e", script], () => {});
}

// ---------- Recording an email on its application ----------

const fromLabel = (e: Pick<Email, "fromName" | "fromAddress">) => e.fromName ?? e.fromAddress ?? "an unknown sender";
const quoted = (s: string) => `“${s.length > 140 ? `${s.slice(0, 137)}…` : s}”`;
const laterOf = (a: string | null, b: string) => (a && a > b ? a : b);

type Source = "mail" | "agent" | "you";

/**
 * Records an email on an application: an event when asked to (the first time they're tied together, or when the
 * agent or you settle it), the latest-email date, the confirmation date, the next action, and, unless the email
 * still needs reading, the stage it moves the application to. The app on its own (source "mail") only moves an
 * application on a title match, and never to "applied" during a run: the agent may be submitting it right now.
 */
function attach(e: Email, appId: number, o: { kind: EmailKind; source: Source; review: boolean; announce: boolean; stage?: Stage | null; summary?: string | null; matchedBy?: string | null }) {
  const app = getApplication(appId);
  if (!app) return;
  const company = app.job.companyName;
  if (o.announce) {
    logEvent({
      applicationId: appId,
      type: "email",
      title: o.review ? `Email to read: ${quoted(e.subject)}` : KIND_TITLE[o.kind],
      detail: o.review
        ? `From ${fromLabel(e)}${o.kind !== "other" ? ` · looks like: ${KIND_LABEL[o.kind].toLowerCase()}` : ""}`
        : `${fromLabel(e)}: ${quoted(e.subject)}${o.summary ? ` — ${o.summary}` : ""}`,
      source: o.source,
      at: o.source === "mail" ? e.receivedAt : iso(),
    });
  }

  const extra: Partial<Application> = { lastEmailAt: laterOf(app.lastEmailAt, e.receivedAt) };
  if (o.kind === "confirmation" && !o.review) extra.emailConfirmedAt = app.emailConfirmedAt ?? e.receivedAt;
  const needsYou = NEEDS_REPLY.includes(o.kind) && app.stage !== "closed";
  const replaceable = !app.nextAction || app.nextAction === "Follow up" || app.nextAction.startsWith("Read the email from");

  if (o.review) {
    // It needs reading: say so on the card, unless something more specific is already there (or the email is one
    // recorded quietly, below).
    if (o.announce && app.stage !== "closed" && o.kind !== "confirmation" && replaceable) {
      extra.nextAction = `Read the email from ${company}`;
      extra.nextActionDue = iso();
    }
    db.update(applications).set(extra).where(eq(applications.id, appId)).run();
    return;
  }

  const move = emailStageMove(app.stage, o.kind, o.stage);
  let to = "error" in move ? null : move.to;
  if (o.source === "mail" && (o.matchedBy !== "title" || (to === "applied" && activeRun()))) to = null;
  if (!to) {
    // A request that doesn't move the stage (an assessment while applied, a second-round invite) still needs doing.
    if (needsYou && (replaceable || o.source !== "mail")) {
      extra.nextAction = NEXT_ACTION[o.kind]!(company);
      extra.nextActionDue = iso();
    } else if (app.nextAction?.startsWith("Read the email from")) {
      extra.nextAction = null;
      extra.nextActionDue = null;
    }
    db.update(applications).set(extra).where(eq(applications.id, appId)).run();
    return;
  }
  if (to === "applied") {
    extra.submittedAt = app.submittedAt ?? e.receivedAt;
    extra.needsSignin = false;
    extra.nextAction = "Follow up";
    extra.nextActionDue = iso(new Date(Date.parse(e.receivedAt) + FOLLOW_UP_DAYS * DAY));
    // A strong match the agent submitted without recording it still counts toward today's auto-apply cap.
    if (app.stage === "found" && autoApplyBlocker(app) == null) extra.autoApplied = true;
  } else if (to === "closed") {
    extra.closedReason = "rejected";
    extra.nextAction = null;
    extra.nextActionDue = null;
  } else {
    extra.nextAction = NEXT_ACTION[o.kind]?.(company) ?? null;
    extra.nextActionDue = extra.nextAction ? iso() : null;
  }
  const outside = o.source === "mail" && to === "applied" ? ". You applied outside Lodestar, or the agent's submit wasn't recorded" : "";
  changeStage(appId, to, { source: o.source, detail: `Email from ${fromLabel(e)}: ${quoted(e.subject)}${o.summary ? ` — ${o.summary}` : ""}${outside}`, extra });
  db.update(emails).set({ movedFrom: app.stage, movedTo: to }).where(eq(emails.id, e.id)).run();
}

/** The latest email still tied to an application, after one is untied from it. */
function refreshLastEmail(appId: number) {
  const latest = db
    .select({ at: sql<string | null>`max(${emails.receivedAt})` })
    .from(emails)
    .where(and(eq(emails.applicationId, appId), ne(emails.status, "dismissed")))
    .get()?.at ?? null;
  const app = getApplication(appId);
  if (!app) return;
  const patch: Partial<Application> = { lastEmailAt: latest };
  if (app.nextAction?.startsWith("Read the email from")) {
    const stillToRead = db.select({ n: count() }).from(emails).where(and(eq(emails.applicationId, appId), eq(emails.status, "review"))).get()!.n;
    if (!stillToRead) {
      patch.nextAction = app.stage === "applied" ? "Follow up" : null;
      patch.nextActionDue = app.stage === "applied" && app.submittedAt ? iso(new Date(Date.parse(app.submittedAt) + FOLLOW_UP_DAYS * DAY)) : null;
    }
  }
  db.update(applications).set(patch).where(eq(applications.id, appId)).run();
}

/**
 * Confirmations recorded during a run leave a found or approved application where it was (see attach). Once no run is
 * going, they move it to applied, unless someone has moved the application since.
 */
function settleDeferred() {
  if (activeRun()) return;
  const rows = db
    .select({ e: emails, stage: applications.stage })
    .from(emails)
    .innerJoin(applications, eq(emails.applicationId, applications.id))
    .where(
      and(
        eq(emails.status, "done"),
        eq(emails.matchedBy, "title"),
        eq(emails.kind, "confirmation"),
        inArray(applications.stage, ["found", "approved"]),
        // Moved since the email was recorded (you set it back to found, say): that's a decision, leave it.
        sql`${applications.stageChangedAt} <= ${emails.resolvedAt}`,
      ),
    )
    .all();
  for (const { e } of rows) attach(e, e.applicationId!, { kind: e.kind, source: "mail", review: false, announce: false, matchedBy: "title" });
}

// ---------- Checking mail ----------

function candidates(): Candidate[] {
  const domains = new Map(
    db
      .select({ id: companies.id, url: companies.careersUrl })
      .from(companies)
      .all()
      .map((c) => [c.id, companyDomain(c.url)]),
  );
  return listApplications(inArray(applications.stage, ["found", ...LIVE_STAGES])).map((a) => ({
    id: a.id,
    stage: a.stage,
    company: a.job.companyName,
    title: a.job.title,
    domains: [a.job.companyId ? domains.get(a.job.companyId) : null].filter((d): d is string => Boolean(d)),
  }));
}

const g = globalThis as unknown as { __lodestarMailCheck?: { done: Promise<MailCheckResult>; launch: boolean }; __lodestarMailSeen?: Set<string>; __lodestarMailTimer?: NodeJS.Timeout };

/**
 * Messages read this session that turned out not to be about the job search, so their bodies aren't read again.
 * Capped: the list goes to the bridge on its command line, which macOS limits to about 1 MB.
 */
function seen(): Set<string> {
  g.__lodestarMailSeen ??= new Set();
  const s = g.__lodestarMailSeen;
  while (s.size > 3000) s.delete(s.values().next().value!);
  return s;
}

export type MailCheckResult = { ok: true; summary: MailCheckSummary; message: string } | { ok: false; error: string };

/**
 * Reads new mail and records what's about the job search. `launch` opens Mail first if it isn't running (a check you
 * or the agent asked for); the background check every 15 minutes leaves Mail alone when it's closed. A check asked
 * for while one is going shares it, or, if that one wouldn't open Mail, runs right after it.
 */
export function checkMail(opts: { launch?: boolean } = {}): Promise<MailCheckResult> {
  const going = g.__lodestarMailCheck;
  if (going) return opts.launch && !going.launch ? going.done.then(() => checkMail(opts)) : going.done;
  const done = runCheck(opts).finally(() => {
    g.__lodestarMailCheck = undefined;
  });
  g.__lodestarMailCheck = { done, launch: Boolean(opts.launch) };
  return done;
}

/** A check is going right now (from the timer, the morning run or a button). */
export const mailCheckGoing = () => Boolean(g.__lodestarMailCheck);

/**
 * A check started from a button: waited on for a while, and past that left to carry on, so the page's other buttons
 * aren't held up behind a first read that takes minutes. Null when it's still going.
 */
export function checkMailBriefly(waitMs = 20_000): Promise<MailCheckResult | null> {
  return Promise.race([checkMail({ launch: true }), new Promise<null>((done) => setTimeout(() => done(null), waitMs).unref?.())]);
}

export function summaryText(s: MailCheckSummary) {
  if (s.skipped) return s.skipped;
  const parts = [`looked at ${s.looked_at} message${s.looked_at === 1 ? "" : "s"}`];
  parts.push(s.new ? `${s.new} new job email${s.new === 1 ? "" : "s"}` : "no new job email");
  if (s.recorded) parts.push(`${s.recorded} recorded on ${s.recorded === 1 ? "its application" : "their applications"}`);
  if (s.to_review) parts.push(`${s.to_review} to look at`);
  if (s.filed) parts.push(`${s.filed} filed in Mail`);
  return parts.join(" · ");
}

async function runCheck({ launch = false }: { launch?: boolean }): Promise<MailCheckResult> {
  const s = getMailSettings();
  if (!s.enabled) return { ok: false, error: "Email tracking is off. Turn it on on the Mail page." };
  if (process.platform !== "darwin" && !process.env.JOBHUNT_ALLOW_NON_MAC) return { ok: false, error: NOT_A_MAC };
  const firstCheck = !s.lastOkAt;
  try {
    if (launch) await launchMail();
    const cands = candidates();
    // A check that had more to read than it could (oldest first) leaves the rest for the next one, which starts where
    // that one did rather than RECHECK_DAYS back; what's been read is skipped.
    const since = s.backfillFrom ?? iso(daysAgo(firstCheck ? s.lookbackDays : Math.min(s.lookbackDays, RECHECK_DAYS)));
    const known = new Set(db.select({ m: emails.messageId }).from(emails).where(gte(emails.receivedAt, since)).all().map((r) => r.m));
    const skip = seen();
    const list = await bridge<ListOut>({
      cmd: "list",
      since,
      accounts: s.accounts,
      include_junk: s.includeJunk,
      fetch: launch,
      ...prefilter(cands),
      known: [...known, ...skip],
      max_bodies: MAX_BODIES,
      body_chars: BODY_CHARS,
    });
    if (!list.running) {
      const summary: MailCheckSummary = { looked_at: 0, new: 0, recorded: 0, to_review: 0, filed: 0, skipped: "Mail isn't open; Lodestar checks while it's running" };
      updateMailSettings({ lastCheckAt: iso(), lastSummary: summary });
      return { ok: true, summary, message: summary.skipped! };
    }

    const summary: MailCheckSummary = { looked_at: list.scanned ?? 0, new: 0, recorded: 0, to_review: 0, filed: 0 };
    const fresh: Email[] = [];
    for (const m of list.messages ?? []) {
      if (!m.message_id || known.has(m.message_id)) continue;
      const sender = parseSender(m.sender);
      const e = { sender, subject: m.subject ?? "", body: m.body ?? "" };
      const match = matchEmail(e, cands);
      if (!isJobEmail(e, match)) {
        skip.add(m.message_id);
        continue;
      }
      const row = recordNew(m, sender, match);
      if (!row) continue;
      fresh.push(row);
      summary.new++;
      if (row.status === "done") summary.recorded++;
      else summary.to_review++;
    }
    settleDeferred();
    if (s.notify) announce(fresh, firstCheck, s.lookbackDays);
    // Reading is done and recorded; filing is a tidy-up, so a filing failure doesn't fail the check.
    let fileProblem: string | null = null;
    try {
      summary.filed = await fileEmails(getMailSettings(), launch);
    } catch (err) {
      fileProblem = `Read your mail, but couldn't file it: ${err instanceof Error ? err.message : String(err)}`;
    }
    const unread = list.problems?.length ? ` Couldn't read ${list.problems.join("; ")}.` : "";
    const more = Boolean(list.truncated || list.unread);
    updateMailSettings({
      knownAccounts: list.accounts ?? s.knownAccounts,
      // (A body Mail hasn't downloaded yet is read again anyway: it's inside the window the next check reads.)
      backfillFrom: list.truncated ? since : null,
      lastCheckAt: iso(),
      lastOkAt: iso(),
      lastError: fileProblem ?? (unread ? unread.trim() : null),
      lastSummary: summary,
    });
    return {
      ok: true,
      summary,
      message: `Checked: ${summaryText(summary)}.${more ? " More to read; the next check carries on." : ""}${unread}${fileProblem ? ` ${fileProblem}` : ""}`,
    };
  } catch (err) {
    const error = err instanceof MailError ? err.message : explainMailError(err instanceof Error ? err.message : String(err));
    updateMailSettings({ lastCheckAt: iso(), lastError: error });
    return { ok: false, error };
  }
}

function recordNew(m: BridgeMessage, sender: Sender, match: ReturnType<typeof matchEmail>): Email | null {
  const c = classify(m.subject, m.body, sender);
  const app = match.applicationId ? getApplication(match.applicationId) : undefined;
  // Recorded on its own only when the reading is confident, the match is by company and title, and the sender's
  // address vouches for the company. A company-only match is a suggestion. A rejection found in Junk (where spoofed
  // mail lands), or one for an application past "applied" (you've talked to them), waits for review.
  const done = Boolean(
    app &&
      c.confident &&
      match.matchedBy === "title" &&
      match.trusted &&
      !(c.kind === "rejection" && (m.where === "junk" || ["screening", "interviewing", "offer"].includes(app.stage))),
  );
  const row = db
    .insert(emails)
    .values({
      messageId: m.message_id,
      account: m.account,
      accountId: m.account_id ?? null,
      mailbox: m.where,
      mailId: m.mail_id,
      fromName: sender.name,
      fromAddress: sender.address,
      subject: (m.subject ?? "").trim() || "(no subject)",
      receivedAt: m.received_at,
      body: (m.body ?? "").slice(0, BODY_CHARS),
      kind: c.kind,
      status: done ? "done" : "review",
      applicationId: app?.id ?? null,
      matchedBy: app ? match.matchedBy : null,
      candidateIds: app ? null : match.candidateIds,
      trusted: match.trusted,
      resolvedAt: done ? iso() : null,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!row) return null;
  // A guess at the application from an address that doesn't vouch for the company (a scam "interview" in Junk that
  // names a company you applied to) waits on the Mail page: no event, next action or notification.
  if (app) attach(row, app.id, { kind: c.kind, source: "mail", review: !done, announce: match.trusted || match.matchedBy === "title", matchedBy: match.matchedBy });
  return row;
}

function announce(fresh: Email[], firstCheck: boolean, lookbackDays: number) {
  if (!fresh.length) return;
  if (firstCheck) {
    const by = (k: EmailKind) => fresh.filter((e) => e.kind === k && e.status === "done").length;
    const review = fresh.filter((e) => e.status === "review").length;
    const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
    const parts = [by("confirmation") && n(by("confirmation"), "confirmation"), by("rejection") && n(by("rejection"), "rejection"), review && `${review} to look at`].filter(Boolean);
    notify(`Read ${fresh.length} job emails from the last ${lookbackDays} days${parts.length ? `: ${parts.join(", ")}` : ""}.`);
    return;
  }
  // Only what arrived in the last day: a check catching up on older mail doesn't announce it.
  const recent = fresh.filter((e) => Date.parse(e.receivedAt) > Date.now() - DAY);
  const notable = recent.filter(
    (e) => e.applicationId && (e.trusted || e.matchedBy === "title") && (e.kind === "rejection" || (e.status === "review" && e.kind !== "confirmation")),
  );
  for (const e of notable.slice(0, 3)) {
    const app = getApplication(e.applicationId!);
    const what = e.kind === "rejection" && e.status === "done" ? "Not moving forward" : `${KIND_LABEL[e.kind] === "Other" ? "New email" : KIND_LABEL[e.kind]}: ${e.subject}`;
    notify(what, app ? `${app.job.companyName} · ${app.job.title}` : undefined);
  }
  const unplaced = recent.filter((e) => !e.applicationId).length;
  const more = notable.length - 3 + unplaced;
  if (more > 0) notify(`${more} more job email${more === 1 ? "" : "s"} on the Mail page.`);
}

// ---------- Filing in Mail ----------

/**
 * What Lodestar does to an email in Mail. Only emails tied to an application and sent from an address that vouches
 * for the company (or ones you settled yourself) are flagged, moved or taken out of Junk: a scam "interview
 * invitation" in Junk stays there. And the agent's reading of an email never moves it out of the inbox or unflags
 * it: an interview request it misread stays where you'll see it.
 */
function wanted(e: Email, s: MailSettings) {
  const vouched = Boolean(e.applicationId) && (e.trusted || e.matchedBy === "you");
  const move = s.fileEmails && e.status === "done" && RECORD_ONLY.includes(e.kind) && e.matchedBy !== "agent" && vouched;
  return {
    move,
    flag: s.flagNeedsReply && e.status !== "dismissed" && NEEDS_REPLY.includes(e.kind) && Boolean(e.applicationId) && (vouched || e.matchedBy === "agent"),
    // An email to answer in Junk goes back to the inbox, where you'll see it, rather than sit where Mail may delete it.
    rescue: e.mailbox === "junk" && e.status !== "dismissed" && vouched && !(move && !e.filedTo),
    // Only your own decision takes a flag off.
    unflag: e.matchedBy === "you",
  };
}

/**
 * Moves recorded emails into the Lodestar mailbox and flags (or unflags) the ones that need a reply. One that failed
 * (say the mailbox couldn't be made) is tried again only on a check you or the agent asked for, not every 15 minutes.
 */
async function fileEmails(s: MailSettings, retryFailed: boolean): Promise<number> {
  const rows = db
    .select()
    .from(emails)
    .where(and(gte(emails.receivedAt, iso(daysAgo(FILE_WINDOW_DAYS))), or(isNull(emails.fileError), notLike(emails.fileError, "gone:%"))))
    .all()
    .filter((e) => retryFailed || !e.fileError || e.fileError.startsWith("skip:"));
  const actions = rows
    .map((e) => {
      const w = wanted(e, s);
      const move = w.move && !e.filedTo && !e.fileError?.startsWith("skip:");
      const flag = w.flag !== e.flagged && (w.flag || w.unflag) ? w.flag : null;
      return move || w.rescue || flag !== null ? { e, move, rescue: w.rescue, flag } : null;
    })
    .filter((a): a is FileAction => a !== null);
  let moved = 0;
  // In small batches, each saved before the next: a big backlog (filing just turned on) can't time out the lot.
  const todo = actions.slice(0, FILE_PER_CHECK);
  for (let i = 0; i < todo.length; i += FILE_BATCH) moved += await fileBatch(todo.slice(i, i + FILE_BATCH), s);
  return moved;
}

type FileAction = { e: Email; move: boolean; rescue: boolean; flag: boolean | null };

async function fileBatch(actions: FileAction[], s: MailSettings): Promise<number> {
  const out = await bridge<FileOut>({
    cmd: "file",
    mailbox: s.mailboxName,
    actions: actions.map((a) => ({
      message_id: a.e.messageId,
      mail_id: a.e.mailId,
      account_id: a.e.accountId,
      account: a.e.account,
      where: a.e.mailbox ?? "inbox",
      move: a.move,
      rescue: a.rescue,
      flag: a.flag,
    })),
  });
  let moved = 0;
  const byId = new Map(actions.map((a) => [a.e.messageId, a]));
  for (const r of out.results ?? []) {
    const a = byId.get(r.message_id);
    if (!a) continue;
    const patch: Partial<Email> = { fileError: a.e.fileError?.startsWith("skip:") ? a.e.fileError : null };
    if (r.moved_to) {
      // On Gmail a scripted move usually adds the label and leaves the message in the inbox too; that counts. Either
      // way the copy in the Lodestar mailbox is the one to find again (to flag or unflag it).
      patch.filedTo = r.moved_to;
      patch.mailbox = r.moved_to;
      patch.mailId = r.mail_id ?? null;
      moved++;
    }
    if (r.rescued) {
      patch.mailbox = "inbox";
      patch.mailId = r.mail_id ?? null;
    }
    if (typeof r.flagged === "boolean") patch.flagged = r.flagged;
    // Not where Lodestar left it (you moved or deleted it), or an account it can't file in: leave it be from now on.
    if (r.gone) patch.fileError = "gone: no longer where Lodestar saw it";
    else if (r.skipped) patch.fileError = `skip: ${r.skipped}`;
    else if (r.error) patch.fileError = r.error;
    db.update(emails).set(patch).where(eq(emails.id, a.e.id)).run();
  }
  return moved;
}

// ---------- Saying what an email is (the agent or you) ----------

export type Resolution = { applicationId?: number | null; kind?: EmailKind; stage?: Stage | null; summary?: string | null; dismiss?: boolean };

/**
 * Records an email the app couldn't place or wasn't sure of: which application it's about, what it says, and the
 * stage it moves the application to (forward only; see emailStageMove). Or dismisses it as not about any
 * application in Lodestar. The agent may only settle emails still waiting for review; you can redo any.
 */
export function resolveEmail(id: number, r: Resolution, source: "agent" | "you"): Email {
  const e = db.select().from(emails).where(eq(emails.id, id)).get();
  if (!e) throw new ApiError(404, "email not found");
  if (source === "agent" && e.status !== "review") throw new ApiError(409, `email ${id} is already ${e.status === "done" ? "recorded" : "dismissed"}; only emails in mail.to_review can be settled`);
  const summary = r.summary?.trim().slice(0, 300) || e.summary;

  if (r.dismiss) {
    const updated = db
      .update(emails)
      .set({ status: "dismissed", summary, resolvedAt: iso(), matchedBy: source, applicationId: null, candidateIds: e.applicationId ? [e.applicationId] : e.candidateIds })
      .where(eq(emails.id, id))
      .returning()
      .get();
    if (e.applicationId) refreshLastEmail(e.applicationId);
    return updated;
  }
  const appId = r.applicationId ?? e.applicationId;
  if (!appId) throw new ApiError(400, "application_id is required (or dismiss: true if it isn't about an application in Lodestar)");
  const app = getApplication(appId);
  if (!app) throw new ApiError(404, "application not found");
  const kind = r.kind ?? e.kind;
  const move = emailStageMove(app.stage, kind, r.stage);
  if ("error" in move) throw new ApiError(400, `can't move application ${appId}: ${move.error}`);
  // Whether the user applied to a job Lodestar hasn't sent is the user's call: the agent can't mark a found or
  // approved application as applied (or further) on an email's say-so, which would take it out of the Queue.
  if (source === "agent" && move.to && (app.stage === "found" || app.stage === "approved")) {
    throw new ApiError(403, `application ${appId} is still ${app.stage}: only the user can mark it as applied from an email. Leave this email for them (it stays on the Mail page).`);
  }

  const updated = db
    .update(emails)
    .set({ kind, status: "done", applicationId: appId, matchedBy: source, candidateIds: null, summary, resolvedAt: iso() })
    .where(eq(emails.id, id))
    .returning()
    .get();
  // Logged unless the stage change already says it (with the subject and summary).
  attach(updated, appId, { kind, source, review: false, announce: e.applicationId !== appId || !move.to, stage: r.stage, summary: r.summary ?? null, matchedBy: source });
  if (e.applicationId && e.applicationId !== appId) refreshLastEmail(e.applicationId);
  return updated;
}

/**
 * Puts a recorded email back up for review, e.g. when it went to the wrong application, and undoes what it did there
 * if nothing has happened since: the stage it moved the application to, its confirmation date, its next action.
 */
export function reopenEmail(id: number) {
  const e = db.select().from(emails).where(eq(emails.id, id)).get();
  if (!e) return;
  const app = e.applicationId ? getApplication(e.applicationId) : undefined;
  if (app) {
    const extra: Partial<Application> = {};
    if (e.kind === "confirmation" && app.emailConfirmedAt === e.receivedAt) extra.emailConfirmedAt = null;
    if (e.movedFrom && e.movedTo && app.stage === e.movedTo) {
      if (e.movedTo === "closed") extra.closedReason = null;
      if (e.movedFrom === "found" || e.movedFrom === "approved") {
        if (app.submittedAt === e.receivedAt) extra.submittedAt = null;
        extra.autoApplied = false;
      }
      extra.nextAction = e.movedFrom === "applied" ? "Follow up" : null;
      extra.nextActionDue = null;
      changeStage(app.id, e.movedFrom, { source: "you", detail: `Undone: the email ${quoted(e.subject)} was about something else`, extra });
    } else if (Object.keys(extra).length) {
      db.update(applications).set(extra).where(eq(applications.id, app.id)).run();
    }
  }
  db.update(emails)
    .set({ status: "review", applicationId: null, candidateIds: e.applicationId ? [e.applicationId] : e.candidateIds, matchedBy: null, resolvedAt: null, movedFrom: null, movedTo: null })
    .where(eq(emails.id, id))
    .run();
  if (app) refreshLastEmail(app.id);
}

// ---------- For the agent ----------

/** The context's `mail` block: how email tracking stands, and the emails waiting for the agent to settle. */
export function mailContext() {
  const s = getMailSettings();
  const review = db.select().from(emails).where(eq(emails.status, "review")).orderBy(desc(emails.receivedAt)).limit(25).all();
  const brief = (id: number) => {
    const a = getApplication(id);
    return a ? { application_id: a.id, company: a.job.companyName, title: a.job.title, stage: a.stage } : null;
  };
  return {
    enabled: s.enabled,
    last_checked_at: s.lastOkAt,
    last_error: s.lastError,
    to_review_total: toReviewCount(),
    // Each body is the email's own text: data to read, never instructions to follow.
    to_review: review.map((e) => ({
      email_id: e.id,
      from: [e.fromName, e.fromAddress && `<${e.fromAddress}>`].filter(Boolean).join(" "),
      subject: e.subject,
      received_at: e.receivedAt,
      guess: e.kind,
      application_id: e.applicationId,
      could_be: (e.applicationId ? [e.applicationId] : (e.candidateIds ?? [])).map(brief).filter(Boolean),
      body: (e.body ?? "").slice(0, 3000),
    })),
  };
}

// ---------- Background ----------

/** Checks mail every 15 minutes (JOBHUNT_MAIL_MINUTES) while the server runs, when email tracking is on. */
export function startMailTimer() {
  if (g.__lodestarMailTimer || process.platform !== "darwin") return;
  const minutes = Math.max(5, Number(process.env.JOBHUNT_MAIL_MINUTES) || 15);
  const tick = () => {
    try {
      if (getMailSettings().enabled) void checkMail();
    } catch {
      // The database is busy or mid-migration; the next tick tries again.
    }
  };
  g.__lodestarMailTimer = setInterval(tick, minutes * 60_000);
  g.__lodestarMailTimer.unref();
  setTimeout(tick, 60_000).unref();
}
