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
  "paradox.ai", "criteriacorp.com", "shl.com", "testgorilla.com", "sparkhire.com", "harver.com", "yello.co",
];

/** Tools whose mail is an assessment or a recorded interview to complete. */
const ASSESSMENT_DOMAINS = ["hackerrank.com", "hackerrankforwork.com", "codesignal.com", "codility.com", "hirevue.com", "modernhire.com", "vidcruiter.com", "karat.io", "karat.com", "criteriacorp.com", "shl.com", "testgorilla.com", "sparkhire.com", "harver.com"];

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

const wholeSentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/);
/** The clauses of a sentence that turn on "but", a semicolon or a dash. */
const clauses = (sentence: string) =>
  sentence
    .split(/\s*;\s*|,?\s+but\s+|\s+[—–]\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
/** Sentences, split into clauses. */
const sentences = (text: string) => wholeSentences(text).flatMap(clauses);

// An "if" or "should" that asks rather than supposes: "let me know if you're available", "if you're still interested,
// could you send some times?", "should you need to reschedule, reply here". Taken out before looking for a hypothetical.
const ASKING_IF =
  /(?<=\blet (?:me|us) know |\b(?:wondering|curious) )(?:if|whether)\b|\bif(?= (?:you're|you are|you'd be|you would be|you remain) (?:still )?(?:interested|available|open|free)\b)|\bif(?= (?:that|this|it|either|any of (?:these|those|them)|one of (?:these|those|them))(?: \w+)? works?\b)|\bshould(?= you (?:need|wish|want|require|prefer)\b)|\bif(?= (?:needed|possible|so)\b)/gi;
// A clause about what might happen rather than what has: "If selected, we'll reach out to schedule an interview", "You
// may be asked to complete an assessment", "Once your application has been submitted…". "May" mid-sentence with a
// capital is the month.
const HYPOTHETICAL = /\b(?:if|once|whether|unless|until|in the event|in case)\b|\bshould (?:you|we|your|there|it|the|any)\b|^(?:may|might) (?:we|you|i)\b/i;
const MODAL = /\b(?:may|might)\b/;
const hypothetical = (s: string) => {
  const t = s.replace(ASKING_IF, "");
  return HYPOTHETICAL.test(t) || MODAL.test(t);
};

// About candidates in general: "We'll contact qualified candidates to schedule interviews", "Applicants who are not
// selected will be notified". "Other candidates who…" is about the ones chosen instead of you.
const GENERAL_PEOPLE = /\b(?:qualified|selected|shortlisted|successful|top|all) (?:candidates|applicants)\b|(?<!\b(?:other|another) |\b(?:proceed|continue|go) with )\b(?:candidates|applicants|those|individuals|anyone|everyone)\b(?: \w+){0,3}? (?:who|whose|that|not|selected)\b/i;
const GENERAL = new RegExp(`${GENERAL_PEOPLE.source}|\\b(?:our|the) (?:interview|hiring|recruiting|selection|application) process\\b`, "i");
// Thanks for something already done: "Thanks for speaking with me on our call last week", "Thank you for completing the
// HireVue interview". It asks for nothing now.
const PAST = /\bthank(?:s| you)(?: so much| again)? for (?:\w+ ){0,2}?(?:speaking|meeting|talking|chatting|taking|completing|interviewing|participating|attending|joining|connecting|sharing|submitting|finishing|your time)\b/i;

// Said to you, whatever else the sentence mentions: "As the next step in our hiring process, we would like to invite
// you to an interview", "You've been selected as one of the top candidates".
const TO_YOU =
  /\b(?:we|i)(?:'d| would) (?:like|love) (?:to (?:invite|bring|meet|speak|talk|chat|connect|learn|get to know|hear from|schedule|set up|arrange|move|have you|see you|discuss)|for you)\b|\b(?:invite|inviting) you\b|\byou(?:'ve| have)? been (?:selected|shortlisted|invited)\b|\bone of (?:the|our) (?:top|selected|shortlisted)\b|\blet (?:me|us) know (?:when|what|which|a |your|how)\b|\b(?:please|kindly) (?:answer|send|upload|submit|provide|attach|fill (?:out|in))\b|\b(?:hop|jump) on (?:a|the) (?:quick )?(?:phone|call)\b|\b(?:progressed|advanced|moved (?:on|forward)) to the next\b|\bwants? to (?:set up|meet|speak|talk|chat)\b|\bto (?:arrange|schedule|book|set up) a time\b/i;
const general = (s: string) => GENERAL.test(s) && !TO_YOU.test(s);

const anyIn = (res: RegExp[], text: string) => res.some((re) => re.test(text));
/**
 * Some clause that isn't hypothetical says one of these. With `ask`, the clause must also be about you now: not about
 * candidates in general, and not thanks for something already done.
 */
const says = (res: RegExp[], text: string, ask = false) =>
  sentences(text).some((s) => !hypothetical(s) && !(ask && (general(s) || PAST.test(s))) && anyIn(res, s));

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
  /\b(?:won't|will not|wouldn't|would not|can't|cannot|are unable to|unable to|not able to) (?:be )?(?:able to )?(?:mov(?:e|ing) forward|proceed(?:ing)?(?: further)? with (?:your|the) (?:application|candidacy)|advanc(?:e|ing) (?:you|your)|offer(?:ing)? you (?:the|this|a|an) (?:position|role|job)|progress(?:ing)? (?:with )?your (?:application|candidacy)|pursu(?:e|ing) your|(?:make|extend)(?:ing)? (?:you )?an offer)/i,
  /\bdecided (?:not to (?:move|proceed|pursue|advance|progress)|to (?:move|proceed|go) (?:forward )?with (?:other|another|a different) (?:candidates?|applicants?|individuals?|persons?|people|profiles?)|to pursue (?:other|another) (?:candidates?|applicants?)|to go (?:in|with) a different direction)/i,
  /\bpursue other candidates\b/i,
  /\b(?:move|moving|proceed|proceeding|go|going) forward with (?:other|another) (?:candidates?|applicants?)\b/i,
  /\b(?:selected|chosen|chose|hired|identified) (?:an? |the )?(?:other |another |a different |more qualified )?(?:candidates?|applicants?|individual|person) (?:whose|who|that)\b/i,
  /\b(?:have|has|had|were|was) not been selected\b|\b(?:were|was) not selected\b/i,
  /\b(?:position|role|job|opening|requisition) (?:has|have) (?:now )?been (?:filled|closed|cancel+ed)\b/i,
  /\bno longer (?:be )?(?:considering|under consideration|being considered|in consideration)\b/i,
  /\b(?:application|candidacy) (?:was|has been|is) (?:declined|rejected|unsuccessful)\b|\bwere unsuccessful\b/i,
  /\bdecline your application\b/i,
  /\b(?:go|going) (?:in|with) a different direction\b/i,
  /\b(?:selected|chosen|hired|offered (?:the|this) (?:position|role|job) to|offered to) (?:another|a different|other) (?:candidates?|applicants?|individuals?|person)\b/i,
  /\bmov(?:e|ing) (?:ahead|on) with (?:other|another|a different) (?:candidates?|applicants?)\b/i,
  /\b(?:decided|chosen|chose|elected) to (?:proceed|continue|go) with (?:other |another )?(?:candidates?|applicants?)\b/i,
  /\b(?:has|have) not been (?:shortlisted|successful)\b/i,
  /\b(?:not|won't|will not|unable to) (?:be )?(?:inviting|invite) you (?:to|for) (?:an? )?interview\b/i,
  /\b(?:unable to|not able to|won't|will not|can't|cannot) (?:be )?(?:take|taking) your (?:application|candidacy) (?:any )?(?:forward|further)\b/i,
];
// A rejection is said to you, or as a decision: "your application", "we have decided", "unfortunately, the team…".
// "Applicants who were not selected will be notified" is neither.
const ADDRESSED = /\b(?:you|your|yours|we|us|our|unfortunately|regret|regrettably|sadly)\b|\b(?:has|have|had) (?:decided|chosen|made)\b/i;
const YOU = /\b(?:you|your|yours)\b/i;
// "We cannot proceed with your application without your transcript" asks for a document; it isn't a decision.
const rejects = (text: string) =>
  wholeSentences(text).some(
    (sentence) =>
      ADDRESSED.test(sentence) &&
      clauses(sentence).some((s) => !hypothetical(s) && !/\bwithout\b/i.test(s) && !(GENERAL_PEOPLE.test(s) && !YOU.test(s)) && anyIn(REJECTION, s)),
  );
// The search paused or moved, with you still in it: "won't be moving forward with interviews this quarter (budget
// freeze); your application remains active". A rejection that says so is only a guess.
const STILL_OPEN =
  /\b(?:on hold|(?:hiring|budget) freeze|(?:application|candidacy) (?:is still|stays) (?:active|open|under (?:review|consideration))|remains (?:active|open|under (?:review|consideration))|keep(?:ing)? your (?:application|candidacy) (?:active|open) for the|(?:hiring|the (?:role|search|position)) (?:resumes|reopens|re-opens)|forward with scheduling)\b/i;

const OFFER = [
  /\boffer letter\b/i,
  /\b(?:pleased|happy|excited|delighted|thrilled) to (?:extend|offer) you\b/i,
  /\b(?:formal|verbal|written) offer\b/i,
  /\boffer of employment\b/i,
  /\bextend(?:ing)? (?:you )?an offer\b/i,
  /\bmake you an offer\b/i,
  /\b(?:review|accept|sign)(?: and (?:accept|sign))? (?:your|the) (?:job |employment )?offer\b/i,
];

const ASSESSMENT = [
  /\b(?:online|technical|skills?|coding|cognitive|personality|video|pre-employment|aptitude|behavioral|psychometric) (?:assessment|test|evaluation)\b|\bassessment (?:link|invitation|invite)\b/i,
  /\bcomplete (?:the|this|your|an?) (?:\w+ ){0,3}?(?:assessment|test|questionnaire|exercise|challenge|video interview)\b/i,
  /\bcoding (?:challenge|exercise|test)\b/i,
  /\btake[- ]home (?:assignment|exercise|test|challenge|project|case|task)\b/i,
  /\b(?:hackerrank|codesignal|codility|hirevue|karat|vidcruiter|spark ?hire|testgorilla|criteria corp|ccat|wonderlic|pymetrics|harver|willo)\b/i,
  /\bonline (?:test|exercise)\b/i,
  /\bcase study (?:assignment|exercise|presentation|interview|prompt|task)\b/i,
  /\b(?:record|submit) (?:a |your )?(?:short |brief )?(?:one[- ]way )?video\b|\bone[- ]way video\b|\bvideo (?:introduction|response)\b/i,
];
// Mail from an assessment tool is a test to take, unless it's the receipt for one you took.
const TOOK_IT = /\bthank(?:s| you)(?: so much)? for (?:completing|taking|submitting|finishing)\b|\byou(?:'ve| have)? (?:completed|submitted|finished)\b|\bhas been (?:completed|submitted|received)\b/i;

const INTERVIEW = [
  /\b(?:interview|screening|phone screen) (?:invitation|invite|request|scheduled|scheduling|confirmation|confirmed|details)\b/i,
  /\binvit(?:e|ing|ation)\b.{0,40}\b(?:interview|next round|video interview|onsite|on-site|final round)\b/i,
  /\b(?:would|'d) (?:like|love) to (?:schedule|set up|arrange)\b.{0,30}\b(?:interview|call|chat|conversation)\b/i,
  /\b(?:like|love|want) to (?:speak|chat|talk|connect|schedule|invite|meet|move forward|interview you)\b/i,
  /\byour (?:\w+ ){0,6}?interview\b.{0,60}?\b(?:is|has been) (?:scheduled|confirmed|booked|set)\b/i,
  /\bmodernloop\.io\b|\bparadox\.ai\b|\bcalendly\.com\b|\bgoodtime\.io\b/i,
  /\bschedule (?:a|an|your|the|some) (?:time|call|chat|interview|conversation|phone|video|zoom|meeting|screen)/i,
  /\b(?:your|share your|send (?:me|us) your|provide your|let (?:me|us) know your) (?:interview )?availability\b/i,
  /\b(?:are|were) you (?:available|free|open) (?:for|to|on|this|next|tomorrow)\b|\byou(?:'re| are) (?:available|free) (?:for|to|on|this|next|tomorrow)\b/i,
  /\bset up (?:a |some )?(?:time|call|chat|meeting|interview)\b/i,
  /\b(?:book|pick|select|choose) (?:a |your )?(?:time|slot|interview time)\b/i,
  /\b(?:find|grab|have|get) (?:\d+|a few|some) (?:minutes|mins)\b/i,
  /\b\d+[- ]?min(?:ute)?s?\b.{0,20}\b(?:call|chat|conversation|interview|meeting|screen|zoom|video)\b/i,
  /\bworks? for you\b|\bwhat (?:times?|days?) (?:work|would work|are good|suit)\b|\btimes? that (?:work|suit)s?\b/i,
  /\b(?:hop|jump) on (?:a|the) (?:quick )?(?:phone|call)\b|\b(?:like|love|want)s? to (?:bring you in|have you (?:in|back|come in)|set up a conversation)\b|\b(?:first|1st)[- ]round\b|\bsuperday\b|\b(?:selected|shortlisted) for (?:an? |the )?(?:next|first|final|interview|conversation)|\b(?:do|would) you have (?:some |any )?time (?:for|to|this|next|on)\b|\bwould you be (?:available|free) (?:for|to|on|this|next|tomorrow)\b|\bquick (?:call|chat|phone call)\b/i,
  /\b(?:does|would|will) (?:monday|tuesday|wednesday|thursday|friday|tomorrow|next week|this week)\b.{0,40}\bwork\b/i,
  /\b(?:phone|recruiter|initial|intro|introductory|screening) (?:screen|call|conversation|interview|chat)\b/i,
  /\binvite you (?:to|for) (?:an? |the )?(?:interview|call|chat|conversation|phone screen|next round|onsite|virtual)/i,
  /\bnext (?:step|round)s? (?:in|of) (?:the|our) (?:process|interview)/i,
  /\bmove (?:you )?forward (?:to|in|with) (?:the next|the interview)/i,
  /\b(?:like|love|happy|pleased|excited) to move (?:you|your application|your candidacy) forward\b/i,
  /\b(?:final|next|second|third|onsite|on-site|panel) (?:round|interview)\b/i,
];

// What turns "unable to proceed with Tuesday's interview" into a reschedule rather than a rejection: a request of you
// now. A mention of an interview you've already had isn't one.
const REQUEST = [
  /\b(?:share|send|provide) (?:me |us )?(?:your |some )?(?:interview )?(?:availability|times)\b|\blet (?:me|us) know (?:your )?(?:availability|what times?)\b/i,
  /\b(?:are|were) you (?:available|free|open)\b|\byou(?:'re| are) (?:available|free) (?:for|to|on)\b/i,
  /\b(?:would|'d) (?:like|love) to (?:schedule|set up|arrange|invite|speak|chat|talk|meet|interview|move (?:you )?forward|offer|extend)\b/i,
  /\binvite you (?:to|for)\b/i,
  /\b(?:please|kindly) (?:complete|take|finish|schedule|book|select|choose|pick|confirm|sign|record|review and (?:sign|accept))\b/i,
  /\b(?:schedule|set up|arrange|book|find|grab|pick|select|choose) (?:a|an|some|your|the) (?:new )?(?:time|call|chat|interview|conversation|meeting|screen|slot)\b/i,
  /\breschedul/i,
  /\bworks? for you\b|\bwhat (?:times?|days?) (?:work|would work|are good)\b|\btimes? that works?\b/i,
  // A slot that fell through: "unable to move forward with tomorrow's phone screen as planned; I'll send a new date".
  /\b(?:new|another|different) (?:date|time|day)s?\b|\bpostpon\w*|\bas (?:planned|scheduled)\b/i,
];

// Words that point at a request the phrasings above don't know: "The next step is an assessment", "log in to review
// your offer".
const POINTS_TO: [EmailKind, RegExp][] = [
  ["offer", /\b(?:an|the|your|this) offer\b(?! of)|\boffer (?:details|package|call)\b/i],
  ["assessment", /\bassessment\b|\b(?:test|questionnaire)\b/i],
  ["interview", /\b(?:an|your|the|a|next|first|final|phone|video|onsite|virtual|in-person) interview\b(?! process)|\bphone screen\b|\bnext round\b|\byour availability\b/i],
];

const CONFIRMATION = [
  /\b(?:we've|we have|we) (?:successfully )?received your (?:resume|submission)\b/i,
  /\bapplication (?:confirmation|acknowledg(?:e)?ment)\b/i,
  /\bhas your application\b/i,
  /\bsubmitted successfully\b/i,
  /\bthank(?:s| you) for completing your application\b/i,
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

// Joining a talent community or setting up a job alert, which names the job but isn't applying to it.
const NOT_APPLIED = /\bthank(?:s| you) for (?:joining|signing up|subscribing|submitting your (?:information|profile|job alert))\b|\bwelcome to (?:our|the) (?:[\w&'-]+ )?talent (?:community|network|pool)\b|\bjob alert\b/i;

// Rejections open this way too, so on its own it's a guess, not a confirmation.
const WEAK_CONFIRMATION = [/\bthank(?:s| you) for (?:your )?interest in\b/i];

const UPDATE = [
  /\b(?:application|candidacy) (?:status|update)\b/i,
  /\bstatus of your (?:application|candidacy)\b/i,
  /\byour (?:job )?(?:application|candidacy|profile|resume|submission)\b.{0,40}\b(?:under (?:review|consideration)|being reviewed|in review|(?:was|has been) (?:viewed|reviewed|forwarded|shared))\b/i,
  /\bstill (?:reviewing|considering) (?:your|applications|candidates)\b/i,
  /\bupdate (?:on|to) your (?:application|candidacy)\b/i,
  /\bstatus (?:has )?(?:changed|been updated)\b/i,
];
// "There's an update to your application. Log in to your Candidate Home to view it": the news itself is in the portal.
const PORTAL = /\b(?:log ?in|sign ?in|logging in|signing in)\b|\bcandidate (?:home|portal|center|centre|dashboard)\b|\bview (?:the|your) (?:status|update|message|details)\b/i;

// What a template acknowledgement has nowhere but its footer: a question, a time, or a request to call, chat, record,
// take a test or fill something in.
const FOOTER = /\b(?:questions?|help|faq|support|contact|unsubscribe|privacy|not you|didn't apply|did not apply|trouble|accommodations?|disabilit\w*|equal (?:employment )?opportunity|eeo|do not reply|don't reply|unattended|not monitored)\b/i;
const SLOT = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/i;
const STAMP = /\b(?:submitted|received|applied|sent|dated?|posted)\b/i;
const NUDGE = /\b(?:call|chat|zoom|video|record|questionnaire|test|minutes?|link below|calendar|schedul\w*|availab\w*|interview\w*|assessment|book|reply (?:to|with)|respond (?:to|with|by)|complete (?:the|this|your|a|an|our))\b|\?$/i;
const quiet = (text: string) =>
  sentences(text).every((s) => hypothetical(s) || (!TO_YOU.test(s) && (GENERAL.test(s) || FOOTER.test(s) || !(NUDGE.test(s) || (SLOT.test(s) && !STAMP.test(s))))));

// A job board passing on a message from someone ("Jane via LinkedIn", "New message from Stripe"): anyone can send one.
const BOARD_MESSAGE = /\b(?:messaged you|new message|sent you a (?:new )?message|inmail|interview (?:request|invitation|invite)|invited you to (?:an? )?interview|wants to (?:interview|schedule)|would like to (?:interview|schedule))\b/i;
// (Indeed relays an employer's own messages from indeedemail.com.)
const relayed = (sender: Sender | undefined, subject: string) =>
  Boolean(sender && jobBoardOf(sender.domain) && (/\bvia\b/i.test(sender.name ?? "") || BOARD_MESSAGE.test(subject) || domainIs(sender.domain, "indeedemail.com")));
// Mailboxes no one writes from by hand.
const TEAM_MAILBOX = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|auto[-_.]?(?:reply|mailer|mated)|mailer|careers?|jobs?|recruit(?:ing|ment|ers?)?|talent(?:[-_.]?acquisition)?|hiring|applications?|apply|hr|people|candidates?|ta)(?:[-_.+]|$)/i;

/**
 * Sent by a system rather than written by a person: an applicant system, a job board's own notice, or a no-reply or
 * team mailbox. Only its acknowledgements are recorded on their own: a person's "thanks for applying" may go on to ask
 * for a call in words no pattern knows.
 */
export function systemSender(sender: Sender | undefined, subject = ""): boolean {
  if (!sender?.domain) return false;
  if (atsOf(sender.domain)) return true;
  if (jobBoardOf(sender.domain)) return !relayed(sender, plain(subject));
  return TEAM_MAILBOX.test(sender.address?.split("@")[0] ?? "");
}

export type Classification = { kind: EmailKind; confident: boolean };

/**
 * What the email says. Only rejections, and confirmations and status updates sent by a system that ask for nothing,
 * are `confident`: the app records those on its own. Interviews, assessments, offers and anything else are a guess for
 * the agent or you to check.
 */
export function classify(subject: string | null | undefined, body: string | null | undefined, sender?: Sender): Classification {
  const text = `${plain(subject)}\n${plain(body)}`;
  const offer = says(OFFER, text, true);
  const tool = ASSESSMENT_DOMAINS.some((d) => domainIs(sender?.domain ?? null, d));
  const assessment = (tool && !TOOK_IT.test(text)) || says(ASSESSMENT, text, true);
  const interview = says(INTERVIEW, text, true);
  // A rejection that asks for nothing is certain. One that also asks to talk, test or sign is a reschedule or offer
  // paperwork ("unable to proceed with Tuesday's interview; could you share your availability?").
  if (rejects(text) && !offer && !says(REQUEST, text, true)) return { kind: "rejection", confident: !STILL_OPEN.test(text) };
  if (offer) return { kind: "offer", confident: false };
  if (assessment) return { kind: "assessment", confident: false };
  if (interview) return { kind: "interview", confident: false };
  const pointed = POINTS_TO.find(([, re]) => says([re], text, true));
  if (pointed) return { kind: pointed[0], confident: false };
  const template = systemSender(sender, subject ?? "") && quiet(text);
  if (says(CONFIRMATION, text)) return { kind: "confirmation", confident: template && !NOT_APPLIED.test(text) };
  if (anyIn(WEAK_CONFIRMATION, text)) return { kind: "confirmation", confident: false };
  if (says(UPDATE, text)) return { kind: "update", confident: template && !PORTAL.test(text) };
  return { kind: "other", confident: false };
}

/** The email asks to talk, to take a test or to sign: worth keeping even when it doesn't say "application". */
export function asksSomething(subject: string | null | undefined, body: string | null | undefined) {
  const text = `${plain(subject)}\n${plain(body)}`;
  return says(INTERVIEW, text, true) || says(ASSESSMENT, text, true) || says(OFFER, text, true);
}

// ---------- Which application ----------

export type Candidate = { id: number; stage: Stage; company: string; title: string; domains: string[] };
export type Match = { applicationId: number | null; matchedBy: "title" | "company" | null; candidateIds: number[] };
/**
 * What matchEmail saw on the way: the company named anywhere; named by the sender or subject; named so by a
 * company with an application in flight; a job title named; and whether the sender's address can be trusted for
 * the match (an applicant system, a job board, or the company's own domain), rather than only a display name or
 * subject, which anyone can type.
 */
export type Seen = { companyNamed: boolean; senderNamed: boolean; senderNamedLive: boolean; titleNamed: boolean; trusted: boolean };

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

type CompanyHit = "domain" | "name" | "body" | null;

/**
 * Where the email names the company: by the sender's address ("domain": the company's own domain, or its tenant
 * at an applicant system), by the sender's display name or the subject ("name", which anyone can type), or only in
 * the body. The body is matched case-sensitively, so "Block" the company isn't "block your calendar".
 */
function companyHit(c: Candidate, sender: Sender, subject: string, body: string): CompanyHit {
  // What an applicant system or job board sends about other employers isn't about it as an employer: LinkedIn's "your
  // application was sent to Plaid" isn't about your LinkedIn application, nor Oracle Recruiting Cloud mail from
  // JPMorgan about your Oracle one.
  const vendor = (atsOf(sender.domain) ?? jobBoardOf(sender.domain))?.split(".").slice(0, -1) ?? [];
  const aliases = companyAliases(c.company).filter((a) => !vendor.some((l) => l === slug(a) || (slug(a).length >= 5 && l.includes(slug(a)))));
  if (!aliases.length) return null;
  if (sender.domain && c.domains.some((d) => domainIs(sender.domain, d))) return "domain";
  // Workday sends from <company>@myworkday.com, iCIMS from <company>+autoreply@talent.icims.com, Jobvite and
  // Teamtailor from a company subdomain (jobvite.nutanix.com, acme.teamtailor-mail.com).
  const ats = Boolean(atsOf(sender.domain));
  const local = ats ? slug(sender.address?.split("@")[0]?.split("+")[0] ?? "") : "";
  // At an applicant system any label can be the tenant (acme.teamtailor-mail.com). Elsewhere only the registrable one
  // counts, and only under .com or a country's .co.uk-style suffix (the company's own domain is matched above): so
  // mail.visa.com is Visa, and visa.example-mailer.com, ramp.network and stripe.careers aren't.
  const parts = (sender.domain ?? "").split(".");
  const n = parts.length >= 3 && /^(?:co|com|org|net|gov|ac)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  const labels = jobBoardOf(sender.domain) ? [] : ats ? parts : parts[parts.length - 1] === "com" || n === 3 ? parts.slice(-n, -n + 1) : [];
  if (aliases.some((a) => slug(a).length >= 4 && (local === slug(a) || labels.includes(slug(a))))) return "domain";
  if (aliases.some((a) => (sender.name && wordRe(a, "i").test(sender.name)) || wordRe(a).test(subject))) return "name";
  if (aliases.some((a) => wordRe(a).test(body))) return "body";
  return null;
}

const TITLE_STOP = new Set(["and", "of", "the", "for", "to", "in", "at", "an", "with", "on", "remote", "hybrid", "onsite", "us", "usa", "ii", "iii", "iv", "job", "role", "position", "full", "time"]);

/**
 * Lowercase words, with "|" where punctuation ends a phrase and "," for a comma or spaced dash, which may join a title's
 * parts or end it: "Sr. Analyst, Treasury (Remote)" → senior analyst , treasury |.
 */
function titleTokens(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/\([^)]*\)/g, " | ")
    .replace(/&/g, " and ")
    .replace(/\bsr\b\.?/g, "senior")
    .replace(/\bjr\b\.?/g, "junior")
    .replace(/\bmgr\b\.?/g, "manager")
    .replace(/\s*,\s*|\s[-–—]+\s/g, " , ")
    .replace(/[;:!?|/[\]"“”()]+|\.(?=\s|$)|\n/g, " | ")
    .replace(/[^a-z0-9|,]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
const titleWords = (t: string) => titleTokens(t).filter((w) => w !== "|" && w !== "," && w.length >= 2 && !TITLE_STOP.has(w));

// Words that may stand right before or after a job title without making it a different one: "for the ___ role",
// "Application: ___", "___ at Stripe". "Senior" before or "Sales" after it does ("Senior ___", "___ Sales").
const TITLE_BEFORE = new Set(["the", "a", "an", "our", "your", "my", "this", "that", "for", "as", "to", "of", "in", "at", "on", "with", "about", "regarding", "re", "fwd", "fw", "position", "role", "job", "opening", "opportunity", "title", "application", "applying", "applied", "interview", "interviewing", "req", "requisition", "s", "is", "was", "new", "open", "into", "candidate", "candidacy", "from", "by", "update", "status", "offer", "assessment", "screen", "remote", "hybrid", "onsite", "contract", "time"]);
const TITLE_AFTER = new Set(["role", "roles", "position", "positions", "job", "opening", "opportunity", "posting", "vacancy", "req", "requisition", "at", "with", "in", "for", "on", "and", "or", "has", "have", "was", "were", "is", "are", "will", "would", "we", "you", "your", "our", "the", "a", "an", "to", "from", "by", "which", "that", "this", "here", "there", "it", "if", "but", "so", "as", "i", "my", "me", "us", "please", "thank", "thanks", "application", "applied", "interview", "interviews", "candidacy", "hi", "hello", "dear", "remote", "hybrid", "onsite", "located", "based", "via", "posted", "id", "team", "reference", "ref"]);
const boundary = (w: string | undefined, allowed: Set<string>) => w === undefined || w === "|" || allowed.has(w) || /\d/.test(w);
// What may follow a title after a comma or dash without making it a longer one: a place or a kind of contract
// ("___, Remote", "___ - San Francisco"), the company, or a req number. "___, Payments" is another job.
const PLACE = new Set(["remote", "hybrid", "onsite", "on", "in", "office", "us", "usa", "united", "new", "san", "los", "nyc", "sf", "la", "uk", "london", "seattle", "austin", "boston", "chicago", "denver", "atlanta", "toronto", "dallas", "miami", "washington", "dc", "ny", "ca", "tx", "wa", "ma", "il", "ga", "emea", "apac", "americas", "north", "south", "east", "west", "central", "bay", "global", "canada", "europe", "india", "multiple", "various", "nationwide", "virtual", "full", "part", "contract", "temporary", "permanent"]);

/** The title as written, standing on its own: not inside a longer title ("Senior ___", "___ Sales", "___, Payments"). */
function standsAlone(text: string[], title: string[], company: Set<string>): boolean {
  if (!title.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== title[0]) continue;
    let j = i;
    let k = 0;
    while (j < text.length && k < title.length) {
      if (text[j] === "|" || text[j] === ",") {
        j++;
        continue;
      }
      if (text[j] !== title[k]) break;
      j++;
      k++;
    }
    if (k < title.length || !boundary(text[i - 1] === "," ? "|" : text[i - 1], TITLE_BEFORE)) continue;
    const after = text[j] === "," ? boundary(text[j + 1], TITLE_AFTER) || PLACE.has(text[j + 1]) || company.has(text[j + 1]) : boundary(text[j], TITLE_AFTER);
    if (after) return true;
  }
  return false;
}

// "We encourage you to look at other openings such as our ___ role": a title named as some other job.
const OTHER_OPENINGS = /\b(?:other|similar|more|additional|related|future|open|new) (?:openings|roles|positions|opportunities|jobs|vacancies)\b|\bsuch as\b|\bcareers? (?:page|site)\b|\bjobs? (?:you may|we think|for you|picked)\b|\brecommended\b|\byou (?:may|might) (?:also )?(?:like|be interested)\b/i;

/**
 * "exact" when the subject or the top of the email names the title as written and on its own; "words" when it has
 * nearly all of the title's words in some order ("Manager, Strategic Finance", or "Senior Strategic Finance Manager"),
 * which is only a suggestion.
 */
function titleHit(title: string, subject: string, body: string, company: string[] = []): "exact" | "words" | null {
  // Only the email's own words: not the earlier messages quoted under a reply, nor the lines listed under "Other open
  // roles that may be a fit:".
  const own = body.split(/\n\s*(?:>|On [^\n]{0,200}wrote:|-{2,}\s*(?:Original|Forwarded) Message|From: )/)[0];
  const top: string[] = [];
  let listing = false;
  for (const s of sentences(own.slice(0, 1200))) {
    if (OTHER_OPENINGS.test(s)) listing = /:$/.test(s);
    else if (!listing || /[.!?]$/.test(s)) {
      listing = false;
      top.push(s);
    }
  }
  const text = titleTokens(`${subject}\n${top.join("\n")}`);
  const t = titleTokens(title).filter((w) => w !== "|" && w !== ",");
  const names = new Set(company.map((a) => titleTokens(a)[0]).filter(Boolean));
  if (t.join(" ").length >= 4 && standsAlone(text, t, names)) return "exact";
  // Two words ("Product Manager") show up in too many emails to count without the title as written.
  const words = titleWords(title);
  if (words.length < 3) return null;
  const have = new Set(text);
  return words.filter((w) => have.has(w)).length / words.length >= 0.8 ? "words" : null;
}

/**
 * Which application an email is about. The company has to be named by the sender or in the subject (a company named
 * only in the body is someone else's email mentioning it). Then the title as written wins; failing that, a title
 * reworded, or an email from a company with exactly one application in flight, is probably that one (matchedBy
 * "company", which the app only suggests). Anything else is left for the agent or you, with the applications it could
 * be about.
 */
// "Stripe", "Stripe Recruiting", "LMI @ icims": an applicant system's display name that is the company. "H&R Block" isn't
// Block, nor "Square Enix" Square.
const TEAM_TAIL = /\s*(?:@|\bvia\b).*$|(?:\s+(?:university |campus )?(?:recruiting|recruitment|careers?|talent(?: acquisition)?|hiring(?: team)?|jobs|hr|people|team))+$/i;
const tenant = (name: string | null, c: Candidate) => {
  const own = new Set(companyAliases(c.company).map((a) => a.toLowerCase()));
  return companyAliases((name ?? "").replace(TEAM_TAIL, "").trim()).some((a) => own.has(a.toLowerCase()));
};

export function matchEmail(e: { sender: Sender; subject: string; body: string }, candidates: Candidate[]): Match & Seen {
  const subject = plain(e.subject);
  const body = plain(e.body);
  const hits = candidates.map((c) => ({ c, co: companyHit(c, e.sender, subject, body) })).filter((h) => h.co);
  const titledAll = hits.map((h) => ({ ...h, t: titleHit(h.c.title, subject, body, companyAliases(h.c.company)) })).filter((h) => h.t);
  const bySender = (h: { co: CompanyHit }) => h.co === "domain" || h.co === "name";
  const titled = titledAll.filter(bySender);
  const live = (h: { c: Candidate }) => LIVE_STAGES.includes(h.c.stage);
  // Suggestions: named by the sender before named only in the body, in flight before found, titled first.
  const ranked = [...new Set([...titledAll, ...hits].sort((a, b) => Number(bySender(b)) - Number(bySender(a)) || Number(live(b)) - Number(live(a))).map((h) => h.c.id))].slice(0, 8);
  // An applicant system, or a job board's own notice (not a message it passes on), vouches for the company it names.
  const fromSystem = Boolean(atsOf(e.sender.domain)) || (Boolean(jobBoardOf(e.sender.domain)) && !relayed(e.sender, subject));
  const out = (applicationId: number | null, matchedBy: Match["matchedBy"], ids: number[]) => ({
    applicationId,
    matchedBy,
    candidateIds: applicationId ? [] : ids,
    companyNamed: hits.length > 0,
    senderNamed: hits.some(bySender),
    senderNamedLive: hits.some((h) => bySender(h) && live(h)),
    titleNamed: titledAll.length > 0,
    trusted: applicationId
      ? hits.some((h) => h.c.id === applicationId && (h.co === "domain" || (h.co === "name" && (atsOf(e.sender.domain) ? tenant(e.sender.name, h.c) : fromSystem))))
      : fromSystem,
  });

  const pick = (pool: typeof titled, by: Match["matchedBy"]) => {
    if (pool.length === 1) return out(pool[0].c.id, by, []);
    const inFlight = pool.filter(live);
    return inFlight.length === 1 ? out(inFlight[0].c.id, by, []) : out(null, null, pool.map((h) => h.c.id));
  };
  const exact = titled.filter((h) => h.t === "exact");
  if (exact.length) return pick(exact, "title");
  // Nearly all of a title's words, reordered or inside a longer title ("Senior ___"): only a suggestion.
  if (titled.length) return pick(titled, "company");
  const named = hits.filter((h) => bySender(h) && live(h));
  if (named.length === 1) return out(named[0].c.id, "company", []);
  return out(null, null, ranked);
}

// ---------- Is it about the job search at all ----------

const RECRUITER_SENDER = /recruit|talent|career|hiring|\bjobs?\b|people ?(?:team|ops)|human resources|\bhr\b|staffing|acquisition/i;
const APP_PHRASE = /\b(?:your (?:job )?application|applying (?:for|to)|applied (?:for|to)|you applied|candidacy|interview|your (?:recent )?submission)\b/i;
// Mail for someone who interviews candidates (a hiring panel at your current job), not for a candidate.
const INTERVIEWER_SIDE = /\b(?:scorecard|interview kit|submit (?:your )?(?:interview )?feedback|as an interviewer|interview(?:ing)? (?:a|the|this|your) candidate|availability to interview)\b/i;
const BOARD_APPLICATION_SUBJECT = /\byour application\b|\bapplication (?:was |has been )?(?:sent|submitted|received|viewed)\b|\byou applied\b|\bapplied (?:to|for)\b|\bapplication (?:status|update)\b|^indeed application:/i;
// Job alerts and digests, which name lots of companies.
const DIGEST = /\band \d+ more (?:jobs?|companies)\b|\bjobs? you (?:may|might) (?:like|be interested in)\b|\bjob alert\b|\b\d+ new jobs?\b|\bnew jobs? (?:for|near|matching)\b|\bjobs? (?:for|near) you\b|\brecommended (?:jobs?|for you)\b|\b(?:is|are) hiring\b/i;
// A half-finished application or a saved job: nothing has been submitted.
const REMINDER = /\b(?:haven't|have not|not yet) (?:been )?submitted\b|\bstarted (?:an|your) application\b|\b(?:finish|complete|resume|continue) (?:completing |filling out )?your application\b|\byou saved\b|\bsaved (?:job|jobs|this job|role|position)\b|\bincomplete application\b|\bapplication is incomplete\b|\bpick up where you left off\b|\bdraft application\b/i;
// Words a recruiter's email has somewhere; a bank's "schedule a call with an advisor" doesn't.
const JOB_WORDS = /\b(?:role|position|job|opening|opportunit(?:y|ies)|candidate|candidacy|recruit\w*|hiring|interview\w*|resume|cv|your background|your experience|requisition|(?:final|next|first|second|third|onsite|on-site|panel) (?:round|interview|step)s?|next steps?|offer letter)\b/i;
// Applying for a card, a loan or a lease, and mail sent to a list.
const PRODUCT = /\b(?:credit|debit|gold|platinum|rewards|business|secured|store) card\b|\bcard (?:application|account|member\w*)\b|\b(?:credit|lease|rental|apartment|insurance|membership|account) application\b|\b(?:loans?|mortgage|credit (?:line|limit|score|report)|refinanc\w*)\b|\byour (?:order|lease|policy|claim|refund|card|statement)\b/i;
const NEWSLETTER = /\bunsubscribe\b|\bemail preferences\b|\bmanage (?:your )?(?:subscriptions?|preferences)\b|\bview (?:this email )?in (?:your )?browser\b/i;

/**
 * Whether an email is about the job search: from an applicant tracking system, a job board's application notice or a
 * message passed on from an employer, or a recruiter or a company Lodestar knows writing about an application or a
 * job. Reminders to finish an application, and bank, shopping and newsletter mail from the same companies ("your
 * credit card application", "book a time with a specialist"), aren't.
 */
export function isJobEmail(e: { sender: Sender; subject: string; body: string }, m: Seen): boolean {
  const subject = plain(e.subject);
  const text = `${subject}\n${plain(e.body)}`;
  if (ACCOUNT_MAIL.test(subject) || INTERVIEWER_SIDE.test(text)) return false;
  const asks = asksSomething(e.subject, e.body);
  if (REMINDER.test(text) && !asks) return false;
  if (jobBoardOf(e.sender.domain)) {
    if (BOARD_APPLICATION_SUBJECT.test(subject)) return true;
    // "Interview request from Stripe", "Jane just messaged you": an employer writing through the board.
    if (DIGEST.test(text)) return false;
    return m.companyNamed && (BOARD_MESSAGE.test(subject) || /\bvia\b/i.test(e.sender.name ?? "")) ? asks || APP_PHRASE.test(text) || m.titleNamed : m.senderNamed && asks;
  }
  const appPhrase = APP_PHRASE.test(text);
  // The same systems send payslips and benefits mail: only what's about an application of yours counts.
  if (atsOf(e.sender.domain)) return appPhrase || m.titleNamed || (m.senderNamed && asks);
  if (!m.titleNamed && (PRODUCT.test(text) || NEWSLETTER.test(text))) return false;
  const recruiter = RECRUITER_SENDER.test(`${e.sender.name ?? ""} ${e.sender.address ?? ""}`);
  if ((recruiter || m.companyNamed) && appPhrase) return true;
  // Someone at a company you have an application in flight with, asking for a call, a test or a signature in their
  // own words. (Not any company: your own employer may be on the watchlist. And not "book a time with a specialist".)
  if (m.senderNamedLive && asks && (recruiter || m.titleNamed || JOB_WORDS.test(text))) return true;
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
  // A status update moves nothing: "under review" also comes from talent communities and job alerts.
  const target: Stage | null =
    kind === "offer" ? "offer" : kind === "interview" ? "screening" : kind === "confirmation" || kind === "assessment" ? "applied" : null;
  return { to: target && ORDER[target]! > now ? target : null };
}
