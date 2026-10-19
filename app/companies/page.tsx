import Link from "next/link";
import { asc } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getCriteria } from "@/lib/logic";
import { CATEGORIES } from "@/db/seed-data";
import { ago } from "@/lib/format";
import { Hl } from "@/components/Hl";
import { addCompany } from "../actions";

export const dynamic = "force-dynamic";

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ category?: string; highlighted?: string }> }) {
  const sp = await searchParams;
  const highlightedOnly = sp.highlighted === "1";
  const all = db.select().from(schema.companies).orderBy(asc(schema.companies.name)).all();
  const categories = [...new Set([...CATEGORIES, ...all.flatMap((c) => c.categories)])];
  const active = sp.category && categories.includes(sp.category) ? sp.category : null;
  const visible = all.filter((c) => (!highlightedOnly || c.highlight) && (!active || c.categories.includes(active)));
  const criteria = getCriteria();

  const qs = (p: { category?: string | null; highlighted?: boolean }) => {
    const u = new URLSearchParams();
    const cat = p.category === undefined ? active : p.category;
    const hl = p.highlighted === undefined ? highlightedOnly : p.highlighted;
    if (cat) u.set("category", cat);
    if (hl) u.set("highlighted", "1");
    const s = u.toString();
    return s ? `/companies?${s}` : "/companies";
  };

  const groups = (active ? [active] : categories).map((cat) => ({ cat, items: visible.filter((c) => c.categories.includes(cat)) })).filter((g) => g.items.length);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{all.length} companies</div>
          <h1>Company watchlist</h1>
          <p className="sub">Red is high priority and scanned daily; everything else every 3 days. Paused companies are skipped.</p>
        </div>
      </div>

      <div className="grid-main">
        <section aria-label="Companies">
          <div className="toolbar">
            <div className="pills" role="group" aria-label="Category">
              <Link className="pill" href={qs({ category: null })} aria-current={!active ? "true" : undefined}>
                All <span className="n">{all.filter((c) => !highlightedOnly || c.highlight).length}</span>
              </Link>
              {categories.map((cat) => {
                const n = all.filter((c) => c.categories.includes(cat) && (!highlightedOnly || c.highlight)).length;
                return (
                  <Link key={cat} className="pill" href={qs({ category: cat })} aria-current={active === cat ? "true" : undefined}>
                    {cat} <span className="n">{n}</span>
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="toolbar">
            <Link className="toggle" href={qs({ highlighted: !highlightedOnly })} aria-pressed={highlightedOnly} role="switch" aria-checked={highlightedOnly}>
              <span className="sw" aria-hidden /> Highlighted only
            </Link>
            <div className="legend" aria-label="Highlight legend">
              <span>
                <Hl color="red" /> High priority
              </span>
              <span>
                <Hl color="teal" /> Teal
              </span>
              <span>
                <Hl color="blue" /> Blue
              </span>
              <span>
                <Hl color="orange" /> Orange
              </span>
            </div>
          </div>

          {groups.map(({ cat, items }) => (
            <div className="cat" key={cat}>
              <h3>
                {cat} <span className="mono small muted">{items.length}</span>
              </h3>
              <div className="chips">
                {items.map((c) => (
                  <Link
                    key={c.id}
                    href={`/companies/${c.id}`}
                    className={`chip ${c.priority === "paused" ? "paused" : ""}`}
                    title={`${c.priority} priority · scanned ${ago(c.lastScannedAt)}${c.careersUrl ? ` · ${c.careersUrl}` : ""}`}
                  >
                    <Hl color={c.highlight} />
                    {c.name}
                    {c.atsType ? <span className="ats">{c.atsType}</span> : null}
                  </Link>
                ))}
              </div>
            </div>
          ))}
          {groups.length === 0 ? <p className="muted">No companies match.</p> : null}
        </section>

        <aside>
          <section className="panel">
            <h2>Add company</h2>
            <form action={addCompany}>
              <div className="field">
                <label htmlFor="name">Name</label>
                <input className="input" id="name" name="name" required />
              </div>
              <div className="row2">
                <div className="field">
                  <label htmlFor="category">Category</label>
                  <select className="input" id="category" name="category" defaultValue={active ?? "Other"}>
                    {categories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="highlight">Highlight</label>
                  <select className="input" id="highlight" name="highlight" defaultValue="">
                    <option value="">None</option>
                    <option value="red">Red (high priority)</option>
                    <option value="teal">Teal</option>
                    <option value="blue">Blue</option>
                    <option value="orange">Orange</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="careers_url">Careers page (optional)</label>
                <input className="input" id="careers_url" name="careers_url" type="url" placeholder="The agent finds it if empty" />
              </div>
              <button className="btn btn-primary" type="submit">
                Add company
              </button>
            </form>
          </section>

          <section className="panel">
            <h2>Broad searches</h2>
            <p className="small secondary" style={{ marginBottom: 10 }}>
              Run on LinkedIn each day for the last {criteria.lookbackDays} days.
            </p>
            <ul className="feed">
              {criteria.broadSearches.map((b) => (
                <li key={b.label}>
                  <span className="mark status_change" aria-hidden />
                  <div>
                    <div className="t">{b.label}</div>
                    {b.query !== b.label ? <div className="d">{b.query}</div> : null}
                  </div>
                </li>
              ))}
            </ul>
            <Link href="/settings#criteria" className="btn btn-sm" style={{ marginTop: 8 }}>
              Edit searches
            </Link>
          </section>
        </aside>
      </div>
    </>
  );
}
