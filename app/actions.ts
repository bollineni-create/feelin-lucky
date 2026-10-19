"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/lib/db";
import { changeStage, getApplication, hasMaterials, iso, logEvent } from "@/lib/logic";
import { renderMaterials } from "@/lib/render";
import { startAgentRun } from "@/lib/runner";
import { HIGHLIGHTS, PRIORITIES, STAGES, type Highlight, type Priority, type Stage, type WorkEntry, type EducationEntry, type BroadSearch } from "@/db/schema";

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
  changeStage(appId, "approved", { source: "you", detail: "Submitting on next run" });
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
  const r = startAgentRun("all", "manual");
  refresh();
  return r;
}

export async function submitApprovedNow() {
  const r = startAgentRun("submit", "submit-now");
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

export async function deleteCompany(id: number) {
  const used = db.select().from(schema.jobs).where(eq(schema.jobs.companyId, id)).get();
  if (used) db.update(schema.companies).set({ priority: "paused" }).where(eq(schema.companies.id, id)).run();
  else db.delete(schema.companies).where(eq(schema.companies.id, id)).run();
  refresh();
  redirect("/companies");
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
      updatedAt: iso(),
    })
    .where(eq(schema.searchCriteria.id, 1))
    .run();
  refresh();
  redirect("/settings?saved=criteria");
}
