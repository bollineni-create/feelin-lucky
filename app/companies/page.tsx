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
  const all = db.select().from(schema.companies).orderBy(asc(schema.companies.id)).all();
  const categories = [...new Set([...CATEGORIES, ...all.flatMap((c) => c.categories)])];
  const active = sp.category && categories.includes(sp.category) ? sp.category : null;
  const criteria = getCriteria();

  const href = (p: { category?: string | null; highlighted?: boolean }) => {
    const u = new URLSearchParams();
    const cat = p.category === undefined ? active : p.category;
    const hl = p.highlighted === undefined ? highlightedOnly : p.highlighted;
    if (cat) u.set("category", cat);
    if (hl) u.set("highlighted", "1");
    const s = u.toString();
    return s ? `/companies?${s}` : "/companies";
  };

  const groups = (active ? [active] : categories)
    .map((cat) => ({ cat, items: all.filter((c) => c.categories.includes(cat) && (!highlightedOnly || c.highlight)) }))
    .filter((g) => g.items.length);

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="page-head">
        <div>
          <h1>Company watchlist</h1>
          <p className="sub">
            <span className="num">{all.length}</span> companies in <span className="num">{categories.length}</span> categories · <span className="num">{all.filter((c) => c.highlight).length}</span> highlighted
          </p>
        </div>
        <div className="legend" aria-label="Highlight legend">
          <span>
            <Hl color="red" />
            Red: high priority
          </span>
          <span>
            <Hl color="teal" />
            Teal
          </span>
          <span>
            <Hl color="blue" />
            Blue
          </span>
          <span>
            <Hl color="orange" />
            Orange
          </span>
        </div>
      </div>

      <div className="filters" role="group" aria-label="Filter categories">
        <Link className="fbtn" href={href({ category: null })} aria-pressed={!active}>
          All
        </Link>
        {categories.map((cat) => (
          <Link key={cat} className="fbtn" href={href({ category: cat })} aria-pressed={active === cat}>
            {cat}
          </Link>
        ))}
        <Link className="fbtn" href={href({ highlighted: !highlightedOnly })} aria-pressed={highlightedOnly}>
          Highlighted only
        </Link>
      </div>

      <div className="cats">
        {groups.map(({ cat, items }) => (
          <section className="cat" key={cat} aria-labelledby={`cat-${cat}`}>
            <div className="cat-head">
              <h2 id={`cat-${cat}`}>{cat}</h2>
              <span className="n">{items.length}</span>
            </div>
            <ul className="chips">
              {items.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/companies/${c.id}`}
                    className={`chip ${c.highlight ? "flagged" : ""} ${c.priority === "paused" ? "paused" : ""}`}
                    title={`${c.priority} priority · scanned ${ago(c.lastScannedAt)}`}
                  >
                    <Hl color={c.highlight} />
                    <span>{c.name}</span>
                    {c.atsType ? <span className="ats">{c.atsType}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 ? <p className="muted">No companies match.</p> : null}
      </div>

      <div className="addrow">
        <form action={addCompany} className="panel addform">
          <h2>Add a company</h2>
          <div className="field">
            <label htmlFor="co-name">Company</label>
            <input className="input" id="co-name" name="name" required />
          </div>
          <div className="field" style={{ flexBasis: 180 }}>
            <label htmlFor="co-cat">Category</label>
            <select className="input" id="co-cat" name="category" defaultValue={active ?? "Tech"}>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="submit">
            Add to watchlist
          </button>
        </form>
        <div className="panel-dark">
          <h2>Broad searches</h2>
          <p className="fine" style={{ fontSize: 13, marginBottom: 10 }}>
            Run daily on LinkedIn Jobs beyond the named list.
          </p>
          <ul>
            {criteria.broadSearches.map((b) => (
              <li key={b.label}>{b.label}</li>
            ))}
          </ul>
          <Link href="/settings#criteria" style={{ display: "inline-block", marginTop: 12, fontSize: 14, fontWeight: 500 }}>
            Edit searches
          </Link>
        </div>
      </div>
    </div>
  );
}
