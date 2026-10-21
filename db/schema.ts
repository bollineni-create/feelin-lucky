import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const STAGES = ["found", "approved", "applied", "screening", "interviewing", "offer", "closed"] as const;
export type Stage = (typeof STAGES)[number];

export const HIGHLIGHTS = ["red", "teal", "blue", "orange"] as const;
export type Highlight = (typeof HIGHLIGHTS)[number];

export const PRIORITIES = ["high", "normal", "paused"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SOURCES = ["careers", "linkedin"] as const;
export type Source = (typeof SOURCES)[number];

const now = () => new Date().toISOString();

export const companies = sqliteTable(
  "companies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    // A company can sit in more than one category (e.g. Valve, Salesforce).
    categories: text("categories", { mode: "json" }).$type<string[]>().notNull().default([]),
    highlight: text("highlight", { enum: HIGHLIGHTS }),
    careersUrl: text("careers_url"),
    atsType: text("ats_type"),
    priority: text("priority", { enum: PRIORITIES }).notNull().default("normal"),
    lastScannedAt: text("last_scanned_at"),
    // Why the agent couldn't scan the careers site last time (a site Claude in Chrome won't open, a page that
    // wouldn't load). Cleared when a scan succeeds. Shown on the watchlist so the user can fix it.
    scanNote: text("scan_note"),
    scanNoteAt: text("scan_note_at"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("companies_name_idx").on(t.name)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    companyId: integer("company_id").references(() => companies.id),
    // Denormalised so jobs at companies outside the watchlist still have a name.
    companyName: text("company_name").notNull(),
    source: text("source", { enum: SOURCES }).notNull(),
    externalId: text("external_id"),
    url: text("url"),
    title: text("title").notNull(),
    location: text("location"),
    workMode: text("work_mode", { enum: ["remote", "hybrid", "onsite"] }),
    payText: text("pay_text"),
    postedAt: text("posted_at"),
    description: text("description"),
    fitScore: integer("fit_score"),
    fitReasons: text("fit_reasons", { mode: "json" }).$type<string[]>(),
    firstSeenAt: text("first_seen_at").notNull().$defaultFn(now),
    dedupeKey: text("dedupe_key").notNull(),
  },
  (t) => [uniqueIndex("jobs_dedupe_idx").on(t.dedupeKey)],
);

export const applications = sqliteTable(
  "applications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id),
    stage: text("stage", { enum: STAGES }).notNull().default("found"),
    stageChangedAt: text("stage_changed_at").notNull().$defaultFn(now),
    // "resume" or "cv" — which source document was tailored.
    resumeVersion: text("resume_version"),
    resumeMd: text("resume_md"),
    coverLetterMd: text("cover_letter_md"),
    coverLetterPath: text("cover_letter_path"),
    resumePath: text("resume_path"),
    answers: text("answers", { mode: "json" }).$type<{ question: string; answer: string }[]>(),
    materialsUpdatedAt: text("materials_updated_at"),
    submittedAt: text("submitted_at"),
    confirmationScreenshot: text("confirmation_screenshot"),
    confirmationText: text("confirmation_text"),
    needsSignin: integer("needs_signin", { mode: "boolean" }).notNull().default(false),
    portalNote: text("portal_note"),
    nextAction: text("next_action"),
    nextActionDue: text("next_action_due"),
    closedReason: text("closed_reason"),
    skipReason: text("skip_reason"),
    notes: text("notes"),
    linkedinStatus: text("linkedin_status"),
    // Submitted by the agent under the auto-apply rules rather than a Queue approval.
    autoApplied: integer("auto_applied", { mode: "boolean" }).notNull().default(false),
    // When the employer's "we received your application" email arrived (Apple Mail), and the latest email about it.
    emailConfirmedAt: text("email_confirmed_at"),
    lastEmailAt: text("last_email_at"),
  },
  (t) => [uniqueIndex("applications_job_idx").on(t.jobId), index("applications_stage_idx").on(t.stage)],
);

export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull().$defaultFn(now),
  finishedAt: text("finished_at"),
  // The phases the run was started with (e.g. "submit,find,prepare,track"); never changed afterwards.
  phase: text("phase").notNull().default("all"),
  // The phase the agent says it is in right now, for a run in progress.
  currentPhase: text("current_phase"),
  trigger: text("trigger").notNull().default("schedule"),
  status: text("status", { enum: ["running", "ok", "failed"] }).notNull().default("running"),
  counts: text("counts", { mode: "json" }).$type<Record<string, number>>(),
  errors: text("errors", { mode: "json" }).$type<string[]>(),
  logPath: text("log_path"),
});

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: integer("application_id").references(() => applications.id),
    at: text("at").notNull().$defaultFn(now),
    type: text("type", { enum: ["status_change", "email", "portal_update", "note"] }).notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    source: text("source").notNull().default("agent"),
  },
  (t) => [index("events_app_idx").on(t.applicationId)],
);

// What an email about the job search says. The app is sure of confirmations, rejections and status updates on its
// own; interviews, assessments, offers and anything else wait for the agent or you to say what they are.
export const EMAIL_KINDS = ["confirmation", "rejection", "interview", "assessment", "offer", "update", "other"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

// "done": recorded on its application. "review": the agent or you still has to say what it is or which job it's
// about. "dismissed": not about any application in Lodestar.
export const EMAIL_STATUSES = ["done", "review", "dismissed"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** Emails about the job search, read from Apple Mail. Nothing else from the mailbox is kept. */
export const emails = sqliteTable(
  "emails",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // The RFC Message-ID header, which stays the same when the message moves between mailboxes.
    messageId: text("message_id").notNull(),
    // Where it is in Mail, to find it again quickly: the account, "inbox", "junk" or the mailbox Lodestar filed it
    // in, and Mail's own id for it there (which changes when it moves). Message-ID searches are slow in Mail.
    account: text("account"),
    mailbox: text("mailbox"),
    mailId: integer("mail_id"),
    fromName: text("from_name"),
    fromAddress: text("from_address"),
    subject: text("subject").notNull(),
    receivedAt: text("received_at").notNull(),
    // Plain text, trimmed.
    body: text("body"),
    kind: text("kind", { enum: EMAIL_KINDS }).notNull(),
    status: text("status", { enum: EMAIL_STATUSES }).notNull(),
    applicationId: integer("application_id").references(() => applications.id),
    // How it was tied to its application: "title" (company and job title), "company" (the only application in
    // flight there), "agent" or "you".
    matchedBy: text("matched_by"),
    // Applications it could be about, when the app couldn't tell which.
    candidateIds: text("candidate_ids", { mode: "json" }).$type<number[]>(),
    // One line from the agent or you on what it says.
    summary: text("summary"),
    // The mailbox Lodestar moved it to in Mail, whether Lodestar flagged it, and why filing it failed, if it did.
    filedTo: text("filed_to"),
    flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
    fileError: text("file_error"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    resolvedAt: text("resolved_at"),
  },
  (t) => [uniqueIndex("emails_message_idx").on(t.messageId), index("emails_app_idx").on(t.applicationId), index("emails_status_idx").on(t.status)],
);

export type MailCheckSummary = { looked_at: number; new: number; recorded: number; to_review: number; filed: number; skipped?: string };

/** Email tracking through Apple Mail: what to do, and how the last check went. One row (id 1). */
export const mailSettings = sqliteTable("mail_settings", {
  id: integer("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  // The mailbox Lodestar files job emails in, created inside each Mail account so it syncs to the phone.
  mailboxName: text("mailbox_name").notNull().default("Lodestar"),
  fileEmails: integer("file_emails", { mode: "boolean" }).notNull().default(true),
  flagNeedsReply: integer("flag_needs_reply", { mode: "boolean" }).notNull().default(true),
  includeJunk: integer("include_junk", { mode: "boolean" }).notNull().default(true),
  notify: integer("notify", { mode: "boolean" }).notNull().default(true),
  // Mail account names to read; empty reads them all.
  accounts: text("accounts", { mode: "json" }).$type<string[]>().notNull().default([]),
  lookbackDays: integer("lookback_days").notNull().default(30),
  knownAccounts: text("known_accounts", { mode: "json" }).$type<string[]>(),
  // The newest message the last check saw; the next one reads from a day before it.
  checkedThrough: text("checked_through"),
  lastCheckAt: text("last_check_at"),
  lastOkAt: text("last_ok_at"),
  lastError: text("last_error"),
  lastSummary: text("last_summary", { mode: "json" }).$type<MailCheckSummary>(),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export type BroadSearch = { label: string; query: string };

export const searchCriteria = sqliteTable("search_criteria", {
  id: integer("id").primaryKey(),
  primaryLocations: text("primary_locations", { mode: "json" }).$type<string[]>().notNull(),
  secondaryLocations: text("secondary_locations", { mode: "json" }).$type<string[]>().notNull(),
  workModes: text("work_modes", { mode: "json" }).$type<string[]>().notNull(),
  functions: text("functions", { mode: "json" }).$type<string[]>().notNull(),
  fitThreshold: integer("fit_threshold").notNull().default(70),
  highPriorityThreshold: integer("high_priority_threshold").notNull().default(60),
  minBase: integer("min_base"),
  lookbackDays: integer("lookback_days").notNull().default(7),
  broadSearches: text("broad_searches", { mode: "json" }).$type<BroadSearch[]>().notNull(),
  notes: text("notes"),
  // Auto-apply: the agent submits strong matches without waiting for a Queue approval.
  autoApply: integer("auto_apply", { mode: "boolean" }).notNull().default(false),
  autoApplyMinScore: integer("auto_apply_min_score").notNull().default(85),
  autoApplyDailyCap: integer("auto_apply_daily_cap").notNull().default(10),
  autoApplySources: text("auto_apply_sources", { mode: "json" }).$type<Source[]>().notNull().default(["careers", "linkedin"]),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export type WorkEntry = {
  employer: string;
  team?: string;
  title: string;
  start: string; // YYYY-MM
  end?: string | null; // YYYY-MM or null for current
  location?: string;
  bullets?: string[];
};
export type EducationEntry = { school: string; degree: string; field?: string; start?: string; end?: string };

export const profile = sqliteTable("profile", {
  id: integer("id").primaryKey(),
  fullName: text("full_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  location: text("location"),
  linkedinUrl: text("linkedin_url"),
  websiteUrl: text("website_url"),
  workAuthorization: text("work_authorization"),
  needsSponsorship: integer("needs_sponsorship", { mode: "boolean" }),
  workHistory: text("work_history", { mode: "json" }).$type<WorkEntry[]>().notNull(),
  education: text("education", { mode: "json" }).$type<EducationEntry[]>().notNull(),
  skills: text("skills", { mode: "json" }).$type<string[]>().notNull(),
  resumeFile: text("resume_file"),
  cvFile: text("cv_file"),
  resumeText: text("resume_text"),
  cvText: text("cv_text"),
  // Until this is true the agent must not fill or submit any application form.
  confirmed: integer("confirmed", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export type Company = typeof companies.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Application = typeof applications.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Event = typeof events.$inferSelect;
export type SearchCriteria = typeof searchCriteria.$inferSelect;
export type Profile = typeof profile.$inferSelect;
export type Email = typeof emails.$inferSelect;
export type MailSettings = typeof mailSettings.$inferSelect;
