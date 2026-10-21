import path from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull, or, lt } from "drizzle-orm";
import { db, schema, DATA_DIR } from "@/lib/db";
import { agentRoute } from "@/lib/agent-auth";
import { OPEN_STAGES, autoAppliedToday, bySubmitOrder, byWatchlistThenScore, autoApplyCandidates, portalOf, daysAgo, getCriteria, getProfile, hasMaterials, iso, listApplications, sweepFollowUps, thresholdFor, watchTier, type AppWithJob } from "@/lib/logic";

export const dynamic = "force-dynamic";

const { companies, applications } = schema;

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
  }));

  const found = listApplications(eq(applications.stage, "found")).sort(byWatchlistThenScore);
  const watchlist = (a: AppWithJob) => ["high", "watchlist", "off_watchlist"][watchTier(a)];
  const needsScore = found.filter((a) => a.job.fitScore == null);
  const needsMaterials = found.filter((a) => a.job.fitScore != null && !hasMaterials(a) && a.job.fitScore >= thresholdFor(a.job.companyId));

  const skipFeedback = listApplications(and(eq(applications.stage, "closed"), eq(applications.closedReason, "skipped"), isNotNull(applications.skipReason)))
    .slice(0, 40)
    .map((a) => ({ company: a.job.companyName, title: a.job.title, location: a.job.location, reason: a.skipReason }));

  return {
    today: new Date().toISOString().slice(0, 10),
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
    jobs_needing_score: needsScore.map((a) => ({ job_id: a.jobId, application_id: a.id, company: a.job.companyName, watchlist: watchlist(a), title: a.job.title, url: a.job.url, location: a.job.location })),
    jobs_needing_materials: needsMaterials.map((a) => ({
      job_id: a.jobId,
      application_id: a.id,
      company: a.job.companyName,
      watchlist: watchlist(a),
      title: a.job.title,
      url: a.job.url,
      fit_score: a.job.fitScore,
      fit_reasons: a.job.fitReasons,
    })),
    skip_feedback: skipFeedback,
  };
});
