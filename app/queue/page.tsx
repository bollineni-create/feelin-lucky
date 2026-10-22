import Link from "next/link";
import { activeRun, autoApplyCandidates, currentEmployer, getCriteria, getProfile, iso, queueItems, type AppWithJob } from "@/lib/logic";
import { fmtDate, modeLabel, shortCity, sourceLabel } from "@/lib/format";
import { Hl } from "@/components/Hl";
import { RunButton } from "@/components/RunButton";
import { approveApplication, markAppliedInternally, skipApplication, submitApprovedNow, undoApplication } from "../actions";

export const dynamic = "force-dynamic";

const SKIP_REASONS = ["Not the right function", "Too junior", "Too senior", "Location doesn't work", "Pay too low", "Not interested in the company", "Already applied elsewhere"];

const Check = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ stroke: "var(--accent-text)" }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8.5l3 3 7-7" />
  </svg>
);

export default function QueuePage() {
  const items = queueItems();
  const pending = items.filter((a) => a.stage === "found");
  const approved = items.filter((a) => a.stage === "approved");
  const skipped = items.filter((a) => a.stage === "closed");
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const approvedToday = approved.filter((a) => a.stageChangedAt >= iso(startOfDay)).length;
  const profile = getProfile();
  const criteria = getCriteria();
  const running = activeRun();
  const autoIds = new Set(autoApplyCandidates().map((a) => a.id));
  const employer = currentEmployer();
  const internalCount = pending.filter((a) => a.internal).length;

  const modes = criteria.workModes;
  const criteriaLines = [
    modes[0] === "remote" ? `Remote first; ${modes.slice(1).join(" or ") || "nothing else"} OK` : `Work modes: ${modes.join(", ")}`,
    [criteria.primaryLocations.map(shortCity).join(", "), criteria.secondaryLocations.map(shortCity).join(", ")].filter(Boolean).join(", then "),
    criteria.functions.map((f, i) => (i ? f.toLowerCase() : f)).join(", "),
    `Minimum base: ${criteria.minBase ? `$${criteria.minBase.toLocaleString("en-US")}` : "[YOUR FLOOR]"}`,
    `Fit score of ${criteria.fitThreshold} or higher (${criteria.highPriorityThreshold} for red companies)`,
    criteria.autoApply ? `Auto-apply at ${criteria.autoApplyMinScore}+, up to ${criteria.autoApplyDailyCap} a day` : "Auto-apply off: every application waits for you",
    employer ? `${employer} jobs: you apply through the internal job site` : null,
  ].filter((l): l is string => Boolean(l));

  return (
    <div className="split" style={{ gap: 28 }}>
      <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 16, flexBasis: 640 }}>
        <div>
          <h1 style={{ fontSize: 34, fontWeight: 600, letterSpacing: "-0.01em" }}>Today&apos;s matches</h1>
          <p className="secondary" style={{ marginTop: 4 }}>
            Each one has a tailored resume, cover letter and answers ready. Approve to send it on the next run, or skip to teach the filter. Matches marked auto-apply go out on their own unless you skip them.
          </p>
        </div>

        {!profile.confirmed ? (
          <div className="banner" role="alert">
            Your profile isn&apos;t confirmed yet, so nothing will be submitted. Confirm your titles and dates in <Link href="/settings">Settings</Link>.
          </div>
        ) : null}

        {internalCount ? (
          <div className="banner apply-now">
            <span>
              {internalCount} {internalCount === 1 ? "match is" : "matches are"} at {employer}, your current employer. Apply through the internal job site with the materials
              here, then mark {internalCount === 1 ? "it" : "each one"} applied. The agent won&apos;t submit these.
            </span>
            {criteria.internalJobsUrl ? (
              <a className="btn" href={criteria.internalJobsUrl} target="_blank" rel="noreferrer">
                Open internal job site
              </a>
            ) : (
              <Link className="btn" href="/settings#employer">
                Add the internal site link
              </Link>
            )}
          </div>
        ) : null}

        {approved.length ? (
          <div className="banner ok apply-now">
            <span>
              {approved.length} approved {approved.length === 1 ? "job is" : "jobs are"} waiting to go out.{" "}
              {running ? `They go out after run #${running.id} finishes.` : "Apply now, or they go out on the next scheduled run."}
            </span>
            <RunButton action={submitApprovedNow} label={`Apply to ${approved.length} approved now`} pendingLabel="Starting…" primary disabled={Boolean(running) || !profile.confirmed} doneMessage="Applying. Watch Chrome; the run log on the Pipeline updates as it goes." />
          </div>
        ) : null}

        {items.length === 0 ? (
          <div className="panel">
            <h2>Nothing to review</h2>
            <p className="secondary">New matches land here after a run scores them and prepares materials.</p>
          </div>
        ) : null}

        <div className="qcards">
          {[...pending, ...approved, ...skipped].map((a) => (
            <QueueCard key={a.id} a={a} auto={autoIds.has(a.id)} internalUrl={criteria.internalJobsUrl} />
          ))}
        </div>
      </div>

      <aside className="side">
        <div className="panel">
          <h2>Today&apos;s run</h2>
          <dl className="dl">
            <dt>Matches waiting</dt>
            <dd>{pending.length}</dd>
            <dt>Approved today</dt>
            <dd>{approvedToday}</dd>
            <dt>Skipped today</dt>
            <dd>{skipped.length}</dd>
          </dl>
        </div>
        <div className="panel">
          <h2>Search criteria</h2>
          <ul className="bullets">
            {criteriaLines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <Link href="/settings#criteria" style={{ display: "inline-block", marginTop: 12, fontSize: 14, fontWeight: 500 }}>
            Edit criteria
          </Link>
        </div>
        <div className="panel-dark" style={{ fontSize: 13 }}>
          <div style={{ color: "var(--panel-dark-head)", fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Needs you</div>
          Portals that require a new account or sign-in are flagged instead of filled. You sign in once; the agent picks up from there on the next run.
        </div>
      </aside>
    </div>
  );
}

function QueueCard({ a, auto, internalUrl }: { a: AppWithJob; auto: boolean; internalUrl: string | null }) {
  const j = a.job;
  const answers = a.answers ?? [];
  const where = [j.location, modeLabel(j.workMode)].filter((x, i, arr) => x && !(i === 1 && arr[0]?.toLowerCase().includes(x.toLowerCase()))).join(" · ");
  const materials = [
    a.resumeMd ? (a.resumeVersion === "cv" ? "CV tailored" : "Resume tailored") : null,
    a.coverLetterMd ? "Cover letter drafted" : null,
    answers.length ? "Screening questions answered" : null,
  ].filter(Boolean) as string[];
  const needsYou = answers.filter((q) => q.answer.includes("[NEEDS YOU")).length;

  return (
    <article className={`qcard ${a.stage === "found" ? "" : "done"}`} aria-label={`${j.title} at ${j.companyName}`}>
      <div className="qtop">
        <div className="info">
          <div className="tags">
            <span className="tag accent">{sourceLabel(j.source)}</span>
            {where ? <span className="tag">{where}</span> : null}
            <span className="tag">Posted {j.postedAt ? fmtDate(j.postedAt) : "date n/a"}</span>
            {a.atsType ? <span className="tag">{a.atsType}</span> : null}
            {a.internal ? <span className="tag amber" title="Your current employer: apply through the internal job site">Apply internally</span> : null}
            {auto ? <span className="tag amber">Auto-applies next run</span> : null}
          </div>
          <h2>{j.title}</h2>
          <div className="co">
            <Hl color={a.companyHighlight} />
            {j.companyName} · Pay: {j.payText ?? "Not posted"}
          </div>
        </div>
        <div className="fitbox">
          <div className="l">Fit score</div>
          <div className="score">{j.fitScore ?? "—"}</div>
          <div className="fitbar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={j.fitScore ?? 0} aria-label="Fit score">
            <span style={{ width: `${j.fitScore ?? 0}%` }} />
          </div>
        </div>
      </div>

      <div className="qgrid">
        <div>
          <div className="label-caps">Why it fits</div>
          <ul className="reasons">
            {(j.fitReasons ?? []).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="label-caps">Ready to send</div>
          <ul className="checklist">
            {materials.map((m) => (
              <li key={m}>
                <Check />
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {a.needsSignin ? <div className="flag">{a.portalNote ?? "This portal needs an account or sign-in. Sign in once and the agent finishes the form on the next run."}</div> : null}
      {!a.needsSignin && needsYou ? (
        <div className="flag">
          {needsYou} screening {needsYou === 1 ? "answer needs" : "answers need"} your input. Fill {needsYou === 1 ? "it" : "them"} in under Review materials.
        </div>
      ) : null}

      <div className="qactions">
        {a.stage === "found" ? (
          <>
            {a.internal ? (
              <>
                {internalUrl ? (
                  <a className="btn btn-primary" href={internalUrl} target="_blank" rel="noreferrer">
                    Open internal job site
                  </a>
                ) : null}
                <form action={markAppliedInternally.bind(null, a.id)}>
                  <button className="btn" type="submit">
                    I applied internally
                  </button>
                </form>
              </>
            ) : (
              <form action={approveApplication.bind(null, a.id)}>
                <button className="btn btn-primary" type="submit">
                  Approve and submit
                </button>
              </form>
            )}
            <Link className="btn" href={`/jobs/${j.id}`}>
              Review materials
            </Link>
            <details>
              <summary className="btn btn-ghost">Skip</summary>
              <form className="skipbox" action={skipApplication.bind(null, a.id)}>
                <div className="field">
                  <label htmlFor={`reason-${a.id}`}>Why skip? Similar postings will rank lower.</label>
                  <input className="input" id={`reason-${a.id}`} name="reason" list={`reasons-${a.id}`} placeholder="Pick or type a reason" required />
                  <datalist id={`reasons-${a.id}`}>
                    {SKIP_REASONS.map((r) => (
                      <option key={r} value={r} />
                    ))}
                  </datalist>
                </div>
                <button className="btn btn-sm" type="submit">
                  Skip this job
                </button>
              </form>
            </details>
          </>
        ) : (
          <>
            <span className="done-text" style={{ color: a.stage === "approved" ? "var(--accent-text)" : "var(--ink-2)" }}>
              {a.stage === "approved" ? "Approved. Goes out when you apply to approved jobs, or on the next run." : `Skipped (${a.skipReason}). Similar postings will rank lower.`}
            </span>
            <form action={undoApplication.bind(null, a.id)}>
              <button className="btn" type="submit" style={{ padding: "10px 14px" }}>
                Undo
              </button>
            </form>
          </>
        )}
      </div>
    </article>
  );
}
