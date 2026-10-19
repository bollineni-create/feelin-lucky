import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/db";
import { getCriteria, getProfile } from "@/lib/logic";
import { fmtDateTime } from "@/lib/format";
import { saveCriteria, saveProfile } from "../actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const sp = await searchParams;
  const p = getProfile();
  const c = getCriteria();
  const docDir = path.join(DATA_DIR, "source-docs");
  const has = (f: string | null) => Boolean(f && fs.existsSync(path.join(docDir, f)));
  const placeholders = /\[(CONFIRM|TITLE)[^\]]*\]/i.test(JSON.stringify(p.workHistory));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">The agent reads both of these at the start of every run. Titles and dates on forms come only from your profile.</p>
        </div>
      </div>

      {sp.saved ? <div className="banner ok">Saved {sp.saved === "profile" ? "profile" : "search criteria"}.</div> : null}
      {sp.error === "json" ? <div className="banner">Work history and education must be valid JSON arrays. Nothing was saved.</div> : null}
      {sp.error === "placeholders" ? <div className="banner">Saved, but the profile stays unconfirmed while the work history still has [CONFIRM] or [TITLE] placeholders.</div> : null}

      <div className="grid-main">
        <section className="panel" id="profile">
          <h2>Profile</h2>
          {!p.confirmed ? (
            <div className="banner">
              Not confirmed — the agent will not fill or submit any application until you confirm.
              {placeholders ? " Replace the [CONFIRM] / [TITLE TO USE] placeholders in the work history first." : ""}
            </div>
          ) : (
            <div className="banner ok">Confirmed {fmtDateTime(p.updatedAt)}.</div>
          )}
          <form action={saveProfile}>
            <div className="row2">
              <div className="field">
                <label htmlFor="full_name">Full name</label>
                <input className="input" id="full_name" name="full_name" defaultValue={p.fullName} required />
              </div>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input className="input" id="email" name="email" type="email" defaultValue={p.email ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="phone">Phone</label>
                <input className="input" id="phone" name="phone" defaultValue={p.phone ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="location">Location</label>
                <input className="input" id="location" name="location" defaultValue={p.location ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="linkedin_url">LinkedIn URL</label>
                <input className="input" id="linkedin_url" name="linkedin_url" defaultValue={p.linkedinUrl ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="website_url">Website</label>
                <input className="input" id="website_url" name="website_url" defaultValue={p.websiteUrl ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="work_authorization">Work authorization</label>
                <input className="input" id="work_authorization" name="work_authorization" defaultValue={p.workAuthorization ?? ""} placeholder="e.g. U.S. citizen" />
              </div>
              <div className="field">
                <label htmlFor="needs_sponsorship">Needs sponsorship?</label>
                <select className="input" id="needs_sponsorship" name="needs_sponsorship" defaultValue={p.needsSponsorship == null ? "" : p.needsSponsorship ? "yes" : "no"}>
                  <option value="">Not set — agent leaves it for you</option>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="work_history">Work history (JSON — the only source for titles and dates)</label>
              <textarea className="input code" id="work_history" name="work_history" rows={18} defaultValue={JSON.stringify(p.workHistory, null, 2)} />
              <span className="small muted">Each entry: employer, team, title, start (YYYY-MM), end (YYYY-MM or null for current), location, bullets.</span>
            </div>
            <div className="field">
              <label htmlFor="education">Education (JSON)</label>
              <textarea className="input code" id="education" name="education" rows={6} defaultValue={JSON.stringify(p.education, null, 2)} placeholder='[{"school": "", "degree": "", "field": "", "end": "YYYY-MM"}]' />
            </div>
            <div className="field">
              <label htmlFor="skills">Skills (one per line)</label>
              <textarea className="input" id="skills" name="skills" rows={4} defaultValue={p.skills.join("\n")} />
            </div>
            <div className="row2">
              <div className="field">
                <label htmlFor="resume_file">Resume file in data/source-docs/ {has(p.resumeFile) ? "✓" : "— missing"}</label>
                <input className="input mono" id="resume_file" name="resume_file" defaultValue={p.resumeFile ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="cv_file">CV file in data/source-docs/ {has(p.cvFile) ? "✓" : "— missing"}</label>
                <input className="input mono" id="cv_file" name="cv_file" defaultValue={p.cvFile ?? ""} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="resume_text">Resume text (Markdown — the agent tailors from this)</label>
              <textarea className="input code" id="resume_text" name="resume_text" rows={10} defaultValue={p.resumeText ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="cv_text">CV text (Markdown)</label>
              <textarea className="input code" id="cv_text" name="cv_text" rows={10} defaultValue={p.cvText ?? ""} />
            </div>
            <label className="check">
              <input type="checkbox" name="confirmed" defaultChecked={p.confirmed} /> I&apos;ve checked every title and date above. The agent may use this profile on applications.
            </label>
            <button className="btn btn-primary" type="submit">
              Save profile
            </button>
          </form>
        </section>

        <aside>
          <section className="panel" id="criteria">
            <h2>Search criteria</h2>
            <form action={saveCriteria}>
              <div className="field">
                <label htmlFor="primary_locations">Locations — first (one per line)</label>
                <textarea className="input" id="primary_locations" name="primary_locations" rows={2} style={{ minHeight: 70 }} defaultValue={c.primaryLocations.join("\n")} />
              </div>
              <div className="field">
                <label htmlFor="secondary_locations">Locations — also considered</label>
                <textarea className="input" id="secondary_locations" name="secondary_locations" rows={3} style={{ minHeight: 80 }} defaultValue={c.secondaryLocations.join("\n")} />
              </div>
              <div className="field">
                <label htmlFor="work_modes">Work modes, in priority order</label>
                <textarea className="input" id="work_modes" name="work_modes" rows={3} style={{ minHeight: 80 }} defaultValue={c.workModes.join("\n")} />
              </div>
              <div className="field">
                <label htmlFor="functions">Functions</label>
                <textarea className="input" id="functions" name="functions" rows={7} defaultValue={c.functions.join("\n")} />
              </div>
              <div className="row2">
                <div className="field">
                  <label htmlFor="fit_threshold">Fit threshold</label>
                  <input className="input mono" id="fit_threshold" name="fit_threshold" inputMode="numeric" defaultValue={c.fitThreshold} />
                </div>
                <div className="field">
                  <label htmlFor="high_priority_threshold">High-priority threshold</label>
                  <input className="input mono" id="high_priority_threshold" name="high_priority_threshold" inputMode="numeric" defaultValue={c.highPriorityThreshold} />
                </div>
                <div className="field">
                  <label htmlFor="min_base">Minimum base ($)</label>
                  <input className="input mono" id="min_base" name="min_base" inputMode="numeric" defaultValue={c.minBase ?? ""} placeholder="Not set" />
                </div>
                <div className="field">
                  <label htmlFor="lookback_days">LinkedIn lookback (days)</label>
                  <input className="input mono" id="lookback_days" name="lookback_days" inputMode="numeric" defaultValue={c.lookbackDays} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="broad_searches">Broad searches (label | what to search)</label>
                <textarea className="input" id="broad_searches" name="broad_searches" rows={7} defaultValue={c.broadSearches.map((b) => `${b.label} | ${b.query}`).join("\n")} />
              </div>
              <div className="field">
                <label htmlFor="notes">Notes for scoring</label>
                <textarea className="input" id="notes" name="notes" rows={4} defaultValue={c.notes ?? ""} />
              </div>
              <button className="btn btn-primary" type="submit">
                Save criteria
              </button>
            </form>
          </section>
        </aside>
      </div>
    </>
  );
}
