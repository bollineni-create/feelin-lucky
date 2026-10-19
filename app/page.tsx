import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { STAGES, type Stage } from "@/db/schema";
import { OPEN_STAGES, STAGE_LABEL, activeRun, daysAgo, iso, latestRuns, listApplications, queueItems, sweepFollowUps } from "@/lib/logic";
import { ago, fmtDate, fmtDateTime, modeLabel, sourceLabel } from "@/lib/format";
import { Hl } from "@/components/Hl";
import { RunButton } from "@/components/RunButton";
import { runNow } from "./actions";

export const dynamic = "force-dynamic";

const COLUMN_CAP = 12;

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  const { source } = await searchParams;
  const filter = source === "careers" || source === "linkedin" ? source : null;

  sweepFollowUps();
  const all = listApplications();
  const apps = filter ? all.filter((a) => a.job.source === filter) : all;
  const queue = queueItems().filter((a) => a.stage === "found");
  const now = iso();

  const applied30 = all.filter((a) => a.submittedAt && a.submittedAt >= iso(daysAgo(30)));
  const applied7 = applied30.filter((a) => a.submittedAt! >= iso(daysAgo(7)));
  const inProcess = all.filter((a) => ["screening", "interviewing", "offer"].includes(a.stage));
  const needsSignin = all.filter((a) => a.needsSignin && a.stage !== "closed");
  const followUps = all.filter((a) => OPEN_STAGES.includes(a.stage) && a.nextAction && a.nextActionDue && a.nextActionDue <= now);
  const runs = latestRuns(8);
  const lastRun = runs[0];
  const running = activeRun();

  const feed = db
    .select({ e: schema.events, jobId: schema.applications.jobId, company: schema.jobs.companyName, title: schema.jobs.title })
    .from(schema.events)
    .leftJoin(schema.applications, eq(schema.events.applicationId, schema.applications.id))
    .leftJoin(schema.jobs, eq(schema.applications.jobId, schema.jobs.id))
    .orderBy(desc(schema.events.at), desc(schema.events.id))
    .limit(14)
    .all();

  const byStage = (s: Stage) => apps.filter((a) => a.stage === s);
  const counts = { all: all.length, careers: all.filter((a) => a.job.source === "careers").length, linkedin: all.filter((a) => a.job.source === "linkedin").length };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{fmtDate(now, { weekday: "long", month: "long", day: "numeric" })}</div>
          <h1>Pipeline</h1>
        </div>
        <RunButton action={runNow} label="Run now" pendingLabel="Starting…" disabled={Boolean(running)} />
      </div>

      <section className="kpis" aria-label="Summary">
        <Link href="/queue" className="kpi">
          <div className="eyebrow">In today&apos;s queue</div>
          <div className="value">{queue.length}</div>
          <div className="note">New matches ready to review</div>
        </Link>
        <div className="kpi">
          <div className="eyebrow">Applied · 30 days</div>
          <div className="value">{applied30.length}</div>
          <div className="note">{applied7.length} this week</div>
        </div>
        <div className="kpi">
          <div className="eyebrow">In process</div>
          <div className="value">{inProcess.length}</div>
          <div className="note">Screening, interviews, offers</div>
        </div>
        <div className={`kpi ${needsSignin.length + followUps.length ? "needs" : ""}`}>
          <div className="eyebrow">Needs you</div>
          <div className="value">{needsSignin.length + followUps.length}</div>
          <div className="note">
            {needsSignin.length} sign-in · {followUps.length} follow-up
          </div>
        </div>
        <div className="kpi">
          <div className="eyebrow">Last run</div>
          <div className={`value status-${running ? "running" : (lastRun?.status ?? "")}`} style={{ fontSize: 20, marginTop: 10 }}>
            {running ? "Running" : lastRun ? (lastRun.status === "ok" ? "OK" : "Failed") : "—"}
          </div>
          <div className="note">{lastRun ? `${ago(lastRun.startedAt)} · ${lastRun.counts?.new ?? 0} new` : "No runs yet"}</div>
        </div>
      </section>

      <div>
        <section aria-label="Pipeline by stage">
          <div className="toolbar">
            <div className="pills" role="group" aria-label="Filter by source">
              <Link className="pill" href="/" aria-current={!filter ? "true" : undefined}>
                All <span className="n">{counts.all}</span>
              </Link>
              <Link className="pill" href="/?source=careers" aria-current={filter === "careers" ? "true" : undefined}>
                Careers site <span className="n">{counts.careers}</span>
              </Link>
              <Link className="pill" href="/?source=linkedin" aria-current={filter === "linkedin" ? "true" : undefined}>
                LinkedIn <span className="n">{counts.linkedin}</span>
              </Link>
            </div>
          </div>
          <div className="board-wrap">
            <div className="board">
              {STAGES.map((stage) => {
                const items = byStage(stage);
                return (
                  <div className="column" key={stage}>
                    <div className="column-head">
                      <span className="eyebrow">{STAGE_LABEL[stage]}</span>
                      <span className="n">{items.length}</span>
                    </div>
                    {items.length === 0 ? <div className="empty-col">Nothing here</div> : null}
                    {items.slice(0, COLUMN_CAP).map((a) => (
                      <Link className="card" href={`/jobs/${a.jobId}`} key={a.id}>
                        <div className="co">
                          <Hl color={a.companyHighlight} />
                          {a.job.companyName}
                        </div>
                        <div className="role">{a.job.title}</div>
                        <div className="meta">
                          <span className="tag">{sourceLabel(a.job.source)}</span>
                          {a.job.fitScore != null ? <span className="tag accent">Fit {a.job.fitScore}</span> : null}
                          {a.needsSignin ? <span className="tag amber">Sign-in</span> : null}
                          {a.nextAction && a.stage !== "closed" ? <span className="tag amber">{a.nextAction}</span> : null}
                          {stage === "closed" && a.closedReason ? <span className="tag">{a.closedReason.replace(/_/g, " ")}</span> : null}
                          {stage !== "closed" && a.job.workMode ? <span className="small muted">{modeLabel(a.job.workMode)}</span> : null}
                        </div>
                      </Link>
                    ))}
                    {items.length > COLUMN_CAP ? <div className="empty-col">+{items.length - COLUMN_CAP} more</div> : null}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <aside className="pipeline-side">
          <section className="panel">
            <h2>Updates the agent picked up</h2>
            {feed.length === 0 ? <p className="small muted">Nothing yet. Updates appear here after a run.</p> : null}
            <ul className="feed">
              {feed.map(({ e, jobId, company, title }) => (
                <li key={e.id}>
                  <span className={`mark ${e.type}`} aria-hidden />
                  <div>
                    <div className="t">
                      {jobId ? (
                        <Link href={`/jobs/${jobId}`} style={{ textDecoration: "none" }}>
                          {company}
                        </Link>
                      ) : null}
                      {jobId ? " · " : null}
                      {e.title}
                    </div>
                    {title || e.detail ? <div className="d">{[title, e.detail].filter(Boolean).join(" — ")}</div> : null}
                    <div className="w">
                      {fmtDateTime(e.at)} · {e.source}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <h2>How a daily run works</h2>
            <ol className="steps">
              <li>
                <b>7:00 AM PT, weekdays.</b> Claude Code opens a new tab group in your Chrome, signed in as you.
              </li>
              <li>
                <b>Submit what you approved.</b> Only applications you clicked Approve on. Anything that wants a new account, password or CAPTCHA is flagged for you instead.
              </li>
              <li>
                <b>Find.</b> Careers sites for companies due a scan (red daily, others every 3 days), then your LinkedIn tracker and broad searches.
              </li>
              <li>
                <b>Score and prepare.</b> Each match gets a fit score and three reasons; good fits get a tailored resume or CV, cover letter and answers.
              </li>
              <li>
                <b>Track.</b> Open applications are re-checked; changes land in this feed. Then the tabs close.
              </li>
            </ol>
          </section>

          <section className="panel">
            <h2>Run log</h2>
            {runs.length === 0 ? (
              <p className="small muted">No runs yet. Use Run now, or install the launchd schedule.</p>
            ) : (
              <table className="runs">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Phase</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{fmtDateTime(r.startedAt)}</td>
                      <td>{r.phase}</td>
                      <td>
                        <span className={`status-${r.status}`}>{r.status}</span>
                        {r.counts ? (
                          <div className="muted">
                            {Object.entries(r.counts)
                              .map(([k, v]) => `${v} ${k}`)
                              .join(" · ")}
                          </div>
                        ) : null}
                        {r.errors?.length ? <div className="status-failed">{r.errors.slice(0, 2).join("; ")}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
