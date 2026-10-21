// How Lodestar reads an email: who sent it, whether it's about the job search, what it says, and which
// application it's about. Pure functions, so they can be checked without a Mac (lib/mail-rules.test.ts);
// lib/mail.ts does the reading and recording.
import type { EmailKind, Stage } from "@/db/schema";

export type Sender = { name: string | null; address: string | null; domain: string | null };

/** "Stripe Recruiting <no-reply@stripe.com>", "\"Doe, Jane\" <jane@x.com>" or a bare address. */
export function parseSender(raw: string | null | undefined): Sender {
  const s = (raw ?? "").trim();
  const angle = s.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  let name: string | null = null;
  let address: string | null = null;
  if (angle) {
    name = angle[1].trim().replace(/^"(.*)"$/, "$1").trim() || null;
    address = angle[2];
  } else if (/^[^\s@]+@[^\s@]+$/.test(s)) {
    address = s;
  } else {
    name = s || null;
  }
  address = address?.toLowerCase() ?? null;
  const domain = address?.split("@")[1]?.replace(/\.$/, "") ?? null;
  return { name, address, domain };
}

const domainIs = (domain: string | null, d: string) => Boolean(domain && (domain === d || domain.endsWith(`.${d}`)));

/**
 * Sender domains of applicant tracking systems and assessment tools. What they send a candidate is about an
 * application (Workday, for one, sends from <company>@myworkday.com).
 */
export const ATS_DOMAINS = [
  "greenhouse.io", "greenhouse-mail.io", "lever.co", "ashbyhq.com", "myworkday.com", "workday.com", "smartrecruiters.com",
  "icims.com", "taleo.net", "oraclecloud.com", "successfactors.com", "successfactors.eu", "eightfold.ai", "jobvite.com",
  "bamboohr.com", "paylocity.com", "ultipro.com", "ukg.com", "workable.com", "workablemail.com", "recruitee.com",
  "applytojob.com", "jazzhr.com", "breezy.hr", "dayforcehcm.com", "avature.net", "phenompeople.com", "phenom.com",
  "rippling.com", "teamtailor.com", "teamtailor-mail.com", "pinpointhq.com", "comeet.co", "gem.com", "personio.com",
  "personio.de", "cloud.oracle.com", "dover.io", "dayforce.com", "hackerrank.com", "hackerrankforwork.com", "codesignal.com",
  "codility.com", "hirevue.com", "modernhire.com", "vidcruiter.com", "karat.io", "karat.com", "goodtime.io", "modernloop.io",
  "paradox.ai",
];

/** Tools whose mail is an assessment or a recorded interview to complete. */
const ASSESSMENT_DOMAINS = ["hackerrank.com", "hackerrankforwork.com", "codesignal.com", "codility.com", "hirevue.com", "modernhire.com", "vidcruiter.com", "karat.io", "karat.com"];

/**
 * Account and security mail from the same systems ("verify your candidate account", "confirm your identity for job
 * …", a half-finished application): nothing about where an application stands, so not kept.
 */
const ACCOUNT_MAIL = /\b(?:verify your (?:candidate )?(?:account|email)|reset your password|password reset|confirm your (?:identity|email)|(?:security|verification|one[- ]time) (?:code|passcode)|you've started your (?:job )?application|(?:job )?application is incomplete|finish your application)\b/i;

/**
 * Job boards. Most of what they send is job alerts and digests, which name lots of companies; only their
 * "your application was sent / viewed" mail is about an application.
 */
export const JOB_BOARD_DOMAINS = ["linkedin.com", "indeed.com", "indeedemail.com", "glassdoor.com", "ziprecruiter.com", "monster.com", "dice.com", "wellfound.com", "angel.co", "builtin.com"];

export const atsOf = (domain: string | null) => ATS_DOMAINS.find((d) => domainIs(domain, d)) ?? null;
const jobBoardOf = (domain: string | null) => JOB_BOARD_DOMAINS.find((d) => domainIs(domain, d)) ?? null;

/** Curly quotes, non-breaking spaces and runs of spaces, so phrases match however the email was typed. */
export function plain(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[   ]/g, " ")
    .replace(/[ \t]+/g, " ");
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A sentence about what might happen rather than what has: "If selected, we'll reach out to schedule an interview",
// "You may be asked to complete an assessment", "If we decide not to move forward, we'll let you know".
const CONDITIONAL = /\b(?:if|should|once|whether|unless|in the event|may|might)\b/i;
// A sentence about candidates in general: "We'll contact qualified candidates to schedule interviews". Not used for
// rejections, which talk about "other candidates whose experience…".
const GENERAL = /\b(?:qualified candidates|selected candidates|candidates (?:whose|who|that)|those (?:whose|who))\b/i;

const anyIn = (res: RegExp[], text: string) => res.some((re) => re.test(text));
/** Some sentence that isn't conditional (or, with `general`, about candidates in general) says one of these. */
const says = (res: RegExp[], text: string, general = true) =>
  sentences(text).some((s) => !CONDITIONAL.test(s) && !(general && GENERAL.test(s)) && anyIn(res, s));

const REJECTION = [
  /\bnot (?:to |be )?(?:move|moving) forward\b/i,
  /n't (?:be )?(?:mov(?:e|ing)|progress(?:ing)?|proceed(?:ing)?|advanc(?:e|ing)) forward\b/i,
  /\bmade the decision (?:not to|to not) (?:move|proceed|progress)\b/i,
  /\b(?:application|candidacy) (?:was|has been|is) not successful\b/i,
  /\bnot (?:a|the right|an ideal|a good) (?:fit|match)\b|\b(?:isn't|is not|wasn't) (?:an? )?(?:ideal |good |strong )?(?:fit|match)\b/i,
  /\bfilled (?:the|this) (?:position|role|opening)\b/i,
  /\bno longer accepting applications\b/i,
  /\bapplication_rejected\b/i,
  /\bunfortunately,? .{0,60}\bhas moved (?:on|to the next step)/i,
  /\b(?:won't|will not|wouldn't|would not|can't|cannot|are unable to|unable to|not able to) (?:be )?(?:mov(?:e|ing) forward|proceed(?:ing)?(?: further)? with (?:your|the) (?:application|candidacy)|advanc(?:e|ing) (?:you|your)|offer(?:ing)? you (?:the|this|a|an) (?:position|role|job)|progress(?:ing)? (?:with )?your (?:application|candidacy)|pursu(?:e|ing) your)/i,
  /\bdecided (?:not to (?:move|proceed|pursue|advance|progress)|to (?:move|proceed|go) (?:forward )?with (?:other|another|a different)|to pursue (?:other|another))/i,
  /\bpursue other candidates\b/i,
  /\b(?:move|moving|proceed|proceeding|go|going) forward with (?:other|another) (?:candidates?|applicants?)\b/i,
  /\bother (?:candidates?|applicants?) (?:whose|who|that)\b/i,
  /\b(?:have|has|had|were|was) not been selected\b|\b(?:were|was) not selected\b/i,
  /\b(?:position|role|job|opening|requisition) (?:has|have) (?:now )?been (?:filled|closed|cancel+ed)\b/i,
  /\bno longer (?:be )?(?:considering|under consideration|being considered|in consideration)\b/i,
  /\b(?:application|candidacy) (?:was|has been|is) (?:declined|rejected|unsuccessful)\b|\bwere unsuccessful\b/i,
  /\bdecline your application\b/i,
  /\b(?:go|going) (?:in|with) a different direction\b/i,
];

const OFFER = [
  /\boffer letter\b/i,
  /\b(?:pleased|happy|excited|delighted|thrilled) to (?:extend|offer) you (?:an? |the )?(?:offer|position|role|job)\b/i,
  /\b(?:formal|verbal|written) offer\b/i,
  /\boffer of employment\b/i,
  /\bextend(?:ing)? (?:you )?an offer\b/i,
];

const ASSESSMENT = [
  /\b(?:online|technical|skills?|coding|cognitive|personality|video|pre-employment) assessment\b|\bassessment (?:link|invitation|invite)\b|\bcomplete (?:the|this|your|an?) (?:\w+ )?assessment\b/i,
  /\bcoding (?:challenge|exercise|test)\b/i,
  /\btake[- ]home\b/i,
  /\b(?:hackerrank|codesignal|codility|hirevue|karat|vidcruiter)\b/i,
  /\bonline (?:test|exercise)\b/i,
  /\bcase study\b/i,
  /\bcomplete (?:the|this|your|an?) (?:test|questionnaire|exercise|challenge|video interview)\b/i,
];

const INTERVIEW = [
  /\b(?:interview|screening|phone screen) (?:invitation|invite|request|scheduled|scheduling|confirmation)\b/i,
  /\binvit(?:e|ing|ation)\b.{0,40}\b(?:interview|next round|video interview)\b/i,
  /\b(?:would like|like) to (?:schedule|set up|arrange)\b.{0,30}\b(?:interview|call|chat|conversation)\b/i,
  /\byour interview is scheduled\b/i,
  /\bmodernloop\.io\b|\bparadox\.ai\b/i,
  /\bschedule (?:a|an|your|the|some) (?:time|call|chat|interview|conversation|phone|video|zoom|meeting|screen)/i,
  /\b(?:your|share your|send (?:me|us) your|provide your|let (?:me|us) know your) (?:interview )?availability\b/i,
  /\b(?:are you|would you be) available (?:for|to|on)\b/i,
  /\bset up (?:a |some )?(?:time|call|chat|meeting|interview)\b/i,
  /\b(?:book|pick|select|choose) (?:a |your )?(?:time|slot|interview time)\b/i,
  /\bcalendly\.com\b|\bgoodtime\.io\b/i,
  /\binvite you (?:to|for) (?:an? |the )?(?:interview|call|chat|conversation|phone screen|next round|onsite|virtual)/i,
  /\b(?:like|love) to (?:speak|chat|talk|connect|schedule|invite|meet|move forward)\b/i,
  /\b(?:phone|recruiter|initial) (?:screen|call|conversation|interview)\b/i,
  /\binterview (?:invitation|request|confirmation|confirmed|scheduled|details)\b/i,
  /\bnext (?:step|round)s? (?:in|of) (?:the|our) (?:process|interview)/i,
  /\bmove (?:you )?forward (?:to|in|with) (?:the next|your application|the interview)/i,
];

const CONFIRMATION = [
  /\b(?:we've|we have|we) (?:successfully )?received your (?:resume|submission)\b/i,
  /\bapplication (?:confirmation|acknowledg(?:e)?ment)\b/i,
  /\bhas your application\b/i,
  /\bsubmitted successfully\b/i,
  /\bcompleting your application\b/i,
  /^indeed application:/im,
  /\bthank(?:s| you) for (?:your )?(?:applying|application|submitting)\b/i,
  /\b(?:we've|we have|we) (?:successfully )?received your (?:job )?application\b/i,
  /\byour (?:job )?application (?:has been|was|is) (?:successfully )?(?:received|submitted|sent|complete)\b/i,
  /\bapplication (?:has been )?(?:received|submitted)\b/i,
  /\bsuccessfully (?:applied|submitted)\b/i,
  /\byour application was sent to\b/i,
  /\breceipt of your application\b/i,
  /\bwe(?:'ll| will) (?:review|be reviewing|carefully review) your (?:application|qualifications|background|resume|experience)\b/i,
];

// Rejections open this way too, so on its own it's a guess, not a confirmation.
const WEAK_CONFIRMATION = [/\bthank(?:s| you) for (?:your )?interest in\b/i];

const UPDATE = [
  /\b(?:application|candidacy) (?:status|update)\b/i,
  /\bstatus of your (?:application|candidacy)\b/i,
  /\bunder (?:review|consideration)\b/i,
  /\bbeing reviewed\b/i,
  /\b(?:was|has been) viewed\b/i,
  /\bstill (?:reviewing|under review|considering)\b/i,
  /\bupdate on your (?:application|candidacy)\b/i,
  /\bstatus (?:has )?changed\b/i,
];

// Words that mean an email is asking something of the candidate. A confirmation or status update that has one of
// these outside a hypothetical sentence ("A recruiter will reach out to schedule a call") isn't recorded on its own.
const ASKS = [/\binterview/i, /\bschedul/i, /\bavailab/i, /\bassessment/i, /\bphone screen/i, /\bnext round/i, /\boffer\b/i];

export type Classification = { kind: EmailKind; confident: boolean };

/**
 * What the email says. Only rejections, plain confirmations and status updates are `confident`: the app records
 * those on its own. Interviews, assessments, offers and anything else are a guess for the agent or you to check.
 */
export function classify(subject: string | null | undefined, body: string | null | undefined, sender?: Sender): Classification {
  const text = `${plain(subject)}\n${plain(body)}`;
  const offer = says(OFFER, text);
  const assessment = ASSESSMENT_DOMAINS.some((d) => domainIs(sender?.domain ?? null, d)) || says(ASSESSMENT, text);
  const interview = says(INTERVIEW, text);
  // A rejection that asks for nothing is certain. One that also asks to talk, test or sign is a reschedule or offer
  // paperwork ("unable to proceed with Tuesday's interview; could you share your availability?"), never recorded
  // as a rejection on its own.
  if (says(REJECTION, text, false) && !offer && !assessment && !interview) return { kind: "rejection", confident: true };
  if (offer) return { kind: "offer", confident: false };
  if (assessment) return { kind: "assessment", confident: false };
  if (interview) return { kind: "interview", confident: false };
  const asks = says(ASKS, text);
  if (anyIn(CONFIRMATION, text)) return { kind: "confirmation", confident: !asks };
  if (anyIn(WEAK_CONFIRMATION, text)) return { kind: "confirmation", confident: false };
  if (anyIn(UPDATE, text)) return { kind: "update", confident: !asks };
  return { kind: "other", confident: false };
}

/** The email asks to talk, to take a test or to sign: worth keeping even when it doesn't say "application". */
export function asksSomething(subject: string | null | undefined, body: string | null | undefined) {
  const text = `${plain(subject)}\n${plain(body)}`;
  return says(INTERVIEW, text) || says(ASSESSMENT, text) || says(OFFER, text);
}

// ---------- Which application ----------

export type Candidate = { id: number; stage: Stage; company: string; title: string; domains: string[] };
export type Match = { applicationId: number | null; matchedBy: "title" | "company" | null; candidateIds: number[] };
/** What matchEmail saw on the way: the company named anywhere, by the sender or subject, and a job title named. */
export type Seen = { companyNamed: boolean; senderNamed: boolean; titleNamed: boolean };

/** Stages where an application is in flight: a company-only match must be the one application here. */
export const LIVE_STAGES: Stage[] = ["approved", "applied", "screening", "interviewing", "offer"];

const SUFFIX = /[,\s]+(?:inc\.?|incorporated|llc|l\.l\.c\.|ltd\.?|limited|corp\.?|corporation|co\.?|company|plc|lp|l\.p\.|n\.a\.|group|holdings?)$/i;

/** "Cash App / Block / Square" → its three names; "Acme, Inc." → "Acme, Inc." and "Acme". */
export function companyAliases(name: string): string[] {
  const out = new Set<string>();
  for (const part of name.split(/\s+\/\s+|\s*\(|\)\s*/)) {
    let p = part.trim();
    if (!p) continue;
    out.add(p);
    for (let i = 0; i < 3 && SUFFIX.test(p); i++) {
      p = p.replace(SUFFIX, "").trim();
      out.add(p);
    }
    if (/^the\s/i.test(p)) out.add(p.replace(/^the\s+/i, ""));
  }
  return [...out].filter((a) => a.length >= 2);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (phrase: string, flags = "") => new RegExp(`(?<![A-Za-z0-9])${escapeRe(phrase)}(?![A-Za-z0-9])`, flags);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The company's own domain, from its careers page ("careers.stripe.com" → "stripe.com"); none for job boards. */
export function companyDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (atsOf(host) || jobBoardOf(host)) return null;
  const labels = host.split(".");
  const n = labels.length >= 3 && /^(?:co|com|org|net|gov|ac)$/.test(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(-n).join(".");
}

type CompanyHit = "sender" | "body" | null;

/**
 * Where the email names the company: in who sent it or the subject ("sender"), or only in the body. The body is
 * matched case-sensitively, so "Block" the company isn't "block your calendar".
 */
function companyHit(c: Candidate, sender: Sender, subject: string, body: string): CompanyHit {
  if (sender.domain && c.domains.some((d) => domainIs(sender.domain, d))) return "sender";
  const aliases = companyAliases(c.company);
  // Workday sends from <company>@myworkday.com, iCIMS from <company>+autoreply@talent.icims.com, Jobvite and
  // Teamtailor from a company subdomain (jobvite.nutanix.com, acme.teamtailor-mail.com).
  const local = slug(sender.address?.split("@")[0]?.split("+")[0] ?? "");
  const labels = atsOf(sender.domain) || jobBoardOf(sender.domain) ? [] : (sender.domain ?? "").split(".").slice(0, -1);
  const atsLabels = atsOf(sender.domain) ? (sender.domain ?? "").split(".") : [];
  if (aliases.some((a) => slug(a).length >= 4 && (local === slug(a) || atsLabels.includes(slug(a)) || labels.includes(slug(a))))) return "sender";
  if (aliases.some((a) => (sender.name && wordRe(a, "i").test(sender.name)) || wordRe(a).test(subject))) return "sender";
  if (aliases.some((a) => wordRe(a).test(body))) return "body";
  return null;
}

const TITLE_STOP = new Set(["and", "of", "the", "for", "to", "in", "at", "an", "with", "on", "remote", "hybrid", "onsite", "us", "usa", "ii", "iii", "iv", "job", "role", "position", "full", "time"]);

function normTitle(t: string): string {
  return ` ${t
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/\bsr\b\.?/g, "senior")
    .replace(/\bjr\b\.?/g, "junior")
    .replace(/\bmgr\b\.?/g, "manager")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}
const titleWords = (t: string) => normTitle(t).trim().split(" ").filter((w) => w.length >= 2 && !TITLE_STOP.has(w));

/** "exact" when the email has the title as written; "words" when it has nearly all of its words in some order. */
function titleHit(title: string, subject: string, body: string): "exact" | "words" | null {
  const near = normTitle(`${subject} ${body.slice(0, 2500)}`);
  const t = normTitle(title);
  if (t.trim().length >= 4 && (near.includes(t) || normTitle(body).includes(t))) return "exact";
  // Two words ("Product Manager") show up in too many emails to count without the title as written.
  const words = titleWords(title);
  if (words.length < 3) return null;
  const have = new Set(near.trim().split(" "));
  return words.filter((w) => have.has(w)).length / words.length >= 0.8 ? "words" : null;
}

/**
 * Which application an email is about. The company has to be named by the sender or in the subject (a company named
 * only in the body is someone else's email mentioning it). Then a clear title match wins; failing that, an email
 * from a company with exactly one application in flight is probably that one (matchedBy "company", which the app
 * only suggests). Anything else is left for the agent or you, with the applications it could be about.
 */
export function matchEmail(e: { sender: Sender; subject: string; body: string }, candidates: Candidate[]): Match & Seen {
  const subject = plain(e.subject);
  const body = plain(e.body);
  const hits = candidates.map((c) => ({ c, co: companyHit(c, e.sender, subject, body) })).filter((h) => h.co);
  const titledAll = hits.map((h) => ({ ...h, t: titleHit(h.c.title, subject, body) })).filter((h) => h.t);
  const titled = titledAll.filter((h) => h.co === "sender");
  const live = (h: { c: Candidate }) => LIVE_STAGES.includes(h.c.stage);
  // Suggestions: named by the sender before named only in the body, in flight before found, titled first.
  const ranked = [...new Set([...titledAll, ...hits].sort((a, b) => Number(b.co === "sender") - Number(a.co === "sender") || Number(live(b)) - Number(live(a))).map((h) => h.c.id))].slice(0, 8);
  const out = (applicationId: number | null, matchedBy: Match["matchedBy"], ids: number[]) => ({
    applicationId,
    matchedBy,
    candidateIds: applicationId ? [] : ids,
    companyNamed: hits.length > 0,
    senderNamed: hits.some((h) => h.co === "sender"),
    titleNamed: titledAll.length > 0,
  });

  const exact = titled.filter((h) => h.t === "exact");
  for (const pool of [exact, titled]) {
    if (pool.length === 1) return out(pool[0].c.id, "title", []);
    if (pool.length > 1) {
      const inFlight = pool.filter(live);
      if (inFlight.length === 1) return out(inFlight[0].c.id, "title", []);
      return out(null, null, pool.map((h) => h.c.id));
    }
  }
  const named = hits.filter((h) => h.co === "sender" && live(h));
  if (named.length === 1) return out(named[0].c.id, "company", []);
  return out(null, null, ranked);
}

// ---------- Is it about the job search at all ----------

const RECRUITER_SENDER = /recruit|talent|career|hiring|\bjobs?\b|people ?(?:team|ops)|human resources|\bhr\b|staffing|acquisition/i;
const APP_PHRASE = /\b(?:your (?:job )?application|applying (?:for|to)|applied (?:for|to)|you applied|candidacy|interview|your (?:recent )?submission)\b/i;
const BOARD_APPLICATION_SUBJECT = /\byour application\b|\bapplication (?:was |has been )?(?:sent|submitted|received|viewed)\b|\byou applied\b|\bapplied (?:to|for)\b|\bapplication (?:status|update)\b|^indeed application:/i;

/**
 * Whether an email is about the job search: from an applicant tracking system, a job board's application notice,
 * or a recruiter or a company Lodestar knows writing about an application. Bank, shopping and newsletter mail
 * from the same companies ("your credit card application") isn't.
 */
export function isJobEmail(e: { sender: Sender; subject: string; body: string }, m: Seen): boolean {
  const subject = plain(e.subject);
  const text = `${subject}\n${plain(e.body)}`;
  if (ACCOUNT_MAIL.test(subject)) return false;
  if (jobBoardOf(e.sender.domain)) return BOARD_APPLICATION_SUBJECT.test(subject);
  const appPhrase = APP_PHRASE.test(text);
  if (atsOf(e.sender.domain)) return appPhrase || !/\bunsubscribe\b/i.test(text);
  const recruiter = RECRUITER_SENDER.test(`${e.sender.name ?? ""} ${e.sender.address ?? ""}`);
  if ((recruiter || m.companyNamed) && appPhrase) return true;
  // Someone at the company writing to ask for a call, a test or a signature, in their own words.
  if (m.senderNamed && asksSomething(e.subject, e.body)) return true;
  return m.companyNamed && m.titleNamed && /\b(?:position|role|opening|opportunity|recruit|candidate)\b/i.test(text);
}

/**
 * What the bridge looks for in sender and subject before it reads a message's body: the job systems' domains, the
 * companies' own domains and names, and words recruiting mail uses. Generous on purpose; isJobEmail decides.
 */
export function prefilter(candidates: Candidate[]): { domains: string[]; terms: string[] } {
  const domains = new Set([...ATS_DOMAINS, ...JOB_BOARD_DOMAINS]);
  const terms = new Set(["application", "applying", "applied", "candidacy", "candidate", "interview", "recruit", "talent", "career", "hiring", "assessment", "offer letter", "your submission", "position", "next steps"]);
  for (const c of candidates) {
    c.domains.forEach((d) => domains.add(d));
    for (const a of companyAliases(c.company)) if (a.length >= 3) terms.add(a.toLowerCase());
  }
  return { domains: [...domains], terms: [...terms] };
}

// ---------- What an email may do to an application ----------

const ORDER: Partial<Record<Stage, number>> = { found: 0, approved: 1, applied: 2, screening: 3, interviewing: 4, offer: 5 };
export const EMAIL_TARGETS: Stage[] = ["applied", "screening", "interviewing", "offer", "closed"];

/**
 * The stage an email moves an application to, or null to leave it. An email only ever moves an application forward
 * (never to approved, which is yours alone), and closes it only for a rejection. `requested` is the agent's or your
 * call; without it, the kind decides. Returns an error string for a move that isn't allowed.
 */
export function emailStageMove(current: Stage, kind: EmailKind, requested?: Stage | null): { to: Stage | null } | { error: string } {
  if (current === "closed") return requested && requested !== "closed" ? { error: "the application is closed" } : { to: null };
  const now = ORDER[current]!;
  if (requested) {
    if (!EMAIL_TARGETS.includes(requested)) return { error: `an email can't move an application to "${requested}"` };
    if (requested === "closed") return kind === "rejection" ? { to: "closed" } : { error: 'only a rejection closes an application (kind "rejection")' };
    if (ORDER[requested]! < now) return { error: `"${current}" is already past "${requested}"; an email only moves an application forward` };
    return { to: ORDER[requested]! > now ? requested : null };
  }
  if (kind === "rejection") return { to: "closed" };
  const target: Stage | null =
    kind === "offer" ? "offer" : kind === "interview" ? "screening" : kind === "other" ? null : "applied";
  return { to: target && ORDER[target]! > now ? target : null };
}
