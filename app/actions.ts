"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/lib/db";
import { FOLLOW_UP_DAYS, changeStage, daysFromNow, getApplication, getProfile, hasMaterials, iso, lastFinishedRun, logEvent, matchCompany } from "@/lib/logic";
import { renderMaterials } from "@/lib/render";
import { startAgentRun, stopAgentRun } from "@/lib/runner";
import { checkMailBriefly, getMailSettings, reopenEmail, resolveEmail, updateMailSettings, type Resolution } from "@/lib/mail";
import { ApiError } from "@/lib/agent-auth";
import { HIGHLIGHTS, PRIORITIES, SOURCES, STAGES, type Highlight, type Priority, type Stage, type WorkEntry, type EducationEntry, type BroadSearch, type Source } from "@/db/schema";

const refresh = () => {
  revalidatePath("/", "layout");
};

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
const lines = (f: FormData, k: string) =>
  (str(f, k) ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

// ---------- Queue ----------

export async function approveApplication(appId: number) {
  const app = getApplication(appId);
  if (!app || app.stage !== "found") return;
  if (!hasMaterials(app)) return;
  // Jobs at the current employer go through the internal job site, never the agent.
  if (app.internal) return;
  changeStage(appId, "approved", { source: "you", detail: "Submitting on next run" });
  refresh();
}

/** The user applied to a job at their current employer through the internal job site. */
export async function markAppliedInternally(appId: number) {
  const app = getApplication(appId);
  if (!app || (app.stage !== "found" && app.stage !== "approved")) return;
  changeStage(appId, "applied", {
    source: "you",
    detail: "Applied through the internal job site",
    extra: { submittedAt: iso(), needsSignin: false, portalNote: "Applied internally", nextAction: "Follow up", nextActionDue: iso(daysFromNow(FOLLOW_UP_DAYS)) },
  });
  refresh();
}

export async function skipApplication(appId: number, formData: FormData) {
  const app = getApplication(appId);
  if (!app || app.stage !== "found") return;
  const reason = str(formData, "reason") ?? "No reason given";
  changeStage(appId, "closed", { source: "you", detail: `Skipped: ${reason}`, extra: { closedReason: "skipped", skipReason: reason } });
  refresh();
}

export async function undoApplication(appId: number) {
  const app = getApplication(appId);
  if (!app) return;
  const undoable = app.stage === "approved" || (app.stage === "closed" && app.closedReason === "skipped");
  if (!undoable) return;
  changeStage(appId, "found", { source: "you", detail: "Undone", extra: { closedReason: null, skipReason: null } });
  refresh();
}

export async function runNow() {
  const r = await startAgentRun("all", "manual");
  refresh();
  return r;
}

export async function stopRun() {
  const r = stopAgentRun();
  // Give the script a moment to close the run record before the page re-renders.
  await new Promise((done) => setTimeout(done, 1500));
  refresh();
  return r;
}

/** Starts a run over the phases the last run didn't get through; the agent takes the item it stopped on first. */
export async function resumeRun() {
  const last = lastFinishedRun();
  if (!last?.unfinished) return { ok: false as const, error: "The last run finished on its own; nothing to resume. Use Run scan now." };
  const r = await startAgentRun(last.phasesLeft.join(","), "resume");
  refresh();
  return r;
}

export async function submitApprovedNow() {
  // The agent fills and submits nothing until the profile is confirmed, so a run now would do nothing.
  if (!getProfile().confirmed) return { ok: false as const, error: "Confirm your profile in Settings first; nothing is submitted until then." };
  const r = await startAgentRun("submit", "submit-now");
  refresh();
  return r;
}

// ---------- Application detail ----------

export async function saveMaterials(appId: number, formData: FormData) {
  const app = getApplication(appId);
  if (!app) return;
  if (!["found", "approved"].includes(app.stage)) return;
  const resumeMd = str(formData, "resume_md");
  const coverLetterMd = str(formData, "cover_letter_md");
  const version = (str(formData, "resume_version") as "resume" | "cv" | null) ?? app.resumeVersion ?? "resume";
  const answers: { question: string; answer: string }[] = [];
  for (let i = 0; formData.has(`q_${i}`); i++) {
    const q = str(formData, `q_${i}`);
    const a = str(formData, `a_${i}`);
    if (q) answers.push({ question: q, answer: a ?? "" });
  }
  const rendered = await renderMaterials(app.jobId, resumeMd, coverLetterMd, version);
  db.update(schema.applications)
    .set({
      resumeMd,
      coverLetterMd,
      resumeVersion: version,
      answers,
      resumePath: rendered.resumePath,
      coverLetterPath: rendered.coverLetterPath,
      materialsUpdatedAt: iso(),
    })
    .where(eq(schema.applications.id, appId))
    .run();
  logEvent({ applicationId: appId, type: "note", title: "Materials edited", source: "you" });
  refresh();
}

export async function saveTracking(appId: number, formData: FormData) {
  const app = getApplication(appId);
  if (!app) return;
  const stage = str(formData, "stage") as Stage | null;
  const extra = {
    notes: str(formData, "notes"),
    nextAction: str(formData, "next_action"),
    nextActionDue: str(formData, "next_action_due"),
    needsSignin: formData.get("needs_signin") === "on",
  };
  if (stage && STAGES.includes(stage) && stage !== app.stage) {
    const closedReason = stage === "closed" ? (str(formData, "closed_reason") ?? "withdrawn") : null;
    changeStage(appId, stage, { source: "you", extra: { ...extra, closedReason } });
  } else {
    db.update(schema.applications).set(extra).where(eq(schema.applications.id, appId)).run();
  }
  refresh();
}

export async function addNote(appId: number, formData: FormData) {
  const text = str(formData, "note");
  if (!text) return;
  logEvent({ applicationId: appId, type: "note", title: text.slice(0, 120), detail: text.length > 120 ? text : null, source: "you" });
  refresh();
}

// ---------- Companies ----------

export async function addCompany(formData: FormData) {
  const name = str(formData, "name");
  if (!name) return;
  const highlight = str(formData, "highlight") as Highlight | null;
  const priority = (str(formData, "priority") as Priority | null) ?? (highlight === "red" ? "high" : "normal");
  db.insert(schema.companies)
    .values({
      name,
      categories: [str(formData, "category") ?? "Other"],
      highlight: highlight && HIGHLIGHTS.includes(highlight) ? highlight : null,
      priority: PRIORITIES.includes(priority) ? priority : "normal",
      careersUrl: str(formData, "careers_url"),
    })
    .onConflictDoNothing()
    .run();
  refresh();
}

export async function updateCompany(id: number, formData: FormData) {
  const highlight = str(formData, "highlight") as Highlight | null;
  const priority = str(formData, "priority") as Priority | null;
  const categories = formData.getAll("categories").filter((c): c is string => typeof c === "string" && c !== "");
  db.update(schema.companies)
    .set({
      highlight: highlight && HIGHLIGHTS.includes(highlight) ? highlight : null,
      priority: priority && PRIORITIES.includes(priority) ? priority : "normal",
      careersUrl: str(formData, "careers_url"),
      atsType: str(formData, "ats_type"),
      ...(categories.length ? { categories } : {}),
    })
    .where(eq(schema.companies.id, id))
    .run();
  refresh();
  redirect("/companies");
}

export async function clearScanNote(id: number) {
  db.update(schema.companies).set({ scanNote: null, scanNoteAt: null }).where(eq(schema.companies.id, id)).run();
  refresh();
}

export async function deleteCompany(id: number) {
  const used = db.select().from(schema.jobs).where(eq(schema.jobs.companyId, id)).get();
  if (used) db.update(schema.companies).set({ priority: "paused" }).where(eq(schema.companies.id, id)).run();
  else db.delete(schema.companies).where(eq(schema.companies.id, id)).run();
  refresh();
  redirect("/companies");
}

// ---------- Lookups: a title or company to look for on the next scan ----------

export async function addLookup(formData: FormData) {
  const title = str(formData, "title")?.slice(0, 120) ?? null;
  const company = str(formData, "company")?.slice(0, 120) ?? null;
  if (!title && !company) redirect("/?lookup=empty#lookups");
  db.insert(schema.lookups)
    .values({ title, company, companyId: matchCompany(company)?.id ?? null, note: str(formData, "note")?.slice(0, 500) ?? null })
    .run();
  refresh();
  redirect("/#lookups");
}

export async function removeLookup(id: number) {
  // Only a lookup the agent hasn't got to yet; a done one is history (its jobs point at it).
  db.delete(schema.lookups).where(and(eq(schema.lookups.id, id), eq(schema.lookups.status, "pending"))).run();
  refresh();
}

/** Puts a settled lookup back in the queue for the next scan. */
export async function redoLookup(id: number) {
  db.update(schema.lookups).set({ status: "pending", doneAt: null, runId: null, result: null }).where(eq(schema.lookups.id, id)).run();
  refresh();
}

// ---------- Settings ----------

export async function saveProfile(formData: FormData) {
  let workHistory: WorkEntry[];
  let education: EducationEntry[];
  try {
    workHistory = JSON.parse(str(formData, "work_history") ?? "[]");
    education = JSON.parse(str(formData, "education") ?? "[]");
    if (!Array.isArray(workHistory) || !Array.isArray(education)) throw new Error();
  } catch {
    redirect("/settings?error=json");
  }
  const confirmed = formData.get("confirmed") === "on";
  const hasPlaceholders = /\[(CONFIRM|TITLE)[^\]]*\]/i.test(JSON.stringify(workHistory));
  db.update(schema.profile)
    .set({
      fullName: str(formData, "full_name") ?? "",
      email: str(formData, "email"),
      phone: str(formData, "phone"),
      location: str(formData, "location"),
      linkedinUrl: str(formData, "linkedin_url"),
      websiteUrl: str(formData, "website_url"),
      workAuthorization: str(formData, "work_authorization"),
      needsSponsorship: formData.get("needs_sponsorship") === "yes" ? true : formData.get("needs_sponsorship") === "no" ? false : null,
      workHistory,
      education,
      skills: lines(formData, "skills"),
      resumeFile: str(formData, "resume_file"),
      cvFile: str(formData, "cv_file"),
      resumeText: str(formData, "resume_text"),
      cvText: str(formData, "cv_text"),
      // Placeholders left in the work history keep the profile unconfirmed.
      confirmed: confirmed && !hasPlaceholders,
      updatedAt: iso(),
    })
    .where(eq(schema.profile.id, 1))
    .run();
  refresh();
  redirect(confirmed && hasPlaceholders ? "/settings?error=placeholders" : "/settings?saved=profile");
}

export async function saveCriteria(formData: FormData) {
  const broadSearches: BroadSearch[] = lines(formData, "broad_searches").map((l) => {
    const [label, ...rest] = l.split("|");
    return { label: label.trim(), query: (rest.join("|") || label).trim() };
  });
  const num = (k: string) => {
    const v = str(formData, k);
    return v == null ? null : Number(v.replace(/[^0-9.]/g, ""));
  };
  db.update(schema.searchCriteria)
    .set({
      primaryLocations: lines(formData, "primary_locations"),
      secondaryLocations: lines(formData, "secondary_locations"),
      workModes: lines(formData, "work_modes"),
      functions: lines(formData, "functions"),
      fitThreshold: num("fit_threshold") ?? 70,
      highPriorityThreshold: num("high_priority_threshold") ?? 60,
      minBase: num("min_base"),
      lookbackDays: num("lookback_days") ?? 7,
      broadSearches,
      notes: str(formData, "notes"),
      autoApply: formData.get("auto_apply") === "on",
      autoApplyMinScore: num("auto_apply_min_score") ?? 85,
      autoApplyDailyCap: num("auto_apply_daily_cap") ?? 10,
      autoApplySources: formData.getAll("auto_apply_sources").filter((v): v is Source => SOURCES.includes(v as Source)),
      currentEmployer: str(formData, "current_employer"),
      internalJobsUrl: str(formData, "internal_jobs_url"),
      updatedAt: iso(),
    })
    .where(eq(schema.searchCriteria.id, 1))
    .run();
  refresh();
  redirect("/settings?saved=criteria");
}

// ---------- Mail ----------

const STILL_CHECKING = "Still reading Mail; this page shows what it found when it's done.";

export async function connectMail() {
  updateMailSettings({ enabled: true, updatedAt: iso() });
  const r = await checkMailBriefly();
  refresh();
  if (!r) return { ok: true as const, message: `Connected. ${STILL_CHECKING}` };
  return r.ok ? { ok: true as const, message: `Connected. ${r.message}` } : r;
}

export async function checkMailNow() {
  const r = await checkMailBriefly();
  refresh();
  if (!r) return { ok: true as const, message: STILL_CHECKING };
  return r.ok ? { ok: true as const, message: r.message } : r;
}

export async function turnOffMail() {
  updateMailSettings({ enabled: false, updatedAt: iso() });
  refresh();
}

export async function saveMailSettings(formData: FormData) {
  const num = (k: string, fallback: number, max: number) => Math.min(max, Math.max(1, Number(str(formData, k)) || fallback));
  const known = getMailSettings().knownAccounts ?? [];
  const picked = formData.getAll("accounts").filter((a): a is string => typeof a === "string" && known.includes(a));
  if (known.length && !picked.length) redirect(`/mail?error=${encodeURIComponent("Pick at least one account to read, or turn email tracking off.")}`);
  updateMailSettings({
    // Mail treats "/" in a mailbox name as a folder path.
    mailboxName: (str(formData, "mailbox_name") ?? "Lodestar").replace(/[/\\:]/g, "-").slice(0, 60),
    fileEmails: formData.get("file_emails") === "on",
    flagNeedsReply: formData.get("flag_needs_reply") === "on",
    includeJunk: formData.get("include_junk") === "on",
    includeOther: formData.get("include_other") === "on",
    notify: formData.get("notify") === "on",
    // Every account ticked reads them all, including accounts added to Mail later.
    accounts: picked.length === known.length ? [] : picked,
    lookbackDays: num("lookback_days", 30, 120),
    updatedAt: iso(),
  });
  refresh();
  redirect("/mail?saved=1");
}

// What you say an email is, from the Mail page: the kind, and the stage it moves the application to.
const EMAIL_CHOICES: Record<string, Pick<Resolution, "kind" | "stage">> = {
  confirmation: { kind: "confirmation" },
  rejection: { kind: "rejection", stage: "closed" },
  screening: { kind: "interview", stage: "screening" },
  interviewing: { kind: "interview", stage: "interviewing" },
  assessment: { kind: "assessment" },
  offer: { kind: "offer", stage: "offer" },
  update: { kind: "update" },
  other: { kind: "other" },
};

export async function resolveEmailAction(id: number, formData: FormData) {
  const what = str(formData, "what") ?? "";
  const applicationId = Number(str(formData, "application_id")) || null;
  let error: string | null = null;
  try {
    if (what === "dismiss") resolveEmail(id, { dismiss: true }, "you");
    else if (!applicationId) error = 'Pick which application it\'s about, or click "Not job-related".';
    else if (EMAIL_CHOICES[what]) {
      const choice = { ...EMAIL_CHOICES[what], applicationId };
      try {
        resolveEmail(id, choice, "you");
      } catch (err) {
        // The application is already further along than that: record the email and leave the stage.
        if (!(err instanceof ApiError && err.status === 400 && choice.stage && applicationId)) throw err;
        resolveEmail(id, { ...choice, stage: undefined }, "you");
      }
    } else error = "Pick what the email is.";
  } catch (err) {
    error = err instanceof Error ? err.message : "Couldn't save that.";
  }
  refresh();
  // A redirect either way, so an error from an earlier try doesn't stay on the page.
  redirect(error ? `/mail?error=${encodeURIComponent(error)}#review` : "/mail#review");
}

// The Mail page's "Not job-related" button: whatever the dropdowns say, the email isn't about an application.
export async function dismissEmailAction(id: number) {
  let error: string | null = null;
  try {
    resolveEmail(id, { dismiss: true }, "you");
  } catch (err) {
    error = err instanceof Error ? err.message : "Couldn't save that.";
  }
  refresh();
  redirect(error ? `/mail?error=${encodeURIComponent(error)}#review` : "/mail#review");
}

export async function reopenEmailAction(id: number) {
  reopenEmail(id);
  refresh();
  redirect("/mail#review");
}
