import Link from "next/link";
import { activeRun, getProfile, queueItems, type AppWithJob } from "@/lib/logic";
import { fmtDate, modeLabel, sourceLabel } from "@/lib/format";
import { Hl } from "@/components/Hl";
import { RunButton } from "@/components/RunButton";
import { approveApplication, skipApplication, submitApprovedNow, undoApplication } from "../actions";

export const dynamic = "force-dynamic";

const SKIP_REASONS = ["Not the right function", "Too junior", "Too senior", "Location doesn't work", "Pay too low", "Not interested in the company", "Already applied elsewhere"];

export default function QueuePage() {
  const items = queueItems();
  const pending = items.filter((a) => a.stage === "found");
  const approved = items.filter((a) => a.stage === "approved");
  const skipped = items.filter((a) => a.stage === "closed");
  const profile = getProfile();
  const running = activeRun();

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{fmtDate(new Date().toISOString(), { weekday: "long", month: "long", day: "numeric" })}</div>
          <h1>Today&apos;s queue</h1>
          <p className="sub">
            {pending.length} new {pending.length === 1 ? "match" : "matches"} to review
            {approved.length ? ` · ${approved.length} approved, submitting on next run` : ""}
          </p>
        </div>
        {approved.length ? (
          <RunButton action={submitApprovedNow} label="Submit approved now" pendingLabel="Starting…" primary disabled={Boolean(running) || !profile.confirmed} />
        ) : null}
      </div>

      {!profile.confirmed ? (
        <div className="banner" role="alert">
          Your profile isn&apos;t confirmed yet, so the agent won&apos;t submit anything. Confirm titles and dates in{" "}
          <Link href="/settings">Settings</Link> first.
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
          <QueueCard key={a.id} a={a} profileConfirmed={profile.confirmed} />
        ))}
      </div>
    </>
  );
}

function QueueCard({ a, profileConfirmed }: { a: AppWithJob; profileConfirmed: boolean }) {
  const j = a.job;
  const done = a.stage !== "found";
  const answers = a.answers ?? [];
  const checklist: [boolean, string][] = [
    [Boolean(a.resumeMd), a.resumeVersion === "cv" ? "CV tailored (3-page)" : "Resume tailored (1-page)"],
    [Boolean(a.coverLetterMd), "Cover letter drafted"],
    [answers.length > 0, answers.length ? `${answers.length} screening ${answers.length === 1 ? "answer" : "answers"}` : "No screening questions found"],
    [profileConfirmed, profileConfirmed ? "Profile confirmed" : "Profile not confirmed"],
  ];

  return (
    <article className={`qcard ${done ? "done" : ""}`} aria-label={`${j.companyName}, ${j.title}`}>
      <div>
        <div className="btn-row">
          <span className="tag">{sourceLabel(j.source)}</span>
          {a.atsType ? <span className="tag">{a.atsType}</span> : null}
          {a.stage === "approved" ? <span className="tag accent">Submitting on next run</span> : null}
          {a.stage === "closed" ? <span className="tag">Skipped · {a.skipReason}</span> : null}
        </div>
        <h2>
          <span className="btn-row" style={{ gap: 8, display: "inline-flex" }}>
            <Hl color={a.companyHighlight} />
            {j.companyName}
          </span>{" "}
          <span className="secondary" style={{ fontWeight: 500 }}>
            · {j.title}
          </span>
        </h2>
        <div className="facts">
          <span>{j.location ?? "Location n/a"}</span>
          {j.workMode ? <span>{modeLabel(j.workMode)}</span> : null}
          <span>Posted {j.postedAt ? fmtDate(j.postedAt) : "—"}</span>
          <span className="mono">{j.payText ?? "Pay not listed"}</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <div className="eyebrow">Why it fits</div>
          <ul className="reasons">
            {(j.fitReasons ?? []).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <div className="eyebrow">Fit score</div>
        <div className="fit" style={{ marginTop: 6 }}>
          <span className="score">{j.fitScore ?? "—"}</span>
          <div className="fitbar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={j.fitScore ?? 0} aria-label="Fit score">
            <span style={{ width: `${j.fitScore ?? 0}%` }} />
          </div>
        </div>
        <div className="eyebrow" style={{ marginTop: 16 }}>
          Ready to send
        </div>
        <ul className="checklist">
          {checklist.map(([ok, label]) => (
            <li key={label}>
              <span className={ok ? "ok" : "no"} aria-hidden>
                {ok ? "✓" : "!"}
              </span>
              {label}
            </li>
          ))}
        </ul>
        {a.needsSignin ? <div className="flag">Portal needs a sign-in or account. The agent won&apos;t create one; you&apos;ll need to submit this yourself.</div> : null}
        {a.portalNote && !a.needsSignin ? <div className="flag">{a.portalNote}</div> : null}
      </div>

      <div className="qactions">
        {a.stage === "found" ? (
          <>
            <form action={approveApplication.bind(null, a.id)}>
              <button className="btn btn-primary" type="submit">
                Approve and submit
              </button>
            </form>
            <Link className="btn" href={`/jobs/${j.id}`}>
              Review materials
            </Link>
            <details>
              <summary className="btn btn-ghost">Skip</summary>
              <form className="skipbox" action={skipApplication.bind(null, a.id)}>
                <div className="field">
                  <label htmlFor={`reason-${a.id}`}>Why skip? This tunes future scoring.</label>
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
            {j.url ? (
              <a className="btn btn-ghost" href={j.url} target="_blank" rel="noreferrer">
                Open posting ↗
              </a>
            ) : null}
          </>
        ) : (
          <>
            <form action={undoApplication.bind(null, a.id)}>
              <button className="btn" type="submit">
                Undo
              </button>
            </form>
            <Link className="btn btn-ghost" href={`/jobs/${j.id}`}>
              Review materials
            </Link>
          </>
        )}
      </div>
    </article>
  );
}
