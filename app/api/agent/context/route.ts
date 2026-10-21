import path from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull, or, lt, sql } from "drizzle-orm";
import { db, schema, DATA_DIR } from "@/lib/db";
import { agentRoute } from "@/lib/agent-auth";
import { mailContext } from "@/lib/mail";
import { OPEN_STAGES, pendingLookups, autoAppliedToday, bySubmitOrder, byWatchlistThenScore, autoApplyCandidates, lastFinishedRun, portalOf, daysAgo, getCriteria, getProfile, hasMaterials, iso, listApplications, sweepFollowUps, thresholdFor, watchTier, type AppWithJob } from "@/lib/logic";

export const dynamic = "force-dynamic";

const { companies, applications, jobs } = schema;

export const GET = agentRoute(async (req) => {
  const url = new URL(req.url);
  const companyLimit = Math.min(Number(url.searchParams.get("companies_limit") ?? 40) || 40, 200);

  sweepFollowUps();
  const criteria = getCriteria();
  const profile = getProfile();
  const sourceDocs = path.join(DATA_DIR, "source-docs");

  // High priority: daily (20h slack so a 7:00 run never skips because yesterday's ran at 7:05). Normal: every 3 days. Paused: never.
  const companiesDue = db
    .select()
    .from(companies)
    .where(
      or(
        and(eq(companies.priority, "high"), or(isNull(companies.lastScannedAt), lt(companies.lastScannedAt, iso(new Date(Date.now() - 20 * 3_600_000))))),
        and(eq(companies.priority, "normal"), or(isNull(companies.lastScannedAt), lt(companies.lastScannedAt, iso(daysAgo(3))))),
      ),
    )
    .orderBy(asc(companies.lastScannedAt), asc(companies.name))
    .all();
  // Never-scanned first (NULLs sort first), then oldest scan; high priority ahead of normal. Array.sort is stable.
  companiesDue.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "high" ? -1 : 1));
  // Every due high-priority company goes out, whatever the limit. Normal ones fill the rest, but always
  // at least a few so they still rotate through when there are more red companies than the limit.
  const dueHigh = companiesDue.filter((c) => c.priority === "high");
  const dueNormal = companiesDue.filter((c) => c.priority !== "high");
  const companiesToScan = [...dueHigh, ...dueNormal.slice(0, Math.max(10, companyLimit - dueHigh.length))];

  const toSubmit = (a: AppWithJob) => ({
    application_id: a.id,
    job_id: a.jobId,
    company: a.job.companyName,
    title: a.job.title,
    url: a.job.url,
    source: a.job.source,
    ats_type: a.atsType,
    // The portal the application goes through, from the company's ATS or the posting's host. Quick boards
    // (linkedin, greenhouse, lever, ashby, smartrecruiters) come first in the list; workday, oracle, taleo,
    // eightfold, successfactors and icims usually want an account and come last.
    portal: portalOf(a),
    resume_version: a.resumeVersion,
    resume_file: a.resumePath,
    resume_docx: a.resumePath?.replace(/\.pdf$/, ".docx") ?? null,
    cover_letter_file: a.coverLetterPath,
    cover_letter_docx: a.coverLetterPath?.replace(/\.pdf$/, ".docx") ?? null,
    answers: a.answers ?? [],
    needs_signin: a.needsSignin,
  });
  const approved = listApplications(eq(applications.stage, "approved")).sort(bySubmitOrder).map(toSubmit);
  const autoApply = profile.confirmed ? autoApplyCandidates().map(toSubmit) : [];

  const open = listApplications(inArray(applications.stage, ["found", ...OPEN_STAGES])).map((a) => ({
    application_id: a.id,
    job_id: a.jobId,
    company: a.job.companyName,
    title: a.job.title,
    url: a.job.url,
    source: a.job.source,
    stage: a.stage,
    linkedin_status: a.linkedinStatus,
    submitted_at: a.submittedAt,
    next_action: a.nextAction,
    // From Apple Mail: when the employer's confirmation arrived, and the latest email about it.
    email_confirmed_at: a.emailConfirmedAt,
    last_email_at: a.lastEmailAt,
  }));

  const found = listApplications(eq(applications.stage, "found")).sort(byWatchlistThenScore);
  const watchlist = (a: AppWithJob) => ["high", "watchlist", "off_watchlist"][watchTier(a)];
  const needsScore = found.filter((a) => a.job.fitScore == null);
  // A job found for a lookup (the user asked for it) gets materials whatever it scored; the user decides in the Queue.
  const needsMaterials = found.filter((a) => a.job.fitScore != null && !hasMaterials(a) && (a.job.lookupId != null || a.job.fitScore >= thresholdFor(a.job.companyId)));

  // What the user asked the agent to look for on this scan: a title, a company, or both. Taken before the watchlist.
  const lookupsOut = pendingLookups().map((l) => {
    const co = l.companyId ? db.select().from(companies).where(eq(companies.id, l.companyId)).get() : undefined;
    const already = db.select({ n: sql<number>`count(*)` }).from(jobs).where(eq(jobs.lookupId, l.id)).get()!.n;
    return {
      lookup_id: l.id,
      title: l.title,
      company: l.company,
      company_id: co?.id ?? null,
      careers_url: co?.careersUrl ?? null,
      ats_type: co?.atsType ?? null,
      note: l.note,
      added_at: l.createdAt,
      // Jobs an earlier (stopped) run already posted for it.
      jobs_posted_so_far: already,
    };
  });

  const skipFeedback = listApplications(and(eq(applications.stage, "closed"), eq(applications.closedReason, "skipped"), isNotNull(applications.skipReason)))
    .slice(0, 40)
    .map((a) => ({ company: a.job.companyName, title: a.job.title, location: a.job.location, reason: a.skipReason }));

  const last = lastFinishedRun();

  return {
    today: new Date().toISOString().slice(0, 10),
    // The previous run. When `unfinished` is true it stopped (from the app, at the time limit, or a crash) in
    // `stopped_in` while on `note`; what it hadn't done is still listed in this context, so take that item first.
    last_run: last
      ? {
          run_id: last.run.id,
          status: last.run.status,
          finished_at: last.run.finishedAt,
          phases: last.run.phase,
          stopped_in: last.run.currentPhase,
          note: last.run.note,
          note_at: last.run.noteAt,
          errors: last.run.errors ?? [],
          unfinished: last.unfinished,
          phases_left: last.phasesLeft,
        }
      : null,
    criteria: {
      primary_locations: criteria.primaryLocations,
      secondary_locations: criteria.secondaryLocations,
      work_modes_in_priority_order: criteria.workModes,
      functions: criteria.functions,
      fit_threshold: criteria.fitThreshold,
      high_priority_threshold: criteria.highPriorityThreshold,
      min_base: criteria.minBase,
      lookback_days: criteria.lookbackDays,
      broad_searches: criteria.broadSearches,
      notes: criteria.notes,
    },
    profile: {
      confirmed: profile.confirmed,
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
      resume_source_file: profile.resumeFile ? path.join(sourceDocs, profile.resumeFile) : null,
      cv_source_file: profile.cvFile ? path.join(sourceDocs, profile.cvFile) : null,
      resume_text: profile.resumeText,
      cv_text: profile.cvText,
      document_rule:
        "Resume for corporate, finance, tech and fintech roles. CV for think tanks, universities, international organizations (OECD, World Bank, IMF, UN) and health or research roles.",
    },
    // Phase B starts here: for each, search the company's careers site (careers_url when it's on the watchlist) and
    // LinkedIn for the title, post what you find with `lookup_id`, then PATCH /api/agent/lookups/:id done.
    lookups: lookupsOut,
    companies_due: companiesToScan.map((c) => ({
      company_id: c.id,
      name: c.name,
      categories: c.categories,
      priority: c.priority,
      highlight: c.highlight,
      careers_url: c.careersUrl,
      ats_type: c.atsType,
      last_scanned_at: c.lastScannedAt,
      // What stopped the last scan, if anything (e.g. a site Claude in Chrome won't open). Try once; if it's still blocked, move on.
      scan_note: c.scanNote,
    })),
    companies_due_total: companiesDue.length,
    // The whole watchlist (not paused), so LinkedIn results can be checked against it.
    watchlist_companies: db
      .select({ name: companies.name, priority: companies.priority })
      .from(companies)
      .where(inArray(companies.priority, ["high", "normal"]))
      .orderBy(asc(companies.name))
      .all(),
    approved_to_submit: profile.confirmed ? approved : [],
    auto_apply: {
      enabled: criteria.autoApply && profile.confirmed,
      min_score: criteria.autoApplyMinScore,
      daily_cap: criteria.autoApplyDailyCap,
      applied_today: autoAppliedToday(),
      sources: criteria.autoApplySources,
    },
    // Strong matches the agent may submit without an approval (auto-apply on). Re-fetch after Phase C: newly prepared jobs land here.
    auto_apply_to_submit: autoApply,
    submit_blocked_reason: profile.confirmed
      ? null
      : approved.length
        ? "Profile is not confirmed in Settings. Do not fill or submit any application; report this in the run errors."
        : null,
    open_applications: open,
    jobs_needing_score: needsScore.map((a) => ({ job_id: a.jobId, application_id: a.id, company: a.job.companyName, watchlist: watchlist(a), title: a.job.title, url: a.job.url, location: a.job.location, lookup_id: a.job.lookupId })),
    jobs_needing_materials: needsMaterials.map((a) => ({
      job_id: a.jobId,
      application_id: a.id,
      company: a.job.companyName,
      watchlist: watchlist(a),
      title: a.job.title,
      url: a.job.url,
      fit_score: a.job.fitScore,
      fit_reasons: a.job.fitReasons,
      lookup_id: a.job.lookupId,
    })),
    skip_feedback: skipFeedback,
    // Email tracking (Apple Mail): emails the app couldn't place or wasn't sure of wait in to_review for Phase D (track).
    mail: mailContext(),
  };
});
