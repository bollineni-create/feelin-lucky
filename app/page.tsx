import Link from "next/link";
import { count, desc, eq, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { activeRun, doneLookups, getCriteria, latestRuns, lookupLabel, pendingLookups, resumePhases, runActivity, runUnfinished, listApplications, queueItems, sweepFollowUps, type AppWithJob } from "@/lib/logic";
import { ago, fmtDate, fmtDateTime, modeLabel, shortCity, sourceLabel } from "@/lib/format";
import { LOG_TAIL_LINES, progressLine, runProgress } from "@/lib/run-progress";
import { RunButton } from "@/components/RunButton";
import { getMailSettings } from "@/lib/mail";
import { AutoRefresh } from "@/components/AutoRefresh";
import { addLookup, redoLookup, removeLookup, resumeRun, runNow, stopRun, submitApprovedNow } from "./actions";

export const dynamic = "force-dynamic";

const COLUMN_CAP = 12;

// Closed reasons that mean the job was never pursued; those stay off the board.
const NOT_PURSUED = new Set(["low_fit", "skipped"]);

const COLUMNS: { name: string; match: (a: AppWithJob) => boolean }[] = [
  { name: "Approved", match: (a) => a.stage === "approved" },
  { name: "Applied", match: (a) => a.stage === "applied" },
  { name: "Screening", match: (a) => a.stage === "screening" },
  { name: "Interviewing", match: (a) => a.stage === "interviewing" },
  { name: "Offer / closed", match: (a) => a.stage === "offer" || (a.stage === "closed" && !NOT_PURSUED.has(a.closedReason ?? "")) },
];

function whereText(a: AppWithJob) {
  const loc = a.job.location ?? "";
  const mode = modeLabel(a.job.workMode);
  if (!mode || loc.toLowerCase().includes(mode.toLowerCase())) return loc || mode || "—";
  return loc ? `${loc} · ${mode}` : mode;
}

function nextText(a: AppWithJob) {
  if (a.needsSignin) return "Sign in to the portal";
  if (a.nextAction) return a.nextActionDue ? `${a.nextAction} ${fmtDate(a.nextActionDue)}` : a.nextAction;
  if (a.stage === "approved") return "Submitting on next run";
  if (a.stage === "applied") return "Watch portal for a response";
  if (a.stage === "closed") return `Archived: ${(a.closedReason ?? "closed").replace(/_/g, " ")}`;
  return null;
}

/** The find phase hasn't run yet: the run is still in a phase that comes before it (e.g. submit). */
function scanNotStarted(r: { status: string; phase: string; currentPhase: string | null }) {
  if (r.status !== "running" || !r.currentPhase) return false;
  const phases = r.phase.split(",").map((p) => p.trim());
  const find = phases.indexOf("find");
  const now = phases.indexOf(r.currentPhase);
  return find >= 0 && now >= 0 && now < find;
}

function activityText(a: ReturnType<typeof runActivity>, r: { status: string; phase: string; currentPhase: string | null }) {
  if (!a.companies_scanned && !a.jobs_found && scanNotStarted(r)) {
    return `Scanning starts after ${r.currentPhase}; nothing to count yet`;
  }
  const jobs = a.jobs_found ? `${a.jobs_found} new jobs (${a.jobs_found_careers} careers, ${a.jobs_found_linkedin} LinkedIn)` : "no new jobs";
  const lowFit = a.jobs_closed_low_fit ? ` · ${a.jobs_closed_low_fit} closed as low fit` : "";
  const lookups = a.lookups_done ? ` · ${a.lookups_done} ${a.lookups_done === 1 ? "lookup" : "lookups"} done` : "";
  return `Recorded: ${a.companies_scanned} companies scanned${lookups} · ${jobs}${lowFit}`;
}

function whenLabel(iso: string) {
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (day(new Date(iso)) === day(today)) return "Today";
  if (day(new Date(iso)) === day(yesterday)) return "Yesterday";
  return fmtDate(iso);
}

function locationsLine(c: ReturnType<typeof getCriteria>) {
  const first = c.primaryLocations.map(shortCity).join(" and ");
  const also = c.secondaryLocations.map(shortCity).join(", ");
  const remote = c.workModes[0] === "remote" ? "Remote preferred" : null;
  return [first && `${first} first`, also && `${also} open`, remote].filter(Boolean).join(" · ");
}

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ source?: string; lookup?: string }> }) {
  const { source, lookup: lookupError } = await searchParams;
  const filter = source === "careers" || source === "linkedin" ? source : null;

  sweepFollowUps();
  const all = listApplications();
  const apps = filter ? all.filter((a) => a.job.source === filter) : all;
  const queue = queueItems().filter((a) => a.stage === "found");
  const inPrep = all.filter((a) => a.stage === "found").length - queue.length;
  const criteria = getCriteria();
  const companiesWatched = db.select({ n: count() }).from(schema.companies).where(ne(schema.companies.priority, "paused")).get()!.n;
  const running = activeRun();
  const runs = latestRuns(6);
  // The last run stopped before the agent finished (from the app, at the time limit, or a crash): it can be
  // picked up from the phase it was in, and the agent takes the item it was on first.
  const unfinished = !running && runs[0] && runUnfinished(runs[0]) ? runs[0] : null;
  const countsText = (c: Record<string, number> | null) =>
    c
      ? Object.entries(c)
          .map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`)
          .join(" · ")
      : "";

  const mail = getMailSettings();
  const lookupsPending = pendingLookups();
  const lookupsDone = doneLookups(6);
  const applied = all.filter((a) => a.stage === "applied");
  const confirmed = applied.filter((a) => a.emailConfirmedAt).length;
  const followUp = applied.some((a) => a.nextAction === "Follow up");
  const approved = all.filter((a) => a.stage === "approved");
  const kpis = [
    { label: "Awaiting your approval", value: queue.length, sub: "Found in today’s scan", href: "/queue" },
    {
      label: "Applied",
      value: applied.length,
      sub: confirmed ? `${confirmed} confirmed by email${followUp ? " · some due a follow-up" : ""}` : followUp ? "Some due a follow-up" : "No response yet",
    },
    { label: "In conversation", value: all.filter((a) => a.stage === "screening" || a.stage === "interviewing" || a.stage === "offer").length, sub: "Screens and interviews" },
    { label: "Companies watched", value: companiesWatched, sub: "Plus LinkedIn Jobs and broad searches", href: "/companies" },
  ];

  const feed = db
    .select({ e: schema.events, jobId: schema.applications.jobId, company: schema.jobs.companyName, title: schema.jobs.title })
    .from(schema.events)
    .leftJoin(schema.applications, eq(schema.events.applicationId, schema.applications.id))
    .leftJoin(schema.jobs, eq(schema.applications.jobId, schema.jobs.id))
    .orderBy(desc(schema.events.at), desc(schema.events.id))
    .limit(10)
    .all();

  const filters = [
    { label: "All", href: "/", on: !filter },
    { label: "Careers site", href: "/?source=careers", on: filter === "careers" },
    { label: "LinkedIn", href: "/?source=linkedin", on: filter === "linkedin" },
  ];

  return (
    <div className="stack">
      {running ? <AutoRefresh seconds={15} /> : null}
      <div className="page-head">
        <div>
          <h1>Pipeline</h1>
          <p className="sub">{locationsLine(criteria)}</p>
        </div>
        <div className="btn-row">
          <Link className="btn btn-primary" href="/queue">
            Review {queue.length} new {queue.length === 1 ? "match" : "matches"}
          </Link>
          {running ? (
            <RunButton action={stopRun} label={`Stop run #${running.id}`} pendingLabel="Stopping…" doneMessage="Stopped." />
          ) : (
            <>
              {unfinished ? (
                <RunButton
                  action={resumeRun}
                  label={`Finish run #${unfinished.id} (${resumePhases(unfinished).join(", ")})`}
                  pendingLabel="Starting…"
                  doneMessage="Resuming. Watch Chrome; the run log below updates as it goes."
                />
              ) : null}
              {approved.length ? (
                <RunButton action={submitApprovedNow} label={`Apply to ${approved.length} approved now`} pendingLabel="Starting…" doneMessage="Applying. Watch Chrome; the run log below updates as it goes." />
              ) : null}
              <RunButton action={runNow} label="Run scan now" pendingLabel="Starting…" doneMessage="Started. Watch Chrome; the run log below updates as it goes." />
            </>
          )}
        </div>
      </div>

      <section className="kpis" aria-label="Summary">
        {kpis.map((k) => {
          const body = (
            <>
              <div className="label">{k.label}</div>
              <div className="value">{k.value}</div>
              <div className="note">{k.sub}</div>
            </>
          );
          return k.href ? (
            <Link key={k.label} className="kpi" href={k.href}>
              {body}
            </Link>
          ) : (
            <div key={k.label} className="kpi">
              {body}
            </div>
          );
        })}
      </section>

      <section aria-labelledby="lookups-h" className="panel" id="lookups">
        <div className="page-head" style={{ alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h2 id="lookups-h" className="section">
            Look for something on the next scan
          </h2>
          <span className="small muted">
            {lookupsPending.length
              ? `${lookupsPending.length} waiting · the agent takes ${lookupsPending.length === 1 ? "it" : "them"} before the watchlist`
              : "A job title, a company, or both. The agent searches for it first, before the watchlist."}
          </span>
        </div>
        <form action={addLookup} className="addform lookup-form">
          <div className="field">
            <label htmlFor="lk-title">Job title</label>
            <input className="input" id="lk-title" name="title" placeholder="Head of Treasury" maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="lk-company">Company</label>
            <input className="input" id="lk-company" name="company" placeholder="Brex (optional if a title is given)" maxLength={120} />
          </div>
          <div className="field" style={{ flexBasis: 320, flexGrow: 2 }}>
            <label htmlFor="lk-note">Anything else (optional)</label>
            <input className="input" id="lk-note" name="note" placeholder="A link to the posting, a team, who mentioned it…" maxLength={500} />
          </div>
          <button className="btn btn-primary" type="submit">
            Add to next scan
          </button>
          {lookupError === "empty" ? (
            <p className="small status-failed" role="alert" style={{ flexBasis: "100%", margin: 0 }}>
              Give a job title or a company, or both.
            </p>
          ) : null}
        </form>
        {lookupsPending.length || lookupsDone.length ? (
          <div className="lookups">
            {lookupsPending.length ? (
              <div>
                <div className="label-caps">Waiting for the next scan</div>
                <ul className="feed">
                  {lookupsPending.map((l) => (
                    <li key={l.id}>
                      <span className="mark" aria-hidden />
                      <div className="lookup-row">
                        <div>
                          <div className="t">{lookupLabel(l)}</div>
                          <div className="d">
                            {l.note ? `${l.note} · ` : ""}added {ago(l.createdAt)}
                            {l.company && !l.companyId ? " · not on the watchlist; the agent finds its careers page" : ""}
                          </div>
                        </div>
                        <form action={removeLookup.bind(null, l.id)}>
                          <button className="btn btn-ghost btn-sm" type="submit">
                            Remove
                          </button>
                        </form>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {lookupsDone.length ? (
              <div>
                <div className="label-caps">Looked for</div>
                <ul className="feed">
                  {lookupsDone.map((l) => (
                    <li key={l.id}>
                      <span className={`mark ${l.jobs.length ? "status_change" : ""}`} aria-hidden />
                      <div className="lookup-row">
                        <div>
                          <div className="t">{lookupLabel(l)}</div>
                          <div className="d">
                            {l.result} · {ago(l.doneAt)}
                            {l.runId ? ` · run #${l.runId}` : ""}
                          </div>
                          {l.jobs.length ? (
                            <div className="d lookup-jobs">
                              {l.jobs.map((a) => (
                                <Link key={a.id} href={`/jobs/${a.jobId}`}>
                                  {a.job.title} · {a.job.companyName}
                                  {a.job.fitScore != null ? ` · fit ${a.job.fitScore}` : ""}
                                </Link>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        <form action={redoLookup.bind(null, l.id)}>
                          <button className="btn btn-ghost btn-sm" type="submit">
                            Look again
                          </button>
                        </form>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="board-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="page-head" style={{ alignItems: "center", gap: 12, marginBottom: 0 }}>
          <div className="btn-row" style={{ gap: "4px 12px" }}>
            <h2 id="board-h" className="section">
              Applications by stage
            </h2>
            {inPrep > 0 ? <span className="small muted">{inPrep} found jobs are still being scored or prepared</span> : null}
          </div>
          <div className="filters" role="group" aria-label="Filter by source">
            {filters.map((f) => (
              <Link key={f.label} className="fbtn" href={f.href} aria-pressed={f.on}>
                {f.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="board-wrap">
          <div className="board">
            {COLUMNS.map((col) => {
              const cards = apps.filter(col.match);
              return (
                <div className="column" key={col.name}>
                  <div className="column-head">
                    <span className="name">{col.name}</span>
                    <span className="n">{cards.length}</span>
                  </div>
                  {cards.length === 0 ? <div className="empty-col">Nothing here yet</div> : null}
                  {cards.slice(0, COLUMN_CAP).map((a) => {
                    const next = nextText(a);
                    return (
                      <Link className="card" href={`/jobs/${a.jobId}`} key={a.id}>
                        <div className="role">{a.job.title}</div>
                        <div className="co">
                          {a.job.companyName} · {whereText(a)}
                        </div>
                        <div className="meta">
                          <span className="tag accent">{sourceLabel(a.job.source)}</span>
                          {a.emailConfirmedAt && a.stage !== "closed" ? <span className="tag">Email ✓</span> : null}
                          <span className="date">{fmtDate(a.submittedAt ?? a.stageChangedAt)}</span>
                        </div>
                        {next ? <div className="next">Next: {next}</div> : null}
                      </Link>
                    );
                  })}
                  {cards.length > COLUMN_CAP ? <div className="empty-col">+{cards.length - COLUMN_CAP} more</div> : null}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section aria-labelledby="upd-h" className="split">
        <div className="grow panel">
          <h2 id="upd-h" className="section" style={{ marginBottom: 12 }}>
            Updates the agent picked up
          </h2>
          {feed.length === 0 ? <p className="small muted">Nothing yet. Updates appear here after a run.</p> : null}
          <ul className="updates">
            {feed.map(({ e, jobId, company, title }) => (
              <li key={e.id}>
                <span className="when">{whenLabel(e.at)}</span>
                <div className="body">
                  <div className="t">
                    {jobId ? <Link href={`/jobs/${jobId}`}>{company}</Link> : null}
                    {jobId ? ": " : null}
                    {e.title}
                  </div>
                  {title || e.detail ? <div className="d">{[title, e.detail].filter(Boolean).join(" · ")}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <aside className="side">
          <div className="panel-dark">
            <h2>How a daily run works</h2>
            <ol>
              <li>Submits the applications you approved, and nothing else</li>
              <li>Scans each watchlist company&apos;s careers page and your LinkedIn Jobs list</li>
              <li>Scores every new posting against your criteria and drops weak fits</li>
              <li>Drafts a tailored resume and cover letter for each strong match, then waits for your approval</li>
              <li>Reads Apple Mail for confirmations, rejections and interview requests on everything in flight, and checks portals and LinkedIn where email is silent</li>
            </ol>
            <p className="fine" style={{ marginTop: 12 }}>
              Nothing is submitted, no account is created and no password is entered without you.
            </p>
            {mail.enabled ? null : (
              <p className="fine" style={{ marginTop: 8 }}>
                Email tracking is off: <Link href="/mail">connect Apple Mail</Link> so replies from employers update your applications.
              </p>
            )}
          </div>
        </aside>
      </section>

      <section aria-labelledby="runs-h" className="panel">
        <div className="page-head" style={{ alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h2 id="runs-h" className="section">
            Run log
          </h2>
          {running ? (
            <span className="small status-running">Run #{running.id} in progress · refreshes every 15s</span>
          ) : unfinished ? (
            <span className="small muted">
              Run #{unfinished.id} stopped in {unfinished.currentPhase}
              {unfinished.note ? ` while ${unfinished.note}` : ""}. Finish run picks up {resumePhases(unfinished).join(", ")} from there.
            </span>
          ) : null}
        </div>
        {runs.length === 0 ? (
          <p className="small muted">No runs yet. Use Run scan now, or install the weekday schedule.</p>
        ) : (
          <div className="runs-wrap">
            <table className="runs">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Result</th>
                  <th>Phases</th>
                  <th>Reported by the agent</th>
                  <th>Recorded by the app</th>
                  <th>Agent</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => {
                  const isRunning = r.status === "running";
                  // The live run, and the most recent finished one, show what their log and transcript say.
                  const progress = isRunning || i === 0 ? runProgress(r) : null;
                  const line = progress ? progressLine(progress, isRunning) : "";
                  const activity = runActivity(r);
                  // A site the agent couldn't scan is recorded on the company. If the agent also put it in
                  // the run's errors, the company line below already says it, so that error isn't repeated.
                  const unscanned = activity.companies_unscanned;
                  const names = unscanned.map((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
                  const errors = (r.errors ?? []).filter((e) => !names.some((re) => re.test(e)));
                  // What the agent says it's on beats what the transcript suggests; the latter is the fallback.
                  const showNote = r.note && (isRunning || runUnfinished(r));
                  return [
                    <tr key={r.id}>
                      <td className="mono nowrap">
                        {fmtDateTime(r.startedAt)}
                        <div className="muted">{r.trigger.replace(/-/g, " ")}</div>
                      </td>
                      <td className="nowrap">
                        <span className={`status-${r.status}`}>{r.status}</span>
                      </td>
                      <td>
                        {r.phase.split(",").join(", ")}
                        {isRunning && r.currentPhase ? <div className="status-running">in {r.currentPhase}</div> : null}
                        {!isRunning && runUnfinished(r) ? <div className="muted">stopped in {r.currentPhase}</div> : null}
                      </td>
                      <td className="muted">{countsText(r.counts) || "—"}</td>
                      <td className="muted">
                        {activityText(activity, r)}
                        {unscanned.length ? (
                          <div>
                            Couldn&apos;t scan {unscanned.join(", ")} · <Link href="/companies">see the watchlist</Link>
                          </div>
                        ) : null}
                      </td>
                      <td className="agent">
                        {showNote ? (
                          <div className={isRunning ? "status-running" : ""}>
                            {isRunning ? "Now: " : "Was on: "}
                            {r.note}
                            {r.noteAt ? <span className="muted"> ({ago(r.noteAt)})</span> : null}
                          </div>
                        ) : null}
                        {line ? (
                          <div className={isRunning && !showNote ? "status-running" : "muted"}>
                            {isRunning && !showNote ? "Now: " : ""}
                            {line}
                            {progress?.lastEventAt && isRunning ? ` (${ago(progress.lastEventAt)})` : ""}
                          </div>
                        ) : null}
                        {errors.length ? (
                          <ul className="run-errors">
                            {errors.map((e, j) => (
                              <li key={j} className="status-failed">
                                {e}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {!showNote && !line && !errors.length ? <span className="muted">—</span> : null}
                      </td>
                    </tr>,
                    progress?.logLines.length ? (
                      <tr key={`${r.id}-log`} className="runs-detail">
                        <td colSpan={6}>
                          <details className="run-log">
                            <summary className="small muted">Last {Math.min(progress.logLines.length, LOG_TAIL_LINES)} lines of the log</summary>
                            <pre className="run-log-text">{progress.logLines.join("\n")}</pre>
                          </details>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
