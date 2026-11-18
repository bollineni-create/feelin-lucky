// The apply handoff. Lodestar finds, scores and prepares jobs; it doesn't apply. Jobs you send to the apply queue
// (the Queue's "Send to apply queue") are written out as a work list for whichever agent applies: a Claude chat,
// Claude Code, or a Grok bot on the Mac. The agent reports each result back by appending one JSON line to
// apply-results.jsonl next to the list (or with agent/api.sh), and Lodestar records it on the application.
//
//   data/handoff/apply-queue.json   what to apply to, with the profile facts and the materials' file paths
//   data/handoff/APPLY-QUEUE.md     the same as a readable list, with a prompt to paste into the agent
//   data/handoff/apply-results.jsonl  the agent appends one line per job it worked on
//
// With LODESTAR_HANDOFF_DIR set (e.g. a folder in iCloud Drive the Grok bridge reads), the same files go there
// too, with copies of each job's resume and cover letter, and results are read from there as well.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { and, eq, gte } from "drizzle-orm";
import { DATA_DIR, ROOT, db, schema } from "./db";
import { FOLLOW_UP_DAYS, STAGE_LABEL, bySubmitOrder, changeStage, clearSigninOnPortal, currentEmployer, daysFromNow, getApplication, getCriteria, getProfile, hasMaterials, iso, listApplications, logEvent, portalOf, type AppWithJob } from "./logic";
import { portalHost, splitSigninWaits } from "./signin";

const { applications } = schema;

// LODESTAR_HANDOFF_LOCAL_DIR moves it (the tests use a scratch folder).
export const HANDOFF_DIR = process.env.LODESTAR_HANDOFF_LOCAL_DIR ?? path.join(DATA_DIR, "handoff");
export const QUEUE_JSON = "apply-queue.json";
export const QUEUE_MD = "APPLY-QUEUE.md";
export const RESULTS_FILE = "apply-results.jsonl";
const ARCHIVE_FILE = "apply-results.archive.jsonl";

/** The extra folder the handoff is mirrored to (LODESTAR_HANDOFF_DIR), with ~ expanded. */
export function mirrorDir(): string | null {
  const v = process.env.LODESTAR_HANDOFF_DIR?.trim();
  if (!v) return null;
  return path.resolve(v.replace(/^~(?=$|\/)/, os.homedir()));
}

export type ApplyItem = {
  application_id: number;
  job_id: number;
  company: string;
  title: string;
  location: string | null;
  url: string | null;
  source: string;
  portal: string;
  fit_score: number | null;
  fit_reasons: string[];
  sent_to_queue_at: string;
  resume_version: string | null;
  resume_file: string | null;
  resume_docx: string | null;
  cover_letter_file: string | null;
  cover_letter_docx: string | null;
  answers: { question: string; answer: string }[];
  needs_signin: boolean;
  portal_note: string | null;
};

export type ApplyQueue = {
  generated_at: string;
  how_to_report: string;
  profile_confirmed: boolean;
  profile: Record<string, unknown>;
  items: ApplyItem[];
  /** Sent to the queue, but waiting on something only the user can do. Not for the agent. */
  waiting: { application_id: number; company: string; title: string; why: string }[];
};

const docx = (p: string | null) => p?.replace(/\.pdf$/, ".docx") ?? null;

function toItem(a: AppWithJob): ApplyItem {
  return {
    application_id: a.id,
    job_id: a.jobId,
    company: a.job.companyName,
    title: a.job.title,
    location: a.job.location,
    url: a.job.url,
    source: a.job.source,
    portal: portalOf(a),
    fit_score: a.job.fitScore,
    fit_reasons: a.job.fitReasons ?? [],
    sent_to_queue_at: a.stageChangedAt,
    resume_version: a.resumeVersion,
    resume_file: a.resumePath,
    resume_docx: docx(a.resumePath),
    cover_letter_file: a.coverLetterPath,
    cover_letter_docx: docx(a.coverLetterPath),
    answers: a.answers ?? [],
    needs_signin: a.needsSignin,
    portal_note: a.portalNote,
  };
}

/**
 * What the apply agent works on: applications the user sent to the apply queue (stage "approved") with materials
 * ready, quick boards first. Jobs at the current employer never go in (the user applies internally); forms waiting
 * on the user's answers, and portals still waiting on a sign-in, are listed under `waiting` instead.
 */
export function buildApplyQueue(): ApplyQueue {
  const profile = getProfile();
  const approved = listApplications(eq(applications.stage, "approved")).filter((a) => !a.internal);
  const waiting: ApplyQueue["waiting"] = [];
  const ready: AppWithJob[] = [];
  for (const a of approved) {
    if (!hasMaterials(a)) waiting.push({ application_id: a.id, company: a.job.companyName, title: a.job.title, why: "materials aren't ready" });
    else if (a.needsAnswers) waiting.push({ application_id: a.id, company: a.job.companyName, title: a.job.title, why: `the form needs answers from you: ${a.portalNote ?? "see the job page"}` });
    else ready.push(a);
  }
  // An agent that may create careers-site accounts gets the sign-in-walled jobs too: the wall is its to clear.
  const split = profile.agentCreatesAccounts ? { toSubmit: ready.sort(bySubmitOrder) } : splitSigninWaits(ready.sort(bySubmitOrder));
  for (const a of ready.filter((x) => !split.toSubmit.includes(x))) {
    waiting.push({ application_id: a.id, company: a.job.companyName, title: a.job.title, why: `${portalHost(a.job.url, a.job.companyName)} still wants a sign-in; press I've signed in on the Queue once you have` });
  }
  const employer = currentEmployer();
  return {
    generated_at: iso(),
    how_to_report: `Append one JSON line per job to ${RESULTS_FILE} in this folder: {"application_id": N, "result": "applied" | "needs_signin" | "needs_answers" | "posting_closed" | "failed", "note": "...", "confirmation": "...", "by": "claude" | "grok"}`,
    profile_confirmed: profile.confirmed,
    profile: {
      full_name: profile.fullName,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      linkedin_url: profile.linkedinUrl,
      website_url: profile.websiteUrl,
      work_authorization: profile.workAuthorization,
      needs_sponsorship: profile.needsSponsorship,
      work_history: profile.workHistory,
      education: profile.education,
      skills: profile.skills,
      current_employer: employer,
      min_base: getCriteria().minBase,
      // Answers to the questions forms keep asking; use them before reporting needs_answers.
      standing_answers: profile.standingAnswers,
      // True: you may create a careers-site account when a portal requires one (see APPLY.md rule 2).
      agent_may_create_accounts: profile.agentCreatesAccounts,
    },
    // Nothing goes out until the user has confirmed every title and date in Settings.
    items: profile.confirmed ? split.toSubmit.map(toItem) : [],
    waiting,
  };
}

/** The prompt to paste into a Claude chat or a Grok bot, pointing it at the queue and the rules. */
export function applyPrompt(dir: string, count: number): string {
  return [
    `Apply to the ${count} job${count === 1 ? "" : "s"} in Lodestar's apply queue for me.`,
    `The list is ${path.join(dir, QUEUE_JSON)} (the same list, readable: ${path.join(dir, QUEUE_MD)}). The rules are ${path.join(ROOT, "agent", "APPLY.md")}: follow them exactly.`,
    `Use my browser and my existing sign-ins. Fill every form only from the profile in the queue (its standing_answers cover the questions forms keep asking) and each job's answers, upload that job's resume and cover letter files, submit once, and screenshot the confirmation.`,
    `Accounts: follow APPLY.md rule 2 (try Apple Passwords autofill first; when the profile allows it, create a careers-site account in Safari with Hide My Email and Safari's suggested strong password). Never solve a CAPTCHA, enter a code from my phone, or guess a required answer: stop on that job and report it.`,
    `After each job, append one line to ${path.join(dir, RESULTS_FILE)}: {"application_id": N, "result": "applied" | "needs_signin" | "needs_answers" | "posting_closed" | "failed", "note": "<one line>", "confirmation": "<confirmation number or headline>", "by": "<claude or grok>"}.`,
  ].join("\n");
}

function queueMarkdown(q: ApplyQueue, dir: string, materialsDir: string | null): string {
  const out: string[] = [];
  out.push(`# Lodestar apply queue`, "", `Generated ${q.generated_at}. ${q.items.length} to apply to${q.waiting.length ? `, ${q.waiting.length} waiting on you` : ""}.`, "");
  if (!q.profile_confirmed) out.push("> **Nothing to apply to yet:** the profile isn't confirmed in Lodestar's Settings. Confirm every title and date there first.", "");
  out.push("## Prompt for Claude or a Grok bot", "", "```", applyPrompt(dir, q.items.length), "```", "");
  const standing = (q.profile.standing_answers as { question: string; answer: string }[] | undefined) ?? [];
  if (standing.length) {
    out.push("## Standing answers (every form)", "");
    for (const a of standing) out.push(`- **${a.question}** ${a.answer}`);
    out.push("");
  }
  q.items.forEach((it, i) => {
    out.push(`## ${i + 1}. ${it.title} · ${it.company}`, "");
    const signin = !it.needs_signin
      ? ""
      : q.profile.agent_may_create_accounts
        ? " · needs a careers-site account: sign in, or create one in Safari as APPLY.md rule 2 allows (Hide My Email + Safari's strong password, saved to Apple Passwords)"
        : " · asked for a sign-in last time: one quick look, then report needs_signin if it still does";
    out.push(`- Application ID: **${it.application_id}** · portal: ${it.portal}${signin}`);
    out.push(`- Posting: ${it.url ?? "(no URL recorded)"}${it.location ? ` · ${it.location}` : ""}`);
    if (it.fit_score != null) out.push(`- Fit ${it.fit_score}: ${it.fit_reasons.join("; ")}`);
    const res = materialsDir ? path.join(materialsDir, String(it.application_id), path.basename(it.resume_file ?? "")) : it.resume_file;
    const cl = materialsDir ? path.join(materialsDir, String(it.application_id), path.basename(it.cover_letter_file ?? "")) : it.cover_letter_file;
    out.push(`- ${it.resume_version === "cv" ? "CV" : "Resume"}: ${res ?? "(not rendered)"}`, `- Cover letter: ${cl ?? "(not rendered)"}`);
    if (it.answers.length) {
      out.push("- Screening answers:");
      for (const a of it.answers) out.push(`  - **${a.question}** ${a.answer}`);
    }
    out.push("");
  });
  if (q.waiting.length) {
    out.push("## Waiting on you (not for the agent)", "");
    for (const w of q.waiting) out.push(`- ${w.title} · ${w.company} (#${w.application_id}): ${w.why}`);
    out.push("");
  }
  return out.join("\n");
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Copies each item's rendered files into <dir>/materials/<application_id>/ and removes folders no longer queued. */
function mirrorMaterials(dir: string, items: ApplyItem[]) {
  const root = path.join(dir, "materials");
  fs.mkdirSync(root, { recursive: true });
  const keep = new Set(items.map((i) => String(i.application_id)));
  for (const name of fs.readdirSync(root)) {
    if (/^\d+$/.test(name) && !keep.has(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  for (const it of items) {
    const dest = path.join(root, String(it.application_id));
    fs.mkdirSync(dest, { recursive: true });
    for (const f of [it.resume_file, it.resume_docx, it.cover_letter_file, it.cover_letter_docx]) {
      if (f && fs.existsSync(f)) fs.copyFileSync(f, path.join(dest, path.basename(f)));
    }
  }
  return root;
}

/** Writes the apply queue to data/handoff/ (and the mirror folder, if set). Returns where it went. */
export function writeHandoff(): { dirs: string[]; count: number; waiting: number; errors: string[] } {
  const q = buildApplyQueue();
  const dirs: string[] = [];
  const errors: string[] = [];
  const targets: [string, boolean][] = [[HANDOFF_DIR, false]];
  const mirror = mirrorDir();
  if (mirror && path.resolve(mirror) !== path.resolve(HANDOFF_DIR)) targets.push([mirror, true]);
  for (const [dir, isMirror] of targets) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const materials = isMirror ? mirrorMaterials(dir, q.items) : null;
      // In the mirror folder the file paths point at its own copies, so an agent that only sees that folder can upload them.
      const local = (f: string | null, id: number) => (f && materials ? path.join(materials, String(id), path.basename(f)) : f);
      const out = materials
        ? {
            ...q,
            items: q.items.map((i) => ({
              ...i,
              resume_file: local(i.resume_file, i.application_id),
              resume_docx: local(i.resume_docx, i.application_id),
              cover_letter_file: local(i.cover_letter_file, i.application_id),
              cover_letter_docx: local(i.cover_letter_docx, i.application_id),
            })),
          }
        : q;
      writeAtomic(path.join(dir, QUEUE_JSON), JSON.stringify(out, null, 2));
      writeAtomic(path.join(dir, QUEUE_MD), queueMarkdown(q, dir, materials));
      dirs.push(dir);
    } catch (e) {
      errors.push(`${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { dirs, count: q.items.length, waiting: q.waiting.length, errors };
}

// ---------- results coming back ----------

export const ApplyResult = z.object({
  application_id: z.number().int().positive(),
  result: z.enum(["applied", "needs_signin", "needs_answers", "posting_closed", "failed"]),
  note: z.string().max(2000).nullish(),
  confirmation: z.string().max(2000).nullish(),
  by: z.string().max(40).nullish(),
});
export type ApplyResultLine = z.infer<typeof ApplyResult>;

/**
 * Records one result from the apply agent. Only applications in the apply queue (stage "approved") can be marked
 * applied or closed, never a job at the current employer, and nothing here can approve a job: same rules as the
 * agent API. Returns what it did, or why it refused.
 */
export function recordApplyResult(r: ApplyResultLine): { ok: true; did: string } | { ok: false; error: string } {
  const app = getApplication(r.application_id);
  if (!app) return { ok: false, error: `application ${r.application_id} not found` };
  const who = r.by ? `the ${r.by} apply agent` : "the apply agent";
  const note = r.note?.trim() || null;
  if (r.result === "applied") {
    if (app.internal) return { ok: false, error: `#${app.id} is at your current employer: apply internally and mark it on the Queue` };
    if (app.stage !== "approved") return { ok: false, error: `#${app.id} is "${app.stage}", not in the apply queue` };
    changeStage(app.id, "applied", {
      source: r.by ?? "apply-agent",
      detail: `Applied by ${who}${note ? `: ${note}` : ""}`,
      extra: {
        submittedAt: iso(),
        needsSignin: false,
        needsAnswers: false,
        confirmationText: r.confirmation ?? app.confirmationText,
        nextAction: "Follow up",
        nextActionDue: iso(daysFromNow(FOLLOW_UP_DAYS)),
      },
    });
    clearSigninOnPortal(app);
    return { ok: true, did: "applied" };
  }
  if (r.result === "posting_closed") {
    if (app.stage !== "approved") return { ok: false, error: `#${app.id} is "${app.stage}", not in the apply queue` };
    changeStage(app.id, "closed", { source: r.by ?? "apply-agent", detail: `Posting closed (${who})${note ? `: ${note}` : ""}`, extra: { closedReason: "posting_closed", nextAction: null, nextActionDue: null } });
    return { ok: true, did: "closed" };
  }
  if (app.stage !== "approved") return { ok: false, error: `#${app.id} is "${app.stage}", not in the apply queue` };
  if (r.result === "needs_signin") {
    db.update(applications).set({ needsSignin: true, needsAnswers: false, signinCheckedAt: iso(), portalNote: note ?? app.portalNote }).where(eq(applications.id, app.id)).run();
    logEvent({ applicationId: app.id, type: "portal_update", title: "Needs you: portal sign-in", detail: note ?? "The portal wanted an account, password or CAPTCHA.", source: r.by ?? "apply-agent" });
    return { ok: true, did: "flagged sign-in" };
  }
  if (r.result === "needs_answers") {
    db.update(applications).set({ needsAnswers: true, needsSignin: false, portalNote: note ?? app.portalNote }).where(eq(applications.id, app.id)).run();
    logEvent({ applicationId: app.id, type: "portal_update", title: "Needs you: answers for the form", detail: note ?? "The form asks for something the profile doesn't have.", source: r.by ?? "apply-agent" });
    return { ok: true, did: "flagged answers" };
  }
  logEvent({ applicationId: app.id, type: "note", title: `Apply attempt failed (${who})`, detail: note, source: r.by ?? "apply-agent" });
  return { ok: true, did: "noted failure" };
}

/**
 * Reads apply-results.jsonl from data/handoff/ and the mirror folder, records each line, and moves what it read
 * into apply-results.archive.jsonl (with what happened), so a line is never recorded twice. The file is renamed
 * before it's read: an agent appending at that moment starts a new file and nothing is lost. Nothing here throws:
 * a file iCloud can't hand over yet is left for the next tick, so a stuck mirror never stops the queue being rewritten.
 */
const STALE_BATCH_MS = 10 * 60_000;

function touchedSince(appId: number, at: number) {
  const since = new Date(at).toISOString();
  return Boolean(
    db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(and(eq(schema.events.applicationId, appId), gte(schema.events.at, since)))
      .get(),
  );
}
export function importApplyResults(now = Date.now()): { recorded: number; refused: string[] } {
  let recorded = 0;
  const refused: string[] = [];
  const dirs = [HANDOFF_DIR, mirrorDir()].filter((d): d is string => Boolean(d));
  for (const dir of [...new Set(dirs.map((d) => path.resolve(d)))]) {
    const file = path.join(dir, RESULTS_FILE);
    const batches: { file: string; at: number; stale: boolean }[] = [];
    // A batch left behind by an earlier read that failed part-way (an iCloud file evicted mid-read, the app quit):
    // read it again. Lines already recorded are refused the second time, so nothing is recorded twice.
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(`${RESULTS_FILE}.reading-`)) continue;
        const at = Number(name.slice(`${RESULTS_FILE}.reading-`.length));
        if (Number.isFinite(at) && now - at > STALE_BATCH_MS) batches.push({ file: path.join(dir, name), at, stale: true });
      }
    } catch {
      continue;
    }
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 0) {
        const taken = `${file}.reading-${now}`;
        fs.renameSync(file, taken);
        batches.push({ file: taken, at: now, stale: false });
      }
    } catch {
      // Can't take the file this tick (iCloud busy); the next one tries again.
    }
    for (const { file: taken, at, stale } of batches) {
      let text: string;
      try {
        text = fs.readFileSync(taken, "utf8");
      } catch {
        continue; // Not readable yet (an evicted iCloud file downloads on access); kept for the next tick.
      }
      const archived: string[] = [];
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        let outcome: string;
        try {
          const parsed = ApplyResult.parse(JSON.parse(line));
          // A stale batch may have been recorded before its read failed: any event on the job since the batch was
          // taken means it was (or the user has moved it on), so the line is archived without being applied again.
          const r = stale && touchedSince(parsed.application_id, at) ? { ok: false as const, error: `#${parsed.application_id} already handled since this batch` } : recordApplyResult(parsed);
          if (r.ok) {
            recorded++;
            outcome = r.did;
          } else {
            refused.push(r.error);
            outcome = `refused: ${r.error}`;
          }
        } catch (e) {
          const why = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e);
          refused.push(`unreadable line: ${why}`);
          outcome = `unreadable: ${why}`;
        }
        archived.push(JSON.stringify({ at: iso(), line, outcome }));
      }
      try {
        fs.appendFileSync(path.join(dir, ARCHIVE_FILE), archived.map((l) => `${l}\n`).join(""));
        fs.rmSync(taken, { force: true });
      } catch {
        // The archive couldn't be written; the batch stays and is read again later, where recorded lines are refused.
      }
    }
  }
  return { recorded, refused };
}

/** Reads results that came back, then rewrites the queue. Safe to call often. */
/**
 * Auto-queue: when it's on (Settings → Search), every found job scoring at least the auto-queue score, with its
 * résumé and cover letter ready, goes straight to the apply queue, no Queue click needed. Jobs at the current
 * employer never do (they go through the internal job site), and a job the user moved out of the apply queue back to
 * Found stays out (undoing a skip doesn't count: that job was never queued). Returns how many it queued.
 */
export function autoQueue(): number {
  const c = getCriteria();
  if (!c.autoApply) return 0;
  const min = c.autoApplyMinScore;
  const pulledBack = new Set(
    db
      .select({ id: schema.events.applicationId })
      .from(schema.events)
      .where(and(eq(schema.events.type, "status_change"), eq(schema.events.source, "you"), eq(schema.events.title, `${STAGE_LABEL.approved} → ${STAGE_LABEL.found}`)))
      .all()
      .map((e) => e.id),
  );
  let queued = 0;
  for (const a of listApplications(eq(schema.applications.stage, "found"))) {
    if (a.internal || !hasMaterials(a) || a.job.fitScore == null || a.job.fitScore < min || pulledBack.has(a.id)) continue;
    changeStage(a.id, "approved", { source: "agent", detail: `Auto-queued: fit ${a.job.fitScore} (auto-queue at ${min}+)` });
    queued++;
  }
  return queued;
}

export function syncHandoff() {
  const imported = importApplyResults();
  const autoQueued = autoQueue();
  const written = writeHandoff();
  try {
    notifyGrok();
  } catch {
    // The bridge folder is offline (iCloud) or read-only; the next tick tries again.
  }
  return { ...written, recorded: imported.recorded, refused: imported.refused, auto_queued: autoQueued };
}

/**
 * The Grok bridge folder, when the apply queue is mirrored into it: LODESTAR_GROK_BRIDGE_DIR, or the mirror folder's
 * parent when that holds the bridge's TO-GROK.md and PROTOCOL.md.
 */
export function grokBridgeDir(): string | null {
  const set = process.env.LODESTAR_GROK_BRIDGE_DIR?.trim();
  if (set) return path.resolve(set.replace(/^~(?=$|\/)/, os.homedir()));
  const m = mirrorDir();
  if (!m) return null;
  const parent = path.dirname(m);
  return fs.existsSync(path.join(parent, "TO-GROK.md")) && fs.existsSync(path.join(parent, "PROTOCOL.md")) ? parent : null;
}

const NOTIFY_STATE = "grok-notified.json";
const NOTIFY_EVERY_MS = 60 * 60_000;

/**
 * Tells the Grok bots when new jobs are ready to apply to: one line appended to the bridge's TO-GROK.md (which wakes
 * the Chairman) and INBOX.md, in the bridge protocol's shape. At most once an hour, and only when the queue holds
 * jobs it hasn't announced yet. LODESTAR_GROK_NOTIFY=0 turns it off.
 */
export function notifyGrok(now = new Date()): { sent: boolean; fresh: number } {
  if (process.env.LODESTAR_GROK_NOTIFY === "0") return { sent: false, fresh: 0 };
  const bridge = grokBridgeDir();
  if (!bridge) return { sent: false, fresh: 0 };
  const q = buildApplyQueue();
  const statePath = path.join(HANDOFF_DIR, NOTIFY_STATE);
  let state: { announced: number[]; at: string | null } = { announced: [], at: null };
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    // First run.
  }
  // Only jobs still in the queue count as announced: one that left (held for answers or a sign-in) and came back is
  // new to the Grok bots again.
  const inQueue = new Set(q.items.map((i) => i.application_id));
  const announced = new Set(state.announced.filter((id) => inQueue.has(id)));
  const fresh = q.items.filter((i) => !announced.has(i.application_id));
  const save = (at: string | null, ids: Iterable<number>) => {
    fs.mkdirSync(HANDOFF_DIR, { recursive: true });
    writeAtomic(statePath, JSON.stringify({ announced: [...ids], at }));
  };
  if (announced.size !== state.announced.length) save(state.at, announced);
  if (!fresh.length) return { sent: false, fresh: 0 };
  if (state.at && now.getTime() - new Date(state.at).getTime() < NOTIFY_EVERY_MS) return { sent: false, fresh: fresh.length };
  const where = path.relative(bridge, path.join(mirrorDir() ?? HANDOFF_DIR, QUEUE_MD)) || QUEUE_MD;
  const names = fresh.slice(0, 5).map((i) => `${i.company} (#${i.application_id})`).join(", ");
  const line =
    `NOTE [Claude] ${LODESTAR_TASK}: Lodestar apply queue: ${fresh.length} new job${fresh.length === 1 ? "" : "s"} ready (${q.items.length} in all) — ${names}${fresh.length > 5 ? ", …" : ""}. ` +
    `Job Postings bot: work ${where} under ${LODESTAR_TASK}; report each job in ${path.basename(path.dirname(path.join(bridge, where)))}/${RESULTS_FILE}.\n`;
  fs.appendFileSync(path.join(bridge, "TO-GROK.md"), `\n${line}`);
  fs.appendFileSync(path.join(bridge, "INBOX.md"), `\n${line}`);
  save(now.toISOString(), [...announced, ...fresh.map((i) => i.application_id)]);
  return { sent: true, fresh: fresh.length };
}

/** The standing Grok task (TASKS.md in the bridge) that covers applying from the queue. */
export const LODESTAR_TASK = "T-20261116-LODESTAR";

const g = globalThis as unknown as { __lodestarHandoffTimer?: NodeJS.Timeout };

/** Every two minutes while the app runs: pick up results from the apply agent and refresh the queue file. */
export function startHandoffTimer() {
  if (g.__lodestarHandoffTimer) return;
  const minutes = Math.max(1, Number(process.env.LODESTAR_HANDOFF_MINUTES) || 2);
  const tick = () => {
    try {
      syncHandoff();
    } catch {
      // The database is busy or mid-migration; the next tick tries again.
    }
  };
  g.__lodestarHandoffTimer = setInterval(tick, minutes * 60_000);
  g.__lodestarHandoffTimer.unref();
  setTimeout(tick, 20_000).unref();
}
