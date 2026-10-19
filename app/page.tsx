import Link from "next/link";
import { count, desc, eq, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { activeRun, getCriteria, latestRuns, listApplications, queueItems, sweepFollowUps, type AppWithJob } from "@/lib/logic";
import { fmtDate, fmtDateTime, modeLabel, shortCity, sourceLabel } from "@/lib/format";
import { RunButton } from "@/components/RunButton";
import { runNow } from "./actions";

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

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  const { source } = await searchParams;
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

  const applied = all.filter((a) => a.stage === "applied");
  const kpis = [
    { label: "Awaiting your approval", value: queue.length, sub: "Found in today’s scan", href: "/queue" },
    { label: "Applied", value: applied.length, sub: applied.some((a) => a.nextAction === "Follow up") ? "Some due a follow-up" : "No response yet" },
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
      <div className="page-head">
        <div>
          <h1>Pipeline</h1>
          <p className="sub">{locationsLine(criteria)}</p>
        </div>
        <div className="btn-row">
          <Link className="btn btn-primary" href="/queue">
            Review {queue.length} new {queue.length === 1 ? "match" : "matches"}
          </Link>
          <RunButton action={runNow} label="Run scan now" pendingLabel="Starting…" disabled={Boolean(running)} />
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
              <li>Checks portals and LinkedIn for status changes on everything in flight</li>
            </ol>
            <p className="fine" style={{ marginTop: 12 }}>
              Nothing is submitted, no account is created and no password is entered without you.
            </p>
          </div>
          <div className="panel">
            <h2>Run log</h2>
            {runs.length === 0 ? (
              <p className="small muted">No runs yet. Use Run scan now, or install the weekday schedule.</p>
            ) : (
              <table className="runs">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{fmtDateTime(r.startedAt)}</td>
                      <td>
                        <span className={`status-${r.status}`}>{r.status}</span> <span className="muted">· {r.phase}</span>
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
          </div>
        </aside>
      </section>
    </div>
  );
}
