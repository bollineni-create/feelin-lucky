import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema, DATA_DIR } from "@/lib/db";
import { STAGES } from "@/db/schema";
import { STAGE_LABEL, getApplicationByJob, getCriteria } from "@/lib/logic";
import { KIND_LABEL, mailLink } from "@/lib/mail";
import { fmtDate, fmtDateTime, modeLabel, sourceLabel } from "@/lib/format";
import { Hl } from "@/components/Hl";
import { CLOSED_REASONS, CLOSED_REASON_LABEL, closedReasonLabel, normalizeClosedReason } from "@/lib/outcome";
import { addNote, approveApplication, markAppliedInternally, markOutcome, saveMaterials, saveTracking, undoApplication } from "../../actions";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const jobId = Number((await params).id);
  if (!Number.isInteger(jobId)) notFound();
  const a = getApplicationByJob(jobId);
  if (!a) notFound();
  const j = a.job;
  const mail = db.select().from(schema.emails).where(eq(schema.emails.applicationId, a.id)).orderBy(desc(schema.emails.receivedAt)).all();
  const history = db.select().from(schema.events).where(eq(schema.events.applicationId, a.id)).orderBy(asc(schema.events.at), asc(schema.events.id)).all();
  const dir = path.join(DATA_DIR, "applications", String(jobId));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort() : [];
  const editable = a.stage === "found" || a.stage === "approved";
  const internalUrl = a.internal ? getCriteria().internalJobsUrl : null;
  const answers = [...(a.answers ?? []), { question: "", answer: "" }];
  const reason = normalizeClosedReason(a.closedReason);
  const otherReason = reason && !(CLOSED_REASONS as readonly string[]).includes(reason) ? reason : null;
  // After you've applied: one click for an interview, a rejection, or a job you've decided not to take.
  const canInterview = a.stage === "applied" || a.stage === "screening";
  const canClose = a.stage !== "found" && a.stage !== "closed";

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/" className="eyebrow">
            ← Pipeline
          </Link>
          <h1 className="btn-row" style={{ gap: 10, marginTop: 6 }}>
            <Hl color={a.companyHighlight} />
            {j.companyName} <span className="secondary" style={{ fontWeight: 500 }}>· {j.title}</span>
          </h1>
          <div className="facts btn-row small secondary" style={{ marginTop: 6 }}>
            <span className="tag accent">{a.stage === "closed" ? `Closed: ${closedReasonLabel(a.closedReason)}` : STAGE_LABEL[a.stage]}</span>
            <span className="tag">{sourceLabel(j.source)}</span>
            {j.lookupId ? (
              <Link className="tag amber" href="/#lookups" title="Found for something you asked the agent to look for; kept whatever it scored">
                You asked for this
              </Link>
            ) : null}
            {a.internal ? (
              <Link className="tag amber" href="/settings#employer" title="Your current employer: the agent prepares this but never submits it">
                Apply internally
              </Link>
            ) : null}
            {a.atsType ? <span className="tag">{a.atsType}</span> : null}
            <span>{j.location ?? "Location n/a"}</span>
            {j.workMode ? <span>{modeLabel(j.workMode)}</span> : null}
            <span className="mono">{j.payText ?? "Pay not listed"}</span>
            <span>Posted {fmtDate(j.postedAt)}</span>
            <span>First seen {fmtDate(j.firstSeenAt)}</span>
          </div>
        </div>
        <div className="btn-row">
          {a.stage === "found" && a.internal ? (
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
          ) : null}
          {a.stage === "found" && !a.internal ? (
            <form action={approveApplication.bind(null, a.id)}>
              <button className="btn btn-primary" type="submit" disabled={!a.resumeMd || !a.coverLetterMd}>
                Approve and submit
              </button>
            </form>
          ) : null}
          {a.stage === "approved" ? (
            <form action={undoApplication.bind(null, a.id)}>
              <button className="btn" type="submit">
                Undo approval
              </button>
            </form>
          ) : null}
          {j.url ? (
            <a className="btn" href={j.url} target="_blank" rel="noreferrer">
              Open posting ↗
            </a>
          ) : null}
        </div>
      </div>

      {a.internal && (a.stage === "found" || a.stage === "approved") ? (
        <div className="banner">
          This job is at {j.companyName}, your current employer. Apply through the internal job site using the materials below; the agent won&apos;t submit it. Then
          click <strong>I applied internally</strong>.
        </div>
      ) : null}
      {a.needsSignin ? <div className="banner">This portal needs a sign-in, account or CAPTCHA. The agent won&apos;t do that; submit it yourself and set the stage to Applied.</div> : null}
      {a.needsAnswers ? (
        <div className="banner">
          The form asked something your profile doesn&apos;t cover{a.portalNote ? `: ${a.portalNote}` : ""}. Add it under <Link href="/settings#answers">Standard answers</Link>, or in
          the screening answers below, and it goes out on the next run.
        </div>
      ) : null}

      <div className="grid-main">
        <div>
          {j.fitScore != null ? (
            <section className="panel">
              <h2>Fit {j.fitScore}</h2>
              <ul className="reasons">
                {(j.fitReasons ?? []).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel">
            <h2>Materials</h2>
            {files.length ? (
              <div className="files" style={{ marginBottom: 14 }}>
                {files.map((f) => (
                  <a key={f} className="btn btn-sm" href={`/files/${jobId}/${f}`} target="_blank" rel="noreferrer">
                    {f}
                  </a>
                ))}
              </div>
            ) : (
              <p className="small muted" style={{ marginBottom: 12 }}>
                No materials yet. The agent prepares them for jobs above the fit threshold.
              </p>
            )}
            <form action={saveMaterials.bind(null, a.id)} className="tabs-md">
              <div className="field" style={{ maxWidth: 280 }}>
                <label htmlFor="resume_version">Document</label>
                <select className="input" id="resume_version" name="resume_version" defaultValue={a.resumeVersion ?? "resume"} disabled={!editable}>
                  <option value="resume">Resume (1 page)</option>
                  <option value="cv">CV (3 pages)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="resume_md">{a.resumeVersion === "cv" ? "CV" : "Resume"} (Markdown)</label>
                <textarea className="input code" id="resume_md" name="resume_md" rows={16} defaultValue={a.resumeMd ?? ""} readOnly={!editable} />
              </div>
              <div className="field">
                <label htmlFor="cover_letter_md">Cover letter (Markdown)</label>
                <textarea className="input code" id="cover_letter_md" name="cover_letter_md" rows={12} defaultValue={a.coverLetterMd ?? ""} readOnly={!editable} />
              </div>
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label" style={{ marginBottom: 8 }}>
                  Screening answers
                </legend>
                {answers.map((qa, i) => (
                  <div key={i} className="field" style={{ paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
                    <input className="input" name={`q_${i}`} defaultValue={qa.question} placeholder={i === answers.length - 1 ? "Add a question" : ""} aria-label={`Question ${i + 1}`} readOnly={!editable} />
                    <textarea className="input" name={`a_${i}`} defaultValue={qa.answer} rows={3} aria-label={`Answer ${i + 1}`} style={{ minHeight: 80 }} readOnly={!editable} />
                  </div>
                ))}
              </fieldset>
              {editable ? (
                <div>
                  <button className="btn btn-primary" type="submit">
                    Save and re-render PDF/DOCX
                  </button>
                </div>
              ) : (
                <p className="small muted">Materials are locked once the application is submitted.</p>
              )}
            </form>
          </section>

          <section className="panel">
            <h2>Posting</h2>
            {j.description ? <div className="desc">{j.description}</div> : <p className="small muted">The agent hasn&apos;t captured the posting text yet.</p>}
          </section>
        </div>

        <aside>
          <section className="panel">
            <h2>Tracking</h2>
            {canInterview || canClose ? (
              <div className="btn-row" style={{ marginBottom: 16 }}>
                {canInterview ? (
                  <form action={markOutcome.bind(null, a.id, "interviewing")}>
                    <button className="btn btn-sm" type="submit">
                      Interviewing
                    </button>
                  </form>
                ) : null}
                {canClose ? (
                  <>
                    <form action={markOutcome.bind(null, a.id, "rejected")}>
                      <button className="btn btn-sm" type="submit">
                        Rejected
                      </button>
                    </form>
                    <form action={markOutcome.bind(null, a.id, "declined")}>
                      <button className="btn btn-sm" type="submit" title="You turned it down or withdrew">
                        I didn&apos;t take it
                      </button>
                    </form>
                  </>
                ) : null}
              </div>
            ) : null}
            {/* Keyed on the stage so the fields show a move made by the buttons above, not what they held before it. */}
            <form action={saveTracking.bind(null, a.id)} key={`${a.stage}:${a.closedReason ?? ""}`}>
              <div className="field">
                <label htmlFor="stage">Stage</label>
                <select className="input" id="stage" name="stage" defaultValue={a.stage}>
                  {STAGES.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="closed_reason">Closed reason (if closing)</label>
                <select className="input" id="closed_reason" name="closed_reason" defaultValue={reason ?? ""}>
                  <option value="">—</option>
                  {CLOSED_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {CLOSED_REASON_LABEL[r]}
                    </option>
                  ))}
                  {otherReason ? <option value={otherReason}>{closedReasonLabel(otherReason)}</option> : null}
                </select>
              </div>
              <div className="field">
                <label htmlFor="next_action">Next action</label>
                <input className="input" id="next_action" name="next_action" defaultValue={a.nextAction ?? ""} placeholder="Follow up" />
              </div>
              <div className="field">
                <label htmlFor="next_action_due">Follow-up date</label>
                <input className="input" id="next_action_due" name="next_action_due" type="date" defaultValue={a.nextActionDue?.slice(0, 10) ?? ""} />
              </div>
              <label className="check">
                <input type="checkbox" name="needs_signin" defaultChecked={a.needsSignin} /> Portal needs my sign-in
              </label>
              <label className="check">
                <input type="checkbox" name="needs_answers" defaultChecked={a.needsAnswers} /> Form needs my answers
              </label>
              <div className="field">
                <label htmlFor="notes">Notes</label>
                <textarea className="input" id="notes" name="notes" defaultValue={a.notes ?? ""} rows={4} />
              </div>
              <button className="btn btn-primary" type="submit">
                Save
              </button>
            </form>
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>Submitted</dt>
              <dd>{fmtDateTime(a.submittedAt)}</dd>
              <dt>LinkedIn</dt>
              <dd>{a.linkedinStatus ?? "—"}</dd>
              <dt>Confirmation</dt>
              <dd>
                {a.confirmationScreenshot ? (
                  <a href={`/files/${jobId}/${path.basename(a.confirmationScreenshot)}`} target="_blank" rel="noreferrer">
                    Screenshot
                  </a>
                ) : null}
                {a.confirmationText ? <div className="small secondary">{a.confirmationText}</div> : null}
                {a.emailConfirmedAt ? <div className="small status-ok">Email from the employer, {fmtDateTime(a.emailConfirmedAt)}</div> : null}
                {!a.confirmationScreenshot && !a.confirmationText && !a.emailConfirmedAt ? "—" : null}
              </dd>
            </dl>
          </section>

          {mail.length ? (
            <section className="panel">
              <h2>Emails</h2>
              <ul className="feed">
                {mail.map((e) => (
                  <li key={e.id}>
                    <span className="mark email" aria-hidden />
                    <div>
                      <div className="t">
                        <a href={mailLink(e.messageId)}>{e.subject}</a>
                      </div>
                      <div className="d">
                        {e.status === "review" ? "Needs a look" : KIND_LABEL[e.kind]} · {e.fromName ?? e.fromAddress}
                      </div>
                      {e.summary ? <div className="d">{e.summary}</div> : null}
                      <div className="w">{fmtDateTime(e.receivedAt)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel">
            <h2>Status history</h2>
            <ul className="feed">
              {history.map((e) => (
                <li key={e.id}>
                  <span className={`mark ${e.type}`} aria-hidden />
                  <div>
                    <div className="t">{e.title}</div>
                    {e.detail ? <div className="d">{e.detail}</div> : null}
                    <div className="w">
                      {fmtDateTime(e.at)} · {e.source}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <form action={addNote.bind(null, a.id)} style={{ marginTop: 12 }}>
              <div className="field">
                <label htmlFor="note">Add a note</label>
                <textarea className="input" id="note" name="note" rows={2} style={{ minHeight: 70 }} />
              </div>
              <button className="btn btn-sm" type="submit">
                Add note
              </button>
            </form>
          </section>
        </aside>
      </div>
    </>
  );
}
