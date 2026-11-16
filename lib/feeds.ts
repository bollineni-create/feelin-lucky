import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { DATA_DIR, db, schema } from "./db";
import { BOARD_LABEL, ID_PREFIX, buildMatcher, detectBoard, fetchBoard, inPool, type Board, type Fetcher } from "./feed-boards";
import { KNOWN_BOARDS } from "./known-boards";
import { ingestJob } from "./ingest";
import { changeStage, getCriteria, iso, listApplications } from "./logic";

const { companies, applications, jobs } = schema;

export type FeedCompanyResult = { company_id: number; company: string; board: string; seen: number; matched: number; created: number; closed: number; error?: string };
export type FeedScanSummary = {
  started_at: string;
  finished_at: string;
  companies_on_boards: number;
  companies_ok: number;
  postings_seen: number;
  matched: number;
  new_jobs: number;
  /** Found jobs closed because their board no longer lists them. */
  closed: number;
  companies: FeedCompanyResult[];
  errors: string[];
};

const LAST_SCAN_FILE = path.join(DATA_DIR, "feed-scan.json");
const g = globalThis as unknown as { __lodestarFeedScan?: Promise<FeedScanSummary> };

/**
 * The board the app reads for a company: its careers URL when that is a board, otherwise the board Lodestar knows
 * the company posts on (lib/known-boards.ts), so a careers URL pointing at a marketing page doesn't hide it.
 */
export function boardFor(c: { name: string; careersUrl: string | null }): Board | null {
  return detectBoard(c.careersUrl) ?? detectBoard(KNOWN_BOARDS[c.name]);
}

/** Watchlist companies (not paused) whose jobs are on a board the app can read itself. */
export function feedCompanies() {
  return db
    .select()
    .from(companies)
    .where(inArray(companies.priority, ["high", "normal"]))
    .all()
    .map((c) => ({ company: c, board: boardFor(c) }))
    .filter((x): x is { company: typeof x.company; board: Board } => x.board != null);
}

/** Is this company scanned by the feed scanner (so the agent can leave its careers site alone)? */
export function onFeed(c: { name: string; careersUrl: string | null }) {
  return boardFor(c) != null;
}

export function lastFeedScan(): FeedScanSummary | null {
  try {
    return JSON.parse(fs.readFileSync(LAST_SCAN_FILE, "utf8")) as FeedScanSummary;
  } catch {
    return null;
  }
}

/**
 * Reads every watchlist company's job board, keeps the postings that match the search criteria (function words in
 * the title, a location or work mode the user takes), and records them like the agent's finds: deduped against
 * what's already there, unscored, so the agent's prepare phase scores them. A company whose board answered is
 * marked scanned, which takes it off the agent's `companies_due`; one whose board failed is left for the agent to
 * scan in Chrome. Only one scan runs at a time; a second call waits for the first.
 */
export function scanFeeds(opts: { companyIds?: number[]; fetcher?: Fetcher } = {}): Promise<FeedScanSummary> {
  if (g.__lodestarFeedScan) return g.__lodestarFeedScan;
  const run = (async () => {
    const started = iso();
    const criteria = getCriteria();
    const matcher = buildMatcher(criteria);
    const targets = feedCompanies().filter((t) => !opts.companyIds || opts.companyIds.includes(t.company.id));
    const results: FeedCompanyResult[] = [];

    // Workday rate-limits by address across all its tenants, so its boards go three at a time in their own lane;
    // the listed boards (Greenhouse, Lever, Ashby, SmartRecruiters) keep four.
    const scanOne = async ({ company, board }: (typeof targets)[number]) => {
      const r: FeedCompanyResult = { company_id: company.id, company: company.name, board: board.kind, seen: 0, matched: 0, created: 0, closed: 0 };
      try {
        // A high-priority (red) company is worth a look anywhere in the US: its jobs are kept on the function alone,
        // and the score weighs the location. Everyone else has to be in the user's places or remote.
        const keep = company.priority === "high" ? matcher.keepAnywhereInUS : matcher.keep;
        const { seen, kept, allIds } = await fetchBoard(board, matcher, opts.fetcher ?? fetch, new Date(), keep);
        r.seen = seen;
        r.matched = kept.length;
        for (const p of kept) {
          const res = ingestJob(
            {
              company: company.name,
              company_id: company.id,
              title: p.title,
              location: p.location,
              work_mode: p.workMode,
              source: "careers",
              external_id: p.externalId,
              url: p.url,
              pay_text: p.payText,
              posted_at: p.postedAt,
              description: p.description,
            },
            { via: `${BOARD_LABEL[board.kind]} feed` },
          );
          if (res.status === "created") r.created++;
        }
        // The board lists every open posting, so a found job from it that's no longer listed has been taken down.
        // Close it here, so the agent never spends browser time re-opening it. An empty board is treated as an
        // outage, not as every posting gone.
        if (allIds && allIds.size > 0) {
          const prefix = ID_PREFIX[board.kind];
          const gone = listApplications(and(eq(applications.stage, "found"), eq(jobs.companyId, company.id))).filter(
            (a) => a.job.externalId?.startsWith(prefix) && !allIds.has(a.job.externalId),
          );
          for (const a of gone) {
            changeStage(a.id, "closed", { source: "feed", detail: `No longer on ${company.name}'s ${BOARD_LABEL[board.kind]} board`, extra: { closedReason: "posting_closed" } });
            r.closed++;
          }
        }
        db.update(companies)
          .set({ lastScannedAt: iso(), scanNote: null, scanNoteAt: null, ...(company.atsType ? {} : { atsType: board.kind }) })
          .where(eq(companies.id, company.id))
          .run();
      } catch (e) {
        r.error = e instanceof Error ? e.message : String(e);
      }
      results.push(r);
    };
    await Promise.all([
      inPool(targets.filter((t) => t.board.kind !== "workday"), 4, scanOne),
      inPool(targets.filter((t) => t.board.kind === "workday"), 3, scanOne),
    ]);

    results.sort((a, b) => b.created - a.created || a.company.localeCompare(b.company));
    const summary: FeedScanSummary = {
      started_at: started,
      finished_at: iso(),
      companies_on_boards: targets.length,
      companies_ok: results.filter((r) => !r.error).length,
      postings_seen: results.reduce((n, r) => n + r.seen, 0),
      matched: results.reduce((n, r) => n + r.matched, 0),
      new_jobs: results.reduce((n, r) => n + r.created, 0),
      closed: results.reduce((n, r) => n + r.closed, 0),
      companies: results,
      errors: results.filter((r) => r.error).map((r) => `${r.company} (${BOARD_LABEL[r.board as keyof typeof BOARD_LABEL]}): ${r.error}`),
    };
    if (!opts.companyIds) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(LAST_SCAN_FILE, JSON.stringify(summary, null, 2));
    }
    return summary;
  })();
  g.__lodestarFeedScan = run;
  return run.finally(() => {
    g.__lodestarFeedScan = undefined;
  });
}

/** One line for the run log and the Companies page. */
export function feedScanLine(s: FeedScanSummary) {
  if (!s.companies_on_boards) return "No watchlist company has a Greenhouse, Lever, Ashby, SmartRecruiters or Workday careers URL yet.";
  const fails = s.companies_on_boards - s.companies_ok;
  return `Job boards: ${s.companies_ok} of ${s.companies_on_boards} companies read, ${s.postings_seen} postings, ${s.matched} matched the criteria, ${s.new_jobs} new${s.closed ? `, ${s.closed} closed (taken down)` : ""}${fails ? ` · ${fails} board${fails === 1 ? "" : "s"} didn't answer (left for the agent)` : ""}`;
}
