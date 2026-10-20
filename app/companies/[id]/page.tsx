import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { STAGE_LABEL, listApplications } from "@/lib/logic";
import { CATEGORIES } from "@/db/seed-data";
import { ago } from "@/lib/format";
import { Hl } from "@/components/Hl";
import { clearScanNote, deleteCompany, updateCompany } from "../../actions";

export const dynamic = "force-dynamic";

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const c = db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
  if (!c) notFound();
  const apps = listApplications(eq(schema.jobs.companyId, id));
  const categories = [...new Set([...CATEGORIES, ...c.categories])];

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/companies" className="eyebrow">
            ← Company watchlist
          </Link>
          <h1 className="btn-row" style={{ gap: 10, marginTop: 6 }}>
            <Hl color={c.highlight} />
            {c.name}
          </h1>
          <p className="sub">
            {c.priority} priority · last scanned {ago(c.lastScannedAt)}
          </p>
        </div>
      </div>
      {c.scanNote ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2>The agent couldn&apos;t scan this careers site</h2>
          <p className="small status-failed" style={{ margin: "6px 0 10px" }}>
            {c.scanNote} <span className="muted">({ago(c.scanNoteAt)})</span>
          </p>
          <p className="small muted" style={{ marginBottom: 10 }}>
            If the note says Claude in Chrome won&apos;t open the site, allow it in the extension (Claude in Chrome → settings → site permissions). If it still won&apos;t open, set a
            careers page on a job board the extension can reach, or pause the company and check the site yourself. The note clears itself after the next successful scan.
          </p>
          <form action={clearScanNote.bind(null, id)}>
            <button className="btn btn-ghost btn-sm" type="submit">
              Clear the note
            </button>
          </form>
        </div>
      ) : null}
      <div className="grid-main">
        <section className="panel">
          <h2>Settings</h2>
          <form action={updateCompany.bind(null, id)}>
            <div className="row2">
              <div className="field">
                <label htmlFor="priority">Priority</label>
                <select className="input" id="priority" name="priority" defaultValue={c.priority}>
                  <option value="high">High — scan daily</option>
                  <option value="normal">Normal — every 3 days</option>
                  <option value="paused">Paused — never</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="highlight">Highlight</label>
                <select className="input" id="highlight" name="highlight" defaultValue={c.highlight ?? ""}>
                  <option value="">None</option>
                  <option value="red">Red</option>
                  <option value="teal">Teal</option>
                  <option value="blue">Blue</option>
                  <option value="orange">Orange</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="careers_url">Careers page</label>
              <input className="input" id="careers_url" name="careers_url" defaultValue={c.careersUrl ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="ats_type">ATS</label>
              <input className="input" id="ats_type" name="ats_type" defaultValue={c.atsType ?? ""} placeholder="workday, greenhouse, lever, ashby…" />
            </div>
            <fieldset className="field" style={{ border: 0, padding: 0 }}>
              <legend className="label" style={{ marginBottom: 6 }}>
                Categories
              </legend>
              <div className="pills">
                {categories.map((cat) => (
                  <label key={cat} className="check" style={{ minHeight: 36, marginRight: 10 }}>
                    <input type="checkbox" name="categories" value={cat} defaultChecked={c.categories.includes(cat)} /> {cat}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Save
              </button>
            </div>
          </form>
          <form action={deleteCompany.bind(null, id)} style={{ marginTop: 12 }}>
            <button className="btn btn-ghost btn-sm" type="submit">
              {apps.length ? "Pause (has jobs)" : "Remove from watchlist"}
            </button>
          </form>
        </section>
        <aside className="panel">
          <h2>Jobs found here</h2>
          {apps.length === 0 ? <p className="small muted">None yet.</p> : null}
          <ul className="feed">
            {apps.map((a) => (
              <li key={a.id}>
                <span className="mark status_change" aria-hidden />
                <div>
                  <Link className="t" href={`/jobs/${a.jobId}`} style={{ textDecoration: "none" }}>
                    {a.job.title}
                  </Link>
                  <div className="d">
                    {STAGE_LABEL[a.stage]}
                    {a.job.fitScore != null ? ` · Fit ${a.job.fitScore}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </>
  );
}
