import Link from "next/link";
import { desc, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { STAGE_LABEL, listApplications, type AppWithJob } from "@/lib/logic";
import { KIND_LABEL, getMailSettings, mailCheckGoing, mailLink, summaryText } from "@/lib/mail";
import { LIVE_STAGES } from "@/lib/mail-rules";
import { ago, fmtDateTime } from "@/lib/format";
import { RunButton } from "@/components/RunButton";
import { AutoRefresh } from "@/components/AutoRefresh";
import type { Email, EmailKind } from "@/db/schema";
import { checkMailNow, connectMail, reopenEmailAction, resolveEmailAction, saveMailSettings, turnOffMail } from "../actions";

export const dynamic = "force-dynamic";

const CHOICES: { value: string; label: string }[] = [
  { value: "confirmation", label: "Confirmation: they received my application" },
  { value: "rejection", label: "Rejection (closes the application)" },
  { value: "screening", label: "Recruiter call or phone screen (→ Screening)" },
  { value: "interviewing", label: "Interview (→ Interviewing)" },
  { value: "assessment", label: "Assessment or test to complete" },
  { value: "offer", label: "Offer (→ Offer)" },
  { value: "update", label: "Status update, nothing to do" },
  { value: "other", label: "Something else about this application" },
  { value: "dismiss", label: "Not about any application here" },
];

const guessChoice = (k: EmailKind) => (k === "interview" ? "screening" : k);

const from = (e: Pick<Email, "fromName" | "fromAddress">) => e.fromName ?? e.fromAddress ?? "Unknown sender";
const byWhom = (m: string | null) => (m === "agent" ? "by the agent" : m === "you" ? "by you" : m ? "by Lodestar" : null);
const appLabel = (a: AppWithJob) => `${a.job.companyName} · ${a.job.title} (${STAGE_LABEL[a.stage]})`;

export default async function MailPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const sp = await searchParams;
  const s = getMailSettings();
  const review = db.select().from(schema.emails).where(eq(schema.emails.status, "review")).orderBy(desc(schema.emails.receivedAt)).limit(50).all();
  const recent = db
    .select({ e: schema.emails, jobId: schema.applications.jobId, company: schema.jobs.companyName, title: schema.jobs.title })
    .from(schema.emails)
    .leftJoin(schema.applications, eq(schema.emails.applicationId, schema.applications.id))
    .leftJoin(schema.jobs, eq(schema.applications.jobId, schema.jobs.id))
    .where(ne(schema.emails.status, "review"))
    .orderBy(desc(schema.emails.receivedAt))
    .limit(60)
    .all();
  // Applications an email can be about: the ones in flight first, then found jobs (applied to outside Lodestar).
  const apps = review.length ? listApplications(inArray(schema.applications.stage, ["found", ...LIVE_STAGES])) : [];
  const byName = (x: AppWithJob, y: AppWithJob) => x.job.companyName.localeCompare(y.job.companyName) || x.job.title.localeCompare(y.job.title);
  const inFlight = apps.filter((a) => a.stage !== "found").sort(byName);
  const found = apps.filter((a) => a.stage === "found").sort(byName);
  const byId = new Map(apps.map((a) => [a.id, a]));
  // An email already tied to an application that has since closed still shows it, so you can see what you'd save to.
  const elsewhere = [...new Set(review.flatMap((e) => (e.applicationId ? [e.applicationId] : (e.candidateIds ?? []))))].filter((id) => !byId.has(id));
  if (elsewhere.length) for (const a of listApplications(inArray(schema.applications.id, elsewhere))) byId.set(a.id, a);
  const known = s.knownAccounts ?? [];
  const checking = s.enabled && mailCheckGoing();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mail</h1>
          <p className="sub">
            Lodestar reads Apple Mail for replies about your applications, so you don&apos;t have to sign in to each careers portal: confirmations that an
            application landed, rejections, interview requests. It never sends, replies to or deletes anything.
          </p>
        </div>
        <div className="btn-row">
          {s.enabled ? (
            <RunButton action={checkMailNow} label="Check mail now" pendingLabel="Checking Mail…" primary />
          ) : (
            <RunButton action={connectMail} label="Connect Apple Mail" pendingLabel="Connecting… (say OK if macOS asks)" primary />
          )}
        </div>
      </div>

      {checking ? <AutoRefresh seconds={10} /> : null}
      {checking ? <div className="banner ok">Checking Mail now; this page updates when it&apos;s done.</div> : null}
      {sp.saved ? <div className="banner ok">Saved.</div> : null}
      {sp.error ? <div className="banner">{sp.error}</div> : null}
      {s.enabled && s.lastError ? (
        <div className="banner" role="alert">
          Last check, {ago(s.lastCheckAt)}: {s.lastError}
        </div>
      ) : null}

      <div className="grid-main">
        <div>
          {!s.enabled ? (
            <section className="panel">
              <h2>Track your applications by email</h2>
              <ol className="bullets" style={{ paddingLeft: 18 }}>
                <li>Click <b>Connect Apple Mail</b>. macOS asks whether &ldquo;node&rdquo; (the program Lodestar&apos;s server runs as) may control Mail: choose <b>OK</b>.</li>
                <li>Lodestar reads the last {s.lookbackDays} days of your inbox (and Junk) in every Mail account, and keeps only the emails about your job search.</li>
                <li>Each one goes on its application: a confirmation marks it confirmed (and applied, if you sent it yourself), a rejection closes it, an interview request asks you to reply.</li>
                <li>It files what it has recorded in a <b>{s.mailboxName}</b> mailbox inside the same account (so it shows on your phone too) and flags what needs a reply.</li>
                <li>Then it checks every 15 minutes while Mail is open, and each morning&apos;s run checks too.</li>
              </ol>
            </section>
          ) : null}

          {s.enabled || review.length ? (
            <section className="panel" id="review">
              <h2>Needs a look {review.length ? <span className="muted">({review.length})</span> : null}</h2>
              {review.length === 0 ? (
                <p className="small muted">Nothing waiting. Emails Lodestar can&apos;t tie to one application, or isn&apos;t sure about, show up here; the morning run settles most of them.</p>
              ) : (
                <p className="small muted" style={{ marginBottom: 8 }}>
                  Lodestar couldn&apos;t tell which application these are about, or what they mean. Say so here, or leave them for the next run.
                </p>
              )}
              <ul className="mail-list">
                {review.map((e) => {
                  const suggested = (e.applicationId ? [e.applicationId] : (e.candidateIds ?? [])).map((id) => byId.get(id)).filter((a): a is AppWithJob => Boolean(a));
                  return (
                    <li key={e.id} className="mail-item">
                      <div className="btn-row" style={{ gap: 8 }}>
                        <span className="tag amber">Looks like: {KIND_LABEL[e.kind].toLowerCase()}</span>
                        <span className="small muted mono">{fmtDateTime(e.receivedAt)}</span>
                      </div>
                      <div className="t">{e.subject}</div>
                      <div className="d">
                        {from(e)}
                        {e.fromAddress && e.fromName ? <span className="muted"> &lt;{e.fromAddress}&gt;</span> : null} · <a href={mailLink(e.messageId)}>Open in Mail</a>
                      </div>
                      {e.body ? (
                        <details>
                          <summary className="small">Read it here</summary>
                          <div className="desc mail-body">{e.body}</div>
                        </details>
                      ) : null}
                      <form action={resolveEmailAction.bind(null, e.id)} className="mail-form">
                        <select className="input" name="application_id" defaultValue={suggested[0]?.id ?? ""} aria-label="Which application">
                          <option value="">Which application?</option>
                          {suggested.length ? (
                            <optgroup label="Likely">
                              {suggested.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {appLabel(a)}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                          <optgroup label="In flight">
                            {inFlight.map((a) => (
                              <option key={a.id} value={a.id}>
                                {appLabel(a)}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="Found (not applied through Lodestar)">
                            {found.map((a) => (
                              <option key={a.id} value={a.id}>
                                {appLabel(a)}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                        <select className="input" name="what" defaultValue={guessChoice(e.kind)} aria-label="What it is">
                          {CHOICES.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                        <button className="btn btn-sm btn-primary" type="submit">
                          Save
                        </button>
                      </form>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {recent.length ? (
            <section className="panel">
              <h2>Recent job emails</h2>
              <table className="runs">
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Email</th>
                    <th>Recorded as</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(({ e, jobId, company, title }) => (
                    <tr key={e.id}>
                      <td className="mono">{fmtDateTime(e.receivedAt)}</td>
                      <td>
                        <div style={{ fontWeight: 500 }}>
                          <a href={mailLink(e.messageId)}>{e.subject}</a>
                        </div>
                        <div className="muted">
                          {from(e)}
                          {jobId ? (
                            <>
                              {" → "}
                              <Link href={`/jobs/${jobId}`}>
                                {company} · {title}
                              </Link>
                            </>
                          ) : null}
                        </div>
                        {e.summary ? <div className="muted">{e.summary}</div> : null}
                      </td>
                      <td>
                        <span className={`tag ${e.status === "dismissed" ? "" : "accent"}`}>{e.status === "dismissed" ? "Not an application" : KIND_LABEL[e.kind]}</span>
                        <div className="small muted">
                          {[byWhom(e.matchedBy), e.filedTo ? `in ${e.filedTo}` : null, e.flagged ? "flagged" : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                        {e.fileError && !e.fileError.startsWith("gone:") ? <div className="small status-failed">{e.fileError}</div> : null}
                        <form action={reopenEmailAction.bind(null, e.id)}>
                          <button className="btn btn-sm btn-ghost" type="submit" style={{ padding: "2px 0", minHeight: 0, fontSize: 12, fontWeight: 400 }}>
                            Wrong? Undo and look again
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </div>

        <aside>
          <section className="panel">
            <h2>Status</h2>
            <dl className="kv">
              <dt>Email tracking</dt>
              <dd>{s.enabled ? "On" : "Off"}</dd>
              <dt>Last check</dt>
              <dd>{s.lastCheckAt ? `${ago(s.lastCheckAt)} (${fmtDateTime(s.lastCheckAt)})` : "Never"}</dd>
              {s.lastSummary ? (
                <>
                  <dt>It found</dt>
                  <dd>{summaryText(s.lastSummary)}</dd>
                </>
              ) : null}
              <dt>Accounts</dt>
              <dd>{known.length ? known.join(", ") : "—"}</dd>
              <dt>Mailbox</dt>
              <dd>{s.fileEmails ? s.mailboxName : "Not filing"}</dd>
            </dl>
          </section>

          {s.enabled ? (
            <section className="panel">
              <h2>Settings</h2>
              <form action={saveMailSettings}>
                <div className="field">
                  <label htmlFor="mailbox_name">Mailbox for job emails</label>
                  <input className="input" id="mailbox_name" name="mailbox_name" defaultValue={s.mailboxName} />
                </div>
                <label className="check">
                  <input type="checkbox" name="file_emails" defaultChecked={s.fileEmails} /> Move confirmations, rejections and status updates there once they&apos;re
                  recorded (inside the same Mail account)
                </label>
                <label className="check">
                  <input type="checkbox" name="flag_needs_reply" defaultChecked={s.flagNeedsReply} /> Flag interview requests, assessments and offers, and leave them in
                  the inbox
                </label>
                <label className="check">
                  <input type="checkbox" name="include_junk" defaultChecked={s.includeJunk} /> Also look in Junk (applicant systems&apos; mail often lands there)
                </label>
                <label className="check">
                  <input type="checkbox" name="notify" defaultChecked={s.notify} /> Notify me on this Mac about rejections and emails that need me
                </label>
                {known.length ? (
                  <div className="field">
                    <span className="small">Read these accounts</span>
                    {known.map((a) => (
                      <label className="check" key={a}>
                        <input type="checkbox" name="accounts" value={a} defaultChecked={s.accounts.length === 0 || s.accounts.includes(a)} /> {a}
                      </label>
                    ))}
                  </div>
                ) : null}
                <div className="field" style={{ maxWidth: 200 }}>
                  <label htmlFor="lookback_days">Look back (days, first check)</label>
                  <input className="input mono" id="lookback_days" name="lookback_days" inputMode="numeric" defaultValue={s.lookbackDays} />
                </div>
                <button className="btn btn-primary" type="submit">
                  Save
                </button>
              </form>
              <form action={turnOffMail} style={{ marginTop: 12 }}>
                <button className="btn btn-sm" type="submit">
                  Turn email tracking off
                </button>
              </form>
            </section>
          ) : null}

          <div className="panel-dark" style={{ fontSize: 13 }}>
            <h2>What Lodestar keeps</h2>
            Only emails about your job search: from applicant tracking systems (Greenhouse, Workday, Lever and the like), LinkedIn&apos;s &ldquo;application sent&rdquo;
            notices, and recruiters or companies you&apos;ve applied to writing about an application. Other mail is looked at only long enough to tell, and isn&apos;t
            stored. The emails it keeps stay in this Mac&apos;s database; the ones under Needs a look are also read by the agent (Claude) on its next run.
          </div>
        </aside>
      </div>
    </>
  );
}
