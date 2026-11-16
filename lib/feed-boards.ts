// Job-board feeds: the public JSON that Greenhouse, Lever, Ashby, SmartRecruiters and Workday serve for every
// company's careers page. Reading these is faster and far more reliable than browsing the careers site (no
// Chrome, no extension, no site permissions), so watchlist companies on these boards are scanned by the app
// itself and the agent's browser time goes to custom careers sites and LinkedIn.
//
// This file is pure: board detection, fetch-and-normalize per board, and the title/location matcher. The
// database side (which companies, recording what's found) is lib/feeds.ts.

export type BoardKind = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workday";

export type Board =
  | { kind: "greenhouse"; token: string }
  | { kind: "lever"; token: string; eu: boolean }
  | { kind: "ashby"; token: string }
  | { kind: "smartrecruiters"; token: string }
  | { kind: "workday"; host: string; tenant: string; site: string };

export type WorkMode = "remote" | "hybrid" | "onsite";

/** One open posting, the same shape whatever board it came from. */
export type FeedPosting = {
  externalId: string;
  title: string;
  location: string | null;
  workMode: WorkMode | null;
  url: string;
  postedAt: string | null; // YYYY-MM-DD
  description: string | null;
  payText: string | null;
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** The prefix each board's external ids carry (gh:123), so a job can be traced back to the board that listed it. */
export const ID_PREFIX: Record<BoardKind, string> = { greenhouse: "gh:", lever: "lever:", ashby: "ashby:", smartrecruiters: "sr:", workday: "wd:" };

export const BOARD_LABEL: Record<BoardKind, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters",
  workday: "Workday",
};

const DESCRIPTION_MAX = 6000;

/**
 * The board behind a careers URL, or null when it isn't one the app can read. `atsType` alone isn't enough: the
 * board's company token comes from the URL (boards.greenhouse.io/<token>, jobs.lever.co/<token>, ...).
 */
export function detectBoard(careersUrl: string | null | undefined): Board | null {
  if (!careersUrl) return null;
  let u: URL;
  try {
    u = new URL(careersUrl.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const first = parts[0] ? decodeURIComponent(parts[0]) : "";

  // boards.greenhouse.io/<token>, job-boards.greenhouse.io/<token>, boards.greenhouse.io/embed/job_board?for=<token>
  if (host.endsWith("greenhouse.io")) {
    const forParam = u.searchParams.get("for");
    if (forParam) return { kind: "greenhouse", token: forParam };
    if (first && first !== "embed") return { kind: "greenhouse", token: first };
    return null;
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return first ? { kind: "lever", token: first, eu: host.includes(".eu.") } : null;
  if (host === "jobs.ashbyhq.com") return first ? { kind: "ashby", token: first } : null;
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") return first ? { kind: "smartrecruiters", token: first } : null;
  // <tenant>.wd5.myworkdayjobs.com/[en-US/]<site>
  const wd = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (wd) {
    const rest = parts.filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p));
    const site = rest[0];
    if (!site || site === "wday") return null;
    return { kind: "workday", host, tenant: wd[1], site: decodeURIComponent(site) };
  }
  return null;
}

// ---------- text helpers ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", bull: "•" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Posting HTML (Greenhouse sends it entity-escaped) to plain text the agent can score from. */
export function htmlToText(html: string | null | undefined, max = DESCRIPTION_MAX): string | null {
  if (!html) return null;
  let s = decodeEntities(html); // Greenhouse: &lt;p&gt; → <p>
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/ul|\/ol|p|div|h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+(?=• )/g, "\n")
    .trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

function clip(s: string | null | undefined, max = DESCRIPTION_MAX): string | null {
  const t = (s ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

const day = (v: string | number | null | undefined): string | null => {
  if (v == null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export function inferWorkMode(...texts: (string | null | undefined)[]): WorkMode | null {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\bremote\b|work from home|\bwfh\b/.test(t)) return "remote";
  if (/\bon-?site\b|in[- ]office/.test(t)) return "onsite";
  return null;
}

const modeOf = (v: string | null | undefined): WorkMode | null => {
  const t = (v ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (t === "remote") return "remote";
  if (t === "hybrid") return "hybrid";
  if (t === "onsite" || t === "inoffice") return "onsite";
  return null;
};

/** "Posted 3 Days Ago", "Posted Yesterday", "Posted 30+ Days Ago" → a date. */
export function workdayPostedOn(text: string | null | undefined, now = new Date()): string | null {
  const t = (text ?? "").toLowerCase();
  if (!t) return null;
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  if (t.includes("today")) return ago(0);
  if (t.includes("yesterday")) return ago(1);
  const m = t.match(/(\d+)\+?\s*day/);
  return m ? ago(Number(m[1])) : null;
}

// ---------- fetching ----------

/** Runs `work` over `items`, at most `size` at a time. */
export async function inPool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

const UA = "Lodestar job scanner (personal job search; reads public job-board feeds)";

/** Waits between retries of a rate-limited request; a test swaps it for an instant one. */
export const backoff = { wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
const RETRY_MS = [2_000, 6_000, 15_000];

async function getJson<T>(fetcher: Fetcher, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetcher(url, {
      ...init,
      headers: { Accept: "application/json", "User-Agent": UA, ...(init?.headers ?? {}) },
      signal: init?.signal ?? AbortSignal.timeout(25_000),
    });
    // Workday answers a burst from one address with 429 (sometimes 503). Back off and try again, honouring
    // Retry-After when it's given, rather than writing the whole board off.
    if ((res.status !== 429 && res.status !== 503) || attempt >= RETRY_MS.length) break;
    const after = Number(res.headers.get("retry-after"));
    await backoff.wait(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : RETRY_MS[attempt]);
  }
  if (res.status === 404) throw new Error(`board not found (404) at ${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return (await res.json()) as T;
}

type GreenhouseJob = { id: number; title: string; updated_at?: string; first_published?: string; location?: { name?: string }; absolute_url: string; content?: string };
type LeverJob = {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  workplaceType?: string;
  categories?: { location?: string; allLocations?: string[]; commitment?: string };
  descriptionPlain?: string;
  lists?: { text?: string; content?: string }[];
  additionalPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
};
type AshbyJob = {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl: string;
  publishedAt?: string;
  descriptionPlain?: string;
  isListed?: boolean;
  compensation?: { compensationTierSummary?: string; scrapeableCompensationSalarySummary?: string };
};
type SmartRecruitersJob = { id: string; name: string; releasedDate?: string; location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string } };
type WorkdayListItem = { title: string; externalPath: string; locationsText?: string; postedOn?: string; bulletFields?: string[] };
type WorkdayDetail = { jobPostingInfo?: { jobDescription?: string; startDate?: string; location?: string; remoteType?: string; jobReqId?: string; externalUrl?: string; additionalLocations?: string[] } };

const money = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`);

async function greenhouse(fetcher: Fetcher, token: string): Promise<FeedPosting[]> {
  const data = await getJson<{ jobs: GreenhouseJob[] }>(fetcher, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`);
  return (data.jobs ?? []).map((j) => {
    const location = j.location?.name?.trim() || null;
    const description = htmlToText(j.content);
    return {
      externalId: `gh:${j.id}`,
      title: j.title.trim(),
      location,
      workMode: inferWorkMode(location),
      url: j.absolute_url,
      postedAt: day(j.first_published ?? j.updated_at),
      description,
      payText: null,
    };
  });
}

async function lever(fetcher: Fetcher, token: string, eu: boolean): Promise<FeedPosting[]> {
  const base = eu ? "https://api.eu.lever.co" : "https://api.lever.co";
  const data = await getJson<LeverJob[]>(fetcher, `${base}/v0/postings/${encodeURIComponent(token)}?mode=json`);
  return (data ?? []).map((j) => {
    const location = j.categories?.allLocations?.length ? j.categories.allLocations.join(" / ") : j.categories?.location?.trim() || null;
    const lists = (j.lists ?? []).map((l) => `${l.text ?? ""}\n${htmlToText(l.content, 2000) ?? ""}`).join("\n\n");
    const s = j.salaryRange;
    return {
      externalId: `lever:${j.id}`,
      title: j.text.trim(),
      location,
      workMode: modeOf(j.workplaceType) ?? inferWorkMode(location),
      url: j.hostedUrl,
      postedAt: day(j.createdAt),
      description: clip([j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join("\n\n")),
      payText: s?.min && s?.max ? `${money(s.min)}–${money(s.max)}${s.interval ? ` ${s.interval.replace(/-/g, " ")}` : ""}` : null,
    };
  });
}

async function ashby(fetcher: Fetcher, token: string): Promise<FeedPosting[]> {
  const data = await getJson<{ jobs: AshbyJob[] }>(fetcher, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`);
  return (data.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const locs = [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter((l): l is string => Boolean(l?.trim()));
      const location = locs.length ? locs.join(" / ") : null;
      return {
        externalId: `ashby:${j.id}`,
        title: j.title.trim(),
        location,
        workMode: modeOf(j.workplaceType) ?? (j.isRemote ? "remote" : inferWorkMode(location)),
        url: j.jobUrl,
        postedAt: day(j.publishedAt),
        description: clip(j.descriptionPlain),
        payText: j.compensation?.scrapeableCompensationSalarySummary ?? j.compensation?.compensationTierSummary ?? null,
      };
    });
}

async function smartrecruiters(fetcher: Fetcher, token: string): Promise<FeedPosting[]> {
  const out: FeedPosting[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const data = await getJson<{ totalFound?: number; content?: SmartRecruitersJob[] }>(
      fetcher,
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100&offset=${offset}`,
    );
    for (const j of data.content ?? []) {
      const l = j.location ?? {};
      const location = l.fullLocation ?? ([l.city, l.region, l.country?.toUpperCase()].filter(Boolean).join(", ") || null);
      out.push({
        externalId: `sr:${j.id}`,
        title: j.name.trim(),
        location: l.remote ? `Remote${location ? ` (${location})` : ""}` : location,
        workMode: l.remote ? "remote" : l.hybrid ? "hybrid" : inferWorkMode(location),
        url: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${j.id}`,
        postedAt: day(j.releasedDate),
        // The list has no description; the agent reads the posting when it scores it.
        description: null,
        payText: null,
      });
    }
    if (!data.content?.length || offset + 100 >= (data.totalFound ?? 0)) break;
  }
  return out;
}

/**
 * Workday has no "every job" feed worth pulling (big tenants list thousands), so it is searched: one search per
 * title keyword, two pages each, and the details (description, exact location) fetched only for the postings the
 * matcher keeps, at most `detailCap` of them.
 */
async function workday(
  fetcher: Fetcher,
  b: Extract<Board, { kind: "workday" }>,
  searches: string[],
  keep: (p: FeedPosting) => boolean,
  detailCap = 80,
  now = new Date(),
): Promise<{ seen: number; kept: FeedPosting[] }> {
  const api = `https://${b.host}/wday/cxs/${encodeURIComponent(b.tenant)}/${encodeURIComponent(b.site)}`;
  const seen = new Map<string, FeedPosting>();
  await inPool(searches.length ? searches : [""], 1, async (q) => {
    for (let offset = 0; offset < 40; offset += 20) {
      const data = await getJson<{ total?: number; jobPostings?: WorkdayListItem[] }>(fetcher, `${api}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: q }),
      });
      for (const j of data.jobPostings ?? []) {
        if (!j.externalPath || seen.has(j.externalPath)) continue;
        seen.set(j.externalPath, {
          externalId: `wd:${j.bulletFields?.[0] ?? j.externalPath}`,
          title: j.title.trim(),
          location: j.locationsText?.trim() || null,
          workMode: inferWorkMode(j.locationsText),
          url: `https://${b.host}/${b.site}${j.externalPath}`,
          postedAt: workdayPostedOn(j.postedOn, now),
          description: null,
          payText: null,
        });
      }
      if (!data.jobPostings?.length || offset + 20 >= (data.total ?? 0)) break;
    }
  });
  const kept = [...seen.entries()].filter(([, p]) => keep(p));
  await inPool(kept.slice(0, detailCap), 2, async ([path, p]) => {
    try {
      const d = await getJson<WorkdayDetail>(fetcher, `${api}${path}`);
      const info = d.jobPostingInfo;
      if (!info) return;
      p.description = htmlToText(info.jobDescription);
      if (info.externalUrl) p.url = info.externalUrl;
      if (info.jobReqId) p.externalId = `wd:${info.jobReqId}`;
      if (info.location && (!p.location || /\d+ locations/i.test(p.location))) p.location = [info.location, ...(info.additionalLocations ?? [])].join(" / ");
      p.workMode = modeOf(info.remoteType) ?? p.workMode ?? inferWorkMode(p.location);
      p.postedAt = day(info.startDate) ?? p.postedAt;
    } catch {
      // A detail that won't load still leaves the posting; the agent reads it when it scores.
    }
  });
  // The list row can say "3 Locations"; the detail gives the real cities, which may all be abroad. Check again.
  return { seen: seen.size, kept: kept.map(([, p]) => p).filter((p) => keep(p)) };
}

/** Every open posting on a board that the matcher keeps. */
export async function fetchBoard(
  board: Board,
  matcher: Matcher,
  fetcher: Fetcher = fetch,
  now = new Date(),
  keep: (p: FeedPosting) => boolean = matcher.keep,
): Promise<{ seen: number; kept: FeedPosting[]; allIds?: Set<string> }> {
  // Workday is searched, not listed, so its results can't say a posting is gone: no allIds.
  if (board.kind === "workday") return workday(fetcher, board, matcher.searchTerms, keep, 80, now);
  const all =
    board.kind === "greenhouse"
      ? await greenhouse(fetcher, board.token)
      : board.kind === "lever"
        ? await lever(fetcher, board.token, board.eu)
        : board.kind === "ashby"
          ? await ashby(fetcher, board.token)
          : await smartrecruiters(fetcher, board.token);
  return { seen: all.length, kept: all.filter(keep), allIds: new Set(all.map((p) => p.externalId)) };
}

// ---------- matching ----------

/**
 * Title phrases for each kind of function in the search criteria. A function that matches none of these falls
 * back to its own words ("Treasury / payments" → "treasury", "payments"). Phrases match whole words in the title.
 */
const FUNCTION_TITLES: [RegExp, string[]][] = [
  [/corporate development|corp\.? ?dev|m&a/i, ["corporate development", "corp dev", "m&a", "mergers", "acquisitions", "corporate strategy", "business development"]],
  [/strateg(y|ic)\b(?!.*finance)|operations/i, ["strategy", "business operations", "bizops", "strategy and operations", "strategy & operations", "chief of staff", "strategic initiatives"]],
  [/strategic finance|fp&a|financ/i, ["strategic finance", "fp&a", "financial planning", "corporate finance", "finance manager", "finance lead", "financial analyst", "finance associate", "finance"]],
  [/treasury|payments?|cash/i, ["treasury", "treasurer", "payments", "payment", "cash management", "liquidity", "capital markets", "funding"]],
  [/bank/i, ["banking", "banker", "relationship manager", "commercial lending", "credit", "lending", "commercial banking", "corporate banking"]],
  [/product/i, ["product manager", "product management", "product lead", "product owner", "group product manager"]],
  [/partner/i, ["partnerships", "partnership", "partner manager", "alliances", "business development"]],
];

/** Titles that are never one of the user's functions, whatever word they share with it. */
const EXCLUDE_TITLE = /\b(intern|internship|co-?op|apprentice|software|engineer|engineering|developer|data scientist|scientist|designer|recruiter|recruiting|nurse|technician|driver|warehouse|cashier|counsel|attorney|paralegal|teller|account executive|sales development|customer success|support specialist)\b/i;

export type MatchCriteria = { functions: string[]; primaryLocations: string[]; secondaryLocations: string[]; workModes: string[] };

export type Matcher = {
  /** Phrases a title must contain one of (lowercase). */
  phrases: string[];
  /** Short search strings for boards that are searched rather than listed (Workday). */
  searchTerms: string[];
  keep: (p: Pick<FeedPosting, "title" | "location" | "workMode">) => boolean;
  /** For high-priority companies: the function matches and the job isn't abroad, wherever in the US it is. */
  keepAnywhereInUS: (p: Pick<FeedPosting, "title" | "location" | "workMode">) => boolean;
  titleMatches: (title: string) => boolean;
  locationMatches: (p: Pick<FeedPosting, "location" | "workMode">) => boolean;
};

const FOREIGN = /\b(uk|united kingdom|england|scotland|wales|edinburgh|glasgow|manchester|belfast|london|dublin|ireland|luxembourg|belgium|brussels|denmark|copenhagen|norway|oslo|finland|helsinki|austria|vienna|portugal|lisbon|czech|prague|hungary|budapest|romania|bucharest|krakow|taiwan|taipei|vietnam|malaysia|kuala lumpur|indonesia|jakarta|thailand|bangkok|south africa|nigeria|kenya|egypt|saudi|riyadh|qatar|doha|chile|santiago|peru|lima|costa rica|new zealand|auckland|mumbai|pune|chennai|gurgaon|gurugram|noida|canada|toronto|vancouver|montreal|india|bengaluru|bangalore|hyderabad|germany|berlin|munich|europe|emea|apac|latam|mexico|brazil|singapore|australia|sydney|japan|tokyo|poland|warsaw|spain|madrid|barcelona|france|paris|netherlands|amsterdam|hong kong|china|shanghai|korea|seoul|israel|tel aviv|uae|dubai|switzerland|zurich|sweden|stockholm|italy|milan|philippines|argentina|colombia)\b/;
const US = /\b(us|usa|united states|u\.s\.|americas|north america)\b|, (al|ak|az|ar|ca|co|ct|de|dc|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function titlePhrases(functions: string[]): string[] {
  const out = new Set<string>();
  for (const f of functions) {
    const hits = FUNCTION_TITLES.filter(([re]) => re.test(f));
    if (hits.length) for (const [, ps] of hits) ps.forEach((p) => out.add(p));
    else
      f.split(/[/,&]| and /i)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length >= 4)
        .forEach((w) => out.add(w));
  }
  return [...out];
}

/** "Seattle, WA" → "seattle"; "Washington, DC" → "washington". */
const cityOf = (loc: string) => loc.split(",")[0].trim().toLowerCase();

export function buildMatcher(c: MatchCriteria): Matcher {
  const phrases = titlePhrases(c.functions);
  const titleRes = phrases.map((p) => new RegExp(`(^|[^a-z0-9])${escapeRe(p)}($|[^a-z0-9])`, "i"));
  const cities = [...c.primaryLocations, ...c.secondaryLocations].map(cityOf).filter(Boolean);
  const remoteOk = c.workModes.includes("remote");
  const onsiteOk = c.workModes.includes("onsite") || c.workModes.includes("hybrid");

  const titleMatches = (title: string) => !EXCLUDE_TITLE.test(title) && titleRes.some((re) => re.test(title));
  // Tied to another country, and not to the US as well ("London, UK" yes; "New York, NY / London, UK" no).
  const abroad = (loc: string) => FOREIGN.test(loc) && !US.test(loc);
  const locationMatches = (p: Pick<FeedPosting, "location" | "workMode">) => {
    const loc = (p.location ?? "").toLowerCase();
    const remote = p.workMode === "remote" || /\bremote\b|anywhere/.test(loc);
    if (remote) return remoteOk && !abroad(loc);
    // No location given, or "multiple locations": keep it and let the score decide.
    if (!loc.trim() || /multiple|various|several|\d+ locations|united states|^usa?$|nationwide/.test(loc)) return true;
    return onsiteOk && cities.some((city) => loc.includes(city));
  };
  // Workday search strings: the shorter phrases, which also find the longer ones ("treasury" finds "Treasury Analyst").
  const searchTerms = [...new Set(phrases.filter((p) => !p.includes(" ") || p.length <= 18))].slice(0, 12);
  return {
    phrases,
    searchTerms,
    titleMatches,
    locationMatches,
    keep: (p) => titleMatches(p.title) && locationMatches(p),
    keepAnywhereInUS: (p) => titleMatches(p.title) && !abroad((p.location ?? "").toLowerCase()) && (remoteOk || p.workMode !== "remote"),
  };
}
