// node --import tsx --test lib/*.test.ts   (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, companyAliases, companyDomain, emailStageMove, isJobEmail, matchEmail, parseSender, prefilter, type Candidate } from "./mail-rules";

const sender = parseSender;
// An applicant system's no-reply address: the only kind of sender whose acknowledgements are recorded on their own.
const gh = sender("Stripe <no-reply@us.greenhouse-mail.io>");

test("parseSender reads names, quoted names and bare addresses", () => {
  assert.deepEqual(parseSender("Stripe Recruiting <no-reply@Stripe.com>"), { name: "Stripe Recruiting", address: "no-reply@stripe.com", domain: "stripe.com" });
  assert.deepEqual(parseSender('"Doe, Jane" <jane@x.io>'), { name: "Doe, Jane", address: "jane@x.io", domain: "x.io" });
  assert.deepEqual(parseSender("jobs@workday.com"), { name: null, address: "jobs@workday.com", domain: "workday.com" });
  assert.deepEqual(parseSender(""), { name: null, address: null, domain: null });
});

test("classify: confirmations", () => {
  const c = classify("Thank you for applying to Stripe", "Hi Naren,\nThank you for applying for the Strategic Finance Manager role. We'll review your application and be in touch. If your experience is a match, a recruiter will reach out to schedule an interview.", gh);
  assert.deepEqual(c, { kind: "confirmation", confident: true });
  assert.deepEqual(classify("Naren, your application was sent to Plaid", "Your application was sent to Plaid. Corporate Development Associate.", sender("LinkedIn <jobs-noreply@linkedin.com>")), { kind: "confirmation", confident: true });
  assert.deepEqual(classify("Application received", "We have received your application for Treasury Analyst. Should your background match, we may contact you.", sender("Visa Careers <careers@visa.com>")), { kind: "confirmation", confident: true });
  // The same words from a person are a guess: their next sentence may ask for a call in words no pattern knows.
  assert.deepEqual(classify("Application received", "We have received your application for Treasury Analyst.", sender("Jane Doe <jane@visa.com>")), { kind: "confirmation", confident: false });
});

test("classify: a confirmation that also asks for something is a guess, not recorded on its own", () => {
  const c = classify("Thanks for applying!", "Thanks for applying to Ramp. Please share your availability for a 30 minute call next week.");
  assert.equal(c.kind, "interview");
  assert.equal(c.confident, false);
  const generic = classify("Thank you for your application", "Thank you for your application. Our recruiting team will reach out to schedule interviews.", gh);
  assert.deepEqual(generic, { kind: "confirmation", confident: false });
});

test("classify: rejections", () => {
  for (const body of [
    "Unfortunately, we have decided to move forward with other candidates whose experience more closely matches the role.",
    "After careful consideration we will not be moving forward with your application at this time.",
    "We regret to inform you that the position has been filled.",
    "We've decided not to proceed with your candidacy.",
    "Thank you for your interest in Visa. We have decided to pursue other candidates for this position.",
  ]) {
    assert.deepEqual(classify("Your application to Visa", body), { kind: "rejection", confident: true }, body);
  }
});

test("classify: a hypothetical rejection sentence in a confirmation isn't a rejection", () => {
  const c = classify("Thank you for applying", "Thank you for applying. If we decide not to move forward, we'll let you know by email.");
  assert.equal(c.kind, "confirmation");
});

test("classify: interviews, assessments and offers are guesses", () => {
  assert.deepEqual(classify("Next steps with Ramp", "We'd love to set up a time to chat about the Strategic Finance role. Here's my Calendly: calendly.com/jane"), { kind: "interview", confident: false });
  assert.deepEqual(classify("Interview invitation", "We would like to invite you to an interview for the Treasury Manager position."), { kind: "interview", confident: false });
  assert.deepEqual(classify("Complete your assessment", "Please complete the online assessment within 5 days."), { kind: "assessment", confident: false });
  assert.deepEqual(classify("Invitation", "Hello", sender("HackerRank <support@hackerrankforwork.com>")), { kind: "assessment", confident: false });
  assert.deepEqual(classify("Your offer", "We're thrilled to extend you an offer for the Associate role. Your offer letter is attached."), { kind: "offer", confident: false });
  // "You may be asked to complete an assessment" is about what might happen.
  assert.equal(classify("Application received", "Thank you for applying. You may be asked to complete an assessment.").kind, "confirmation");
});

test("classify: status updates and other", () => {
  assert.deepEqual(classify("Application status update", "Your application is under review.", gh), { kind: "update", confident: true });
  assert.deepEqual(classify("Quick question", "Do you have a portfolio link?"), { kind: "other", confident: false });
});

test("companyAliases splits and trims names", () => {
  assert.deepEqual(companyAliases("Cash App / Block / Square"), ["Cash App", "Block", "Square"]);
  assert.deepEqual(companyAliases("Acme, Inc."), ["Acme, Inc.", "Acme"]);
  assert.deepEqual(companyAliases("The Carlyle Group"), ["The Carlyle Group", "The Carlyle", "Carlyle"]);
});

test("companyDomain takes the company's own domain, not a job board's", () => {
  assert.equal(companyDomain("https://careers.stripe.com/jobs"), "stripe.com");
  assert.equal(companyDomain("https://www.jpmorganchase.com/careers"), "jpmorganchase.com");
  assert.equal(companyDomain("https://boards.greenhouse.io/stripe"), null);
  assert.equal(companyDomain("https://jobs.example.co.uk/x"), "example.co.uk");
  assert.equal(companyDomain("not a url"), null);
});

const cands: Candidate[] = [
  { id: 1, stage: "applied", company: "Stripe", title: "Strategic Finance Manager", domains: ["stripe.com"] },
  { id: 2, stage: "applied", company: "Stripe", title: "Senior Analyst, Treasury", domains: ["stripe.com"] },
  { id: 3, stage: "approved", company: "Plaid", title: "Corporate Development Associate", domains: [] },
  { id: 4, stage: "found", company: "Ramp", title: "Strategic Finance Associate", domains: [] },
  { id: 5, stage: "applied", company: "Cash App / Block / Square", title: "Treasury Manager", domains: ["block.xyz"] },
  { id: 6, stage: "found", company: "JPMorgan Chase", title: "Vice President, Corporate Development", domains: ["jpmorganchase.com"] },
];

test("matchEmail: a title picks one application among several at the company", () => {
  const m = matchEmail({ sender: sender("Stripe <no-reply@greenhouse-mail.io>"), subject: "Thank you for applying to Stripe", body: "Thanks for applying for the Strategic Finance Manager role." }, cands);
  assert.equal(m.applicationId, 1);
  assert.equal(m.matchedBy, "title");
});

test("matchEmail: titles match with words reordered or abbreviated", () => {
  const m = matchEmail({ sender: sender("Stripe Recruiting <recruiting@stripe.com>"), subject: "Your application", body: "Thank you for applying to the Sr. Analyst - Treasury position." }, cands);
  assert.equal(m.applicationId, 2);
});

test("matchEmail: the one application in flight at a company named by the sender", () => {
  const m = matchEmail({ sender: sender("Plaid Talent <talent@plaid.com>"), subject: "An update on your application", body: "We will not be moving forward." }, cands);
  assert.deepEqual([m.applicationId, m.matchedBy], [3, "company"]);
});

test("matchEmail: two applications at the company and no title → left for review with both", () => {
  const m = matchEmail({ sender: sender("Stripe <no-reply@stripe.com>"), subject: "Your application", body: "Unfortunately we won't be moving forward." }, cands);
  assert.equal(m.applicationId, null);
  assert.deepEqual(m.candidateIds.sort(), [1, 2]);
});

test("matchEmail: a found job matches only on its title, never on the company alone", () => {
  const byTitle = matchEmail({ sender: sender("Ramp <jobs@ashbyhq.com>"), subject: "Thanks for applying to Ramp", body: "We received your application for Strategic Finance Associate." }, cands);
  assert.equal(byTitle.applicationId, 4);
  const byName = matchEmail({ sender: sender("Ramp <jobs@ashbyhq.com>"), subject: "Thanks for applying to Ramp", body: "We received your application." }, cands);
  assert.equal(byName.applicationId, null);
  assert.deepEqual(byName.candidateIds, [4]);
});

test("matchEmail: company names in the body are case-sensitive; Workday sends from <company>@myworkday.com", () => {
  const blockWord = matchEmail({ sender: sender("Acme <hr@acme.com>"), subject: "Your application", body: "Please block your calendar for the treasury manager call." }, cands);
  assert.equal(blockWord.companyNamed, false);
  const workday = matchEmail({ sender: sender("Workday <jpmorganchase@myworkday.com>"), subject: "Thank you", body: "Thank you for applying to Vice President, Corporate Development." }, cands);
  assert.equal(workday.applicationId, 6);
});

test("isJobEmail: ATS mail yes, job alerts and bank mail no", () => {
  const job = (raw: string, subject: string, body: string) => {
    const e = { sender: sender(raw), subject, body };
    return isJobEmail(e, matchEmail(e, cands));
  };
  assert.equal(job("Stripe <no-reply@greenhouse-mail.io>", "Thank you for applying", "Thanks for applying to Stripe."), true);
  assert.equal(job("LinkedIn <jobs-noreply@linkedin.com>", "Naren, your application was sent to Plaid", "Plaid"), true);
  assert.equal(job("LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", "Strategic Finance Manager at Stripe and 9 more jobs", "Stripe is hiring. Apply now. Your application could stand out."), false);
  assert.equal(job("Chase <no-reply@alertsp.chase.com>", "Thank you for your application", "We received your credit card application."), false);
  assert.equal(job("Plaid Talent <talent@plaid.com>", "Following up", "Thanks again for your application to Plaid."), true);
  assert.equal(job("Jane Doe <jane@stripe.com>", "Strategic Finance Manager role", "I'm the recruiter for this role at Stripe and wanted to connect."), true);
  assert.equal(job("Stripe <news@stripe.com>", "Stripe Sessions 2026", "Join us at Sessions. Unsubscribe."), false);
});

test("prefilter carries ATS domains, company domains and names", () => {
  const p = prefilter(cands);
  assert.ok(p.domains.includes("greenhouse-mail.io"));
  assert.ok(p.domains.includes("stripe.com"));
  assert.ok(p.terms.includes("block"));
  assert.ok(p.terms.includes("jpmorgan chase"));
});

test("emailStageMove: forward only, approval never, closing only on a rejection", () => {
  assert.deepEqual(emailStageMove("approved", "confirmation"), { to: "applied" });
  assert.deepEqual(emailStageMove("applied", "confirmation"), { to: null });
  assert.deepEqual(emailStageMove("applied", "rejection"), { to: "closed" });
  assert.deepEqual(emailStageMove("found", "interview"), { to: "screening" });
  assert.deepEqual(emailStageMove("screening", "interview"), { to: null });
  assert.deepEqual(emailStageMove("screening", "interview", "interviewing"), { to: "interviewing" });
  assert.deepEqual(emailStageMove("applied", "other"), { to: null });
  assert.deepEqual(emailStageMove("found", "other"), { to: null });
  assert.ok("error" in emailStageMove("interviewing", "interview", "screening"));
  assert.ok("error" in emailStageMove("found", "confirmation", "approved"));
  assert.ok("error" in emailStageMove("applied", "update", "closed"));
  assert.deepEqual(emailStageMove("closed", "rejection"), { to: null });
  assert.ok("error" in emailStageMove("closed", "interview", "screening"));
});

// Phrasings from real candidate inboxes (published datasets and ATS documentation), per vendor.
test("real-world: confirmations that mention interviews or rejection only as possibilities", () => {
  for (const [subject, body] of [
    ["Thank you for applying to Handshake", "We have received your application and will be reviewing your background shortly. If your experience is a good fit for this role we will be in touch shortly with information about next steps."],
    ["Vivekanand, thank you for applying to Olo", "Thanks for applying. You can expect to hear from us soon to let you know whether or not you've been selected for an interview."],
    ["Thank you for your application to Woven by Toyota", "We can confirm we've received your application for the Data role. If you are not selected for this position, keep an eye on our jobs page."],
    ["Application received", "If you do not hear from us within 30 days, it is likely that we have decided to move forward with other candidates. We have received your application."],
    ["CrowdStrike Job Application Confirmation", "Thank you for your interest. You can also log in to your candidate home page."],
    ["NetApp has your application", "We have successfully received your submission to the following position."],
    ["Thank You For Your Interest in LMI", "This letter is to inform you that we have received your resume."],
    ["Indeed Application: React JS", "Your application has been submitted. Good luck!"],
  ]) {
    assert.deepEqual(classify(subject, body, gh), { kind: "confirmation", confident: true }, subject);
  }
});

test("real-world: rejections", () => {
  for (const body of [
    "We aren't moving forward with your application.",
    "After careful consideration, we've made the decision to not move forward with your candidacy.",
    "You were not selected for the role of R123 Data Analyst.",
    "There isn't an ideal fit at this time, but we'll keep your resume on file.",
    "Unfortunately, Acme has moved to the next step with other candidates.",
    "We are unable to proceed further with your application.",
    "Your application was not successful on this occasion.",
    "Thank you for your interest in Visa. After careful review, we have decided to pursue other candidates.",
    "Unfortunately, we won't be able to move forward with your application. If you have any questions, please let us know.",
  ]) {
    assert.equal(classify("An update on your application", body).kind, "rejection", body);
  }
});

test("real-world: interview requests and assessments", () => {
  for (const body of [
    "We were impressed by your application for the Analyst position and would like to schedule an interview with you.",
    "Please pick a slot that works for you using the link below: https://app.goodtime.io/booking/abc",
    "Could you share your availability for 45 minutes next week?",
    "Our scheduling team will be in touch soon to collect your interview availability.",
    "Your interview is scheduled for Monday, October 19, 2026 at 11:30am.",
  ]) {
    assert.equal(classify("Next steps", body).kind, "interview", body);
  }
  assert.equal(classify("Complete your HireVue interview for Acme", "You have been invited to record your answers to a few questions.", sender("HireVue <noreply@hirevue.com>")).kind, "assessment");
  assert.equal(classify("Thank you for your interest in Stripe", "We'd like to learn more about you.").confident, false);
});

test("real-world: account mail isn't kept, and companies are read from vendor addresses", () => {
  const job = (raw: string, subject: string, body: string, list = cands) => {
    const e = { sender: sender(raw), subject, body };
    return isJobEmail(e, matchEmail(e, list));
  };
  assert.equal(job("Workday @ Intel <intel@otp.workday.com>", "Verify your candidate account", "Click to verify."), false);
  assert.equal(job("Oracle <hdjq.fa.sender@workflow.mail.us2.cloud.oracle.com>", "Confirm your identity for job Python Developer - 25020804", "Code: 123456"), false);
  assert.equal(job("Oracle <hdjq.fa.sender@workflow.mail.us2.cloud.oracle.com>", "Thank you for applying", "We have received your application."), true);
  assert.equal(job("Indeed Apply <indeedapply@indeed.com>", "Indeed Application: Treasury Manager", "Your application has been submitted."), true);
  assert.equal(job("LinkedIn <jobs-noreply@linkedin.com>", "Naren, apply now to 'Strategic Finance Manager'", "Apply now"), false);
  const more: Candidate[] = [
    { id: 10, stage: "applied", company: "LMI", title: "Financial Analyst", domains: [] },
    { id: 11, stage: "applied", company: "Nutanix", title: "Corporate Development Manager", domains: [] },
    { id: 12, stage: "applied", company: "Accenture", title: "Strategy Consultant", domains: [] },
  ];
  const m = (raw: string, subject: string, body: string) => matchEmail({ sender: sender(raw), subject, body }, more);
  assert.equal(m("LMI @ icims <lmi+autoreply@talent.icims.com>", "Thank you", "We received your resume.").applicationId, 10);
  assert.equal(m("Nutanix <notification@jobvite.nutanix.com>", "Thanks", "Received.").applicationId, 11);
  assert.equal(m("Accenture Careers <accenture@myworkday.com>", "It's great that you're interested", "Hi").applicationId, 12);
  assert.equal(m("Plaid <talent@plaid.com>", "Hello", "Hi").applicationId, null);
});

// ---------- Regressions found in review ----------

test("review: a reschedule or offer paperwork isn't a rejection", () => {
  assert.equal(classify("Interview update", "Unfortunately our hiring manager is unable to proceed with Tuesday's interview. Could you share your availability for Thursday?").kind, "interview");
  assert.equal(classify("Today's interview", "We regret to inform you that your interviewer is out sick today. Please share your availability so we can reschedule.").kind, "interview");
  assert.equal(classify("Your offer", "We are thrilled to extend you an offer! We cannot proceed with onboarding until we receive your signed offer letter.").kind, "offer");
  assert.deepEqual(classify("Update", "Thank you for taking the time to interview with us. Unfortunately, we have decided to move forward with other candidates."), { kind: "rejection", confident: true });
});

test("review: a company named only in another company's email doesn't match", () => {
  const list: Candidate[] = [{ id: 20, stage: "found", company: "Figma", title: "Product Manager", domains: [] }];
  const m = matchEmail({ sender: sender("Notion <no-reply@ashbyhq.com>"), subject: "Thanks for applying to Notion", body: "We received your application for Product Manager. Teams at Figma and Pixar use Notion every day." }, list);
  assert.equal(m.applicationId, null);
  assert.deepEqual(m.candidateIds, [20]);
});

test("review: a two-word title only matches as written", () => {
  const list: Candidate[] = [{ id: 21, stage: "applied", company: "Figma", title: "Product Manager", domains: [] }, { id: 22, stage: "applied", company: "Figma", title: "Data Analyst", domains: [] }];
  const m = matchEmail({ sender: sender("Figma <no-reply@greenhouse-mail.io>"), subject: "Figma update", body: "Our manager for the product team will be in touch." }, list);
  assert.equal(m.applicationId, null);
});

test("review: a recruiter's own follow-up asking for a time is kept", () => {
  const e = { sender: sender("Jane <jane@visa.com>"), subject: "Next steps", body: "Thanks for your time today. We'd like to bring you back for a final round with the team. What's your availability next week?" };
  const list: Candidate[] = [{ id: 30, stage: "screening", company: "Visa", title: "Payments Strategy Manager", domains: ["visa.com"] }];
  assert.equal(isJobEmail(e, matchEmail(e, list)), true);
});

test("security: a display name or subject naming the company isn't trusted; the company's domain is", () => {
  const list: Candidate[] = [{ id: 40, stage: "interviewing", company: "Stripe", title: "Strategic Finance Manager", domains: [] }];
  const spoof = matchEmail({ sender: sender("Stripe Recruiting <stripe.careers.team@gmail.com>"), subject: "Your application for Strategic Finance Manager", body: "x" }, list);
  assert.equal(spoof.applicationId, 40);
  assert.equal(spoof.trusted, false);
  const lookalike = matchEmail({ sender: sender("Stripe <hr@stripe.mailer-example.com>"), subject: "Strategic Finance Manager", body: "x" }, list);
  assert.equal(lookalike.trusted, false);
  const real = matchEmail({ sender: sender("Stripe <jobs@stripe.com>"), subject: "Strategic Finance Manager", body: "x" }, list);
  assert.equal(real.trusted, true);
  const ats = matchEmail({ sender: sender("Stripe <no-reply@us.greenhouse-mail.io>"), subject: "Strategic Finance Manager", body: "x" }, list);
  assert.equal(ats.trusted, true);
});

test("security: interviewer-side mail and a colleague's 'got time to talk?' aren't kept", () => {
  const list: Candidate[] = [{ id: 50, stage: "found", company: "JPMorgan Chase", title: "Vice President, Strategy", domains: ["jpmorganchase.com"] }];
  const job = (raw: string, subject: string, body: string) => {
    const e = { sender: sender(raw), subject, body };
    return isJobEmail(e, matchEmail(e, list));
  };
  assert.equal(job("Greenhouse <no-reply@greenhouse.io>", "Interview scheduled: Jane Doe for Senior Engineer", "Open the interview kit and submit your scorecard after the interview."), false);
  assert.equal(job("Bob Smith <bob@jpmorganchase.com>", "Quick sync", "Would you be available for a call tomorrow?"), false);
});

// ---------- Regressions from the review of the matching rules ----------

test("rules: 'let me know if', 'if you're still interested', 'should you need' and the month May aren't hypotheticals", () => {
  const person = sender("Jane <jane@stripe.com>");
  assert.deepEqual(classify("Re: Strategic Finance Manager", "Thanks for applying for the Strategic Finance Manager position! If you're still interested, could you send over some times that work for a quick phone screen?", person), { kind: "interview", confident: false });
  assert.equal(classify("Thank you for applying", "Thanks for applying! If you're still interested, could you send over some times that work for a quick phone screen?", gh).kind, "interview");
  assert.equal(classify("Next steps", "Please let me know if you're available for a 30-minute call with the hiring manager.", gh).kind, "interview");
  assert.equal(classify("Interview confirmed", "Your interview for the Strategic Finance Manager role is scheduled for Tuesday, May 12 at 10am PT.", gh).kind, "interview");
  assert.equal(classify("Your interview", "Your interview is scheduled for Tuesday at 2pm; should you need to reschedule, reply here.", gh).kind, "interview");
  // The hypothetical is only the clause after "but".
  assert.deepEqual(classify("Your application", "Thank you for applying. Unfortunately, we won't be moving forward at this time, but we may reach out if a similar role opens.", gh), { kind: "rejection", confident: true });
});

test("rules: a confirmation is recorded on its own only from a system, and only when it asks for nothing", () => {
  assert.equal(classify("Thanks for applying", "Thanks for applying to the Strategic Finance Manager role at Stripe. I'd like to find 30 minutes to chat about your background. Does Thursday at 2pm ET work?", sender("Jane Doe <jane@stripe.com>")).confident, false);
  assert.equal(classify("Thanks for applying", "Thanks for applying to the Strategic Finance Manager role at Stripe. Could we talk Thursday?", gh).confident, false);
  assert.deepEqual(classify("Next step", "Thank you for applying to the Strategic Finance Manager role. As a next step, please complete the Criteria Cognitive Aptitude Test (CCAT) within 48 hours.", gh), { kind: "assessment", confident: false });
  assert.deepEqual(classify("Thanks for applying", "Thanks for applying to Stripe. Please record a short one-way video introduction on Spark Hire by Friday.", gh), { kind: "assessment", confident: false });
  // Footers and timestamps don't count against it.
  assert.deepEqual(classify("Thank you for applying", "We received your application on Monday, October 12 at 3:45 PM. Questions? Visit our FAQ. Please do not reply to this email.", gh), { kind: "confirmation", confident: true });
});

test("rules: confirmation boilerplate about other candidates isn't a rejection", () => {
  const ashby = sender("Plaid <no-reply@ashbyhq.com>");
  assert.deepEqual(classify("Thank you for applying to Plaid", "Thanks for applying to the Corporate Development Associate role. We are reviewing your application alongside other candidates who applied and will be in touch.", ashby), { kind: "confirmation", confident: true });
  for (const body of [
    "Thank you for applying. Applicants who were not selected will be notified by email.",
    "Thank you for applying. Only applicants selected for interview will be contacted; applicants who are not a match will not hear back.",
    "Thank you for applying. Candidates not contacted within 4 weeks have not been selected.",
    "We will continue to accept applications until the position has been filled.",
  ]) {
    assert.notEqual(classify("Application received", body, ashby).kind, "rejection", body);
  }
  assert.equal(classify("Update", "Good news: the team has decided to move forward with another round of interviews for the Strategic Finance Manager role. Could you share your availability?", ashby).kind, "interview");
  assert.equal(classify("Your application", "Your application stood out among the other applicants who applied. Do you have 30 minutes on Friday?", ashby).kind, "interview");
});

test("rules: past steps don't turn a rejection into a next step", () => {
  assert.deepEqual(classify("Update", "Thanks for speaking with me on our recruiter call last week about the Strategic Finance Manager role. Unfortunately, the team has decided not to move forward."), { kind: "rejection", confident: true });
  assert.deepEqual(classify("Update", "Thank you for completing the HireVue interview for the Strategic Finance Manager role. After careful review, we will not be moving forward with your application."), { kind: "rejection", confident: true });
  // Mail from an assessment tool is a test to take, unless it's the receipt for one you took.
  assert.equal(classify("Thank you", "Thank you for completing your interview. The team will be in touch.", sender("Acme <noreply@hirevue.com>")).kind, "other");
  assert.equal(classify("Acme invited you", "Hello", sender("Acme <noreply@hirevue.com>")).kind, "assessment");
});

test("rules: asks the patterns don't know still point at a kind", () => {
  const workday = sender("Stripe <stripe@myworkday.com>");
  assert.deepEqual(classify("Strategic Finance Manager: your application status has changed", "Please log in to your Candidate Home to review and accept your offer.", workday), { kind: "offer", confident: false });
  assert.equal(classify("Great news", "Great news, the team would like to make you an offer for the Strategic Finance Manager role!", workday).kind, "offer");
  assert.equal(classify("Thank you for applying", "Thank you for applying to the Strategic Finance Manager role. The next step is an assessment.", workday).kind, "assessment");
  // A portal notice is news you can't read without logging in: worth a look, not filed away.
  assert.deepEqual(classify("Strategic Finance Manager: application status update", "There has been an update to your application status. Please log in to your Candidate Home to view it.", workday), { kind: "update", confident: false });
});

const titled: Candidate[] = [
  { id: 60, stage: "applied", company: "Stripe", title: "Strategic Finance Manager", domains: ["stripe.com"] },
  { id: 61, stage: "applied", company: "Stripe", title: "Treasury Analyst", domains: ["stripe.com"] },
  { id: 62, stage: "applied", company: "Plaid", title: "Product Manager", domains: [] },
  { id: 63, stage: "found", company: "Figma", title: "Strategic Finance", domains: [] },
];

test("rules: a title inside a longer one, or named as another opening, isn't the application's", () => {
  const m = (raw: string, subject: string, body: string) => matchEmail({ sender: sender(raw), subject, body }, titled);
  const senior = m("Stripe <no-reply@greenhouse-mail.io>", "Your application to Stripe", "Thank you for applying to the Senior Strategic Finance Manager role. Unfortunately, we have decided to move forward with other candidates.");
  assert.notEqual(senior.matchedBy, "title");
  const plaid = m("Plaid <no-reply@ashbyhq.com>", "Your application to Plaid", "Thank you for applying to the Senior Product Manager, Payments role. Unfortunately, we have decided to move forward with other candidates.");
  assert.notEqual(plaid.matchedBy, "title");
  const other = m("Stripe <no-reply@greenhouse-mail.io>", "Your application to Stripe", "Thank you for applying to the Treasury Analyst role. Unfortunately, we have decided to move forward with other candidates. We encourage you to look at other openings such as our Strategic Finance Manager role.");
  assert.deepEqual([other.applicationId, other.matchedBy], [61, "title"]);
  const longer = m("Figma <no-reply@greenhouse-mail.io>", "Thanks for applying to Figma", "We've received your application for Strategic Finance Manager, Sales.");
  assert.equal(longer.applicationId, null);
  // As written, in the usual places.
  for (const [subject, body] of [
    ["Strategic Finance Manager at Stripe", "Thanks for applying."],
    ["Your application", "Thanks for applying for the Strategic Finance Manager (Remote) position!"],
    ["Stripe | Strategic Finance Manager - R12345", "We received your application."],
  ]) {
    assert.deepEqual([m("Stripe <no-reply@greenhouse-mail.io>", subject, body).applicationId, m("Stripe <no-reply@greenhouse-mail.io>", subject, body).matchedBy], [60, "title"], subject);
  }
});

test("rules: reminders, saved jobs and talent communities aren't applications, and an update moves nothing", () => {
  const list: Candidate[] = [{ id: 70, stage: "found", company: "Ramp", title: "Strategic Finance Associate", domains: [] }];
  const job = (raw: string, subject: string, body: string) => {
    const e = { sender: sender(raw), subject, body };
    return isJobEmail(e, matchEmail(e, list));
  };
  assert.equal(job("Ramp <no-reply@ashbyhq.com>", "Reminder: Strategic Finance Associate at Ramp", "You started an application for Strategic Finance Associate but haven't submitted it. Click here to finish completing your application."), false);
  assert.equal(job("Ramp <no-reply@ashbyhq.com>", "Welcome to Ramp Careers", "You saved Strategic Finance Associate. Once your application has been submitted, you can track its status here."), false);
  assert.notEqual(classify("Welcome", "Once your application has been submitted, you can track its status here.", gh).kind, "confirmation");
  assert.notEqual(classify("Interested?", "Interested in applying to Strategic Finance Associate? Applications are under review on a rolling basis.", gh).confident, true);
  assert.deepEqual(emailStageMove("found", "update"), { to: null });
  assert.deepEqual(emailStageMove("approved", "update"), { to: null });
});

test("rules: card applications, newsletters and 'book a time with a specialist' aren't job mail", () => {
  const list: Candidate[] = [
    { id: 80, stage: "applied", company: "American Express", title: "Strategy Manager", domains: ["americanexpress.com"] },
    { id: 81, stage: "applied", company: "Stripe", title: "Strategic Finance Manager", domains: ["stripe.com"] },
    { id: 82, stage: "applied", company: "Fidelity", title: "Corporate Strategy Associate", domains: ["fidelity.com"] },
    { id: 83, stage: "applied", company: "Apple", title: "Finance Manager", domains: ["apple.com"] },
    { id: 84, stage: "applied", company: "Robinhood", title: "Strategy Associate", domains: ["robinhood.com"] },
  ];
  const job = (raw: string, subject: string, body: string) => {
    const e = { sender: sender(raw), subject, body };
    return isJobEmail(e, matchEmail(e, list));
  };
  assert.equal(job("American Express <AmericanExpress@welcome.americanexpress.com>", "An update on your application", "Thank you for applying for the American Express Gold Card. Your application was declined."), false);
  assert.equal(job("Robinhood <notifications@robinhood.com>", "Your application", "Thanks for applying for the Robinhood Gold Card."), false);
  assert.equal(job("Stripe <news@stripe.com>", "What's new at Stripe: October", "Read the case study: how Figma scaled billing with Stripe. Unsubscribe"), false);
  assert.equal(job("Fidelity <fidelity@mail.fidelity.com>", "Plan ahead", "Schedule a call with a Fidelity financial consultant."), false);
  assert.equal(job("Apple <news@apple.com>", "Get to know your iPhone", "Book a time with an Apple Specialist."), false);
  // An Amex recruiter is still kept.
  assert.equal(job("Amy Lee <amy.lee@americanexpress.com>", "Strategy Manager - next steps", "Thanks for applying to the Strategy Manager role. Could you share your availability for a call?"), true);
});

test("rules: an employer writing through LinkedIn or Indeed is kept, but not trusted for the company", () => {
  const list: Candidate[] = [{ id: 90, stage: "applied", company: "Stripe", title: "Strategic Finance Manager", domains: ["stripe.com"] }];
  const check = (raw: string, subject: string, body: string) => {
    const e = { sender: sender(raw), subject, body };
    const m = matchEmail(e, list);
    return { kept: isJobEmail(e, m), trusted: m.trusted, kind: classify(subject, body, e.sender).kind };
  };
  assert.deepEqual(check("Indeed <noreply@indeed.com>", "Interview request from Stripe for Strategic Finance Manager", "Stripe would like to schedule an interview with you. Please choose a time."), { kept: true, trusted: false, kind: "interview" });
  assert.deepEqual(check("Indeed <noreply@indeed.com>", "New message from Stripe", "Hi Naren, are you available for a phone screen on Thursday for the Strategic Finance Manager role?"), { kept: true, trusted: false, kind: "interview" });
  assert.deepEqual(check("Jane Doe via LinkedIn <messages-noreply@linkedin.com>", "Jane just messaged you", "Hi Naren, thanks for applying to the Strategic Finance Manager role at Stripe. Are you available for a call this week?"), { kept: true, trusted: false, kind: "interview" });
  // The board's own notice still vouches; its alerts still aren't kept.
  assert.equal(check("LinkedIn <jobs-noreply@linkedin.com>", "Your application was sent to Stripe", "Strategic Finance Manager").trusted, true);
  assert.equal(check("LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", "Stripe is hiring: Strategic Finance Manager", "Stripe and 12 more companies are hiring. Would you like to schedule a call with a career coach?").kept, false);
});

// ---------- Regressions from the adversarial pass ----------

test("adversarial: an invite inside an applicant system's 'thanks for applying' isn't a confirmation", () => {
  const ashby = sender("Plaid <no-reply@ashbyhq.com>");
  for (const body of [
    "Thank you for applying to the Corporate Development Associate role at Plaid. As the next step in our hiring process, we would like to invite you to an interview with the hiring manager. Our recruiting coordinator will be in touch shortly with the details.",
    "Thank you for applying. You've been selected as one of the top candidates, and we'd like to schedule a 30-minute call with the hiring manager.",
    "Thank you for applying. We're inviting shortlisted candidates to a 30-minute intro call with our team, and we'd love for you to be one of them.",
    "Thank you for applying to the Strategic Finance Associate role at Ramp. We'd like to bring you in to meet the team in person. Please let us know which dates work best for you.",
    "Thank you for applying. You have been selected for a first-round conversation with our team.",
    "Thank you for your application. Let me know when works for you to hop on the phone this week.",
  ]) {
    assert.equal(classify("Plaid - Corporate Development Associate", body, ashby).kind, "interview", body);
  }
  assert.equal(classify("Your application", "Thanks for applying. Please answer three short screening questions at the link below by Friday.", ashby).confident, false);
  assert.equal(classify("Business Operations Manager at Figma", "Thanks for applying to the Business Operations Manager role! I'm the recruiter for this search. Do you have time for a quick call this week?", sender("Jane Lee <jane.lee@figma.com>")).kind, "interview");
  // Template lines about the process stay template lines.
  assert.deepEqual(classify("Thank you for applying", "Thank you for applying. Our hiring process typically includes a recruiter screen and two interviews. Questions? Please contact us.", ashby), { kind: "confirmation", confident: true });
});

test("adversarial: 'can't move forward' about a slot, a pause or a missing document doesn't close the application", () => {
  const person = sender("Jane Smith <jane.smith@stripe.com>");
  assert.deepEqual(classify("Strategic Finance Manager - update", "I wanted to give you a quick update on the Strategic Finance Manager role. Due to a budget freeze, we won't be moving forward with interviews for this role this quarter. Your application remains active, and I'll be in touch as soon as hiring resumes.", person), { kind: "rejection", confident: false });
  assert.equal(classify("Update", "This role has been put on hold, so we are not moving forward with any candidates at this time. We'll keep your application on file and reach out as soon as the role reopens.", gh).confident, false);
  assert.notEqual(classify("Treasury Manager - phone screen tomorrow", "Unfortunately, we won't be able to move forward with tomorrow's phone screen as planned, since I'm out sick. I'll reach out early next week with a new date.", person).kind, "rejection");
  assert.notEqual(classify("Strategic Finance Manager - action needed", "We cannot proceed with your application without a copy of your unofficial transcript. Please reply to this email with your transcript attached.", person).kind, "rejection");
  // Real rejections stay certain.
  assert.deepEqual(classify("Update", "Unfortunately, we won't be moving forward with an interview. Your profile will remain active in our talent community.", gh), { kind: "rejection", confident: true });
});

test("adversarial: everyday rejection wordings are rejections", () => {
  for (const line of [
    "We have selected another candidate for this position.",
    "We've chosen to move ahead with other candidates at this time.",
    "Unfortunately, your application has not been shortlisted on this occasion.",
    "Unfortunately, your application has not been successful on this occasion.",
    "After careful review, we have decided to proceed with candidates whose experience more closely aligns with our needs.",
    "We have offered the position to another candidate.",
    "Regrettably, we are unable to take your application forward.",
    "We have decided to continue with other candidates.",
    "Unfortunately, we will not be inviting you to interview at this time.",
  ]) {
    assert.deepEqual(classify("Your application to Brex", `Thank you for applying to the Finance Manager role at Brex. ${line}`, gh), { kind: "rejection", confident: true }, line);
  }
  assert.notEqual(classify("Thanks", "Thank you for applying. Applicants who have not been selected will be notified.", gh).kind, "rejection");
});

test("adversarial: talent-community and job-alert sign-ups aren't applications", () => {
  const workday = sender("Visa <visa@myworkday.com>");
  assert.equal(classify("Thank you for joining our Talent Community", "Thank you for submitting your information to the Visa Talent Community for the Payments Strategy Manager position. Our recruiters will review your profile and contact you if there is a match.", workday).confident, false);
  assert.equal(classify("Job alert created: Payments Strategy Manager", "Thank you for submitting your job alert. We will email you when new positions matching Payments Strategy Manager are posted.", workday).confident, false);
  assert.equal(classify("Thank you for your application", "Thank you for applying to the Payments Strategy Manager position. We have received your application. In the meantime, join our Talent Community.", workday).confident, true);
});

test("adversarial: a platform's mail about other employers isn't about your application at that platform", () => {
  const list: Candidate[] = [
    { id: 100, stage: "approved", company: "LinkedIn", title: "Senior Financial Analyst", domains: [] },
    { id: 101, stage: "applied", company: "Oracle", title: "Senior Financial Analyst", domains: ["oracle.com"] },
    { id: 102, stage: "found", company: "Indeed", title: "Data Analyst", domains: [] },
    { id: 103, stage: "applied", company: "JPMorgan Chase", title: "Treasury Analyst", domains: ["jpmorganchase.com"] },
  ];
  const m = (raw: string, subject: string, body: string) => matchEmail({ sender: sender(raw), subject, body }, list).applicationId;
  assert.equal(m("LinkedIn <jobs-noreply@linkedin.com>", "Naren, your application was sent to Plaid", "Your application was sent to Plaid\n\nSenior Financial Analyst\nPlaid · San Francisco, CA (Hybrid)"), null);
  // JPMorgan's mail through Oracle's applicant system: a suggestion for JPMorgan's one application, not Oracle's.
  const orc = matchEmail({ sender: sender("JPMorgan Chase <hdjq.fa.sender@workflow.mail.us2.cloud.oracle.com>"), subject: "Update on your application", body: "Thank you for your interest in the Senior Financial Analyst position at JPMorgan Chase." }, list);
  assert.deepEqual([orc.applicationId, orc.matchedBy], [103, "company"]);
  assert.equal(m("Indeed Apply <indeedapply@indeed.com>", "Indeed Application: Data Analyst", "Your application has been submitted. Good luck!\n\nData Analyst\nAcme Health - Austin, TX"), null);
  assert.equal(m("JPMorgan Chase <hdjq.fa.sender@workflow.mail.us2.cloud.oracle.com>", "Your application", "Thank you for applying to the Treasury Analyst position at JPMorgan Chase."), 103);
});

test("adversarial: '___, Payments' and '___ - Payments' are other jobs; '___ - San Francisco' and '___, Stripe' aren't", () => {
  const list: Candidate[] = [{ id: 110, stage: "applied", company: "Stripe", title: "Product Manager", domains: ["stripe.com"] }];
  const by = (subject: string, body: string) => matchEmail({ sender: gh, subject, body }, list).matchedBy;
  assert.notEqual(by("Your application to Stripe", "Thank you for applying for the Product Manager, Payments role at Stripe. Unfortunately, we have decided to move forward with other candidates."), "title");
  assert.notEqual(by("Your application to Stripe", "Thank you for applying for the Product Manager - Payments role."), "title");
  for (const subject of ["Product Manager - Stripe", "Product Manager - San Francisco, CA", "Product Manager, Remote (US)", "Stripe | Product Manager - R12345", "Product Manager (R12345) - Stripe"]) {
    assert.equal(by(subject, "Thanks for applying."), "title", subject);
  }
  const both: Candidate[] = [...list, { id: 111, stage: "found", company: "Stripe", title: "Product Manager, Payments", domains: ["stripe.com"] }];
  assert.equal(matchEmail({ sender: gh, subject: "Your application to Stripe", body: "Thank you for applying for the Product Manager, Payments role." }, both).applicationId, 111);
});

test("adversarial: titles listed as other openings or quoted from an earlier message don't count", () => {
  const list: Candidate[] = [
    { id: 120, stage: "applied", company: "Stripe", title: "Strategic Finance Manager", domains: ["stripe.com"] },
    { id: 121, stage: "found", company: "Stripe", title: "Treasury Analyst", domains: ["stripe.com"] },
  ];
  const listed = matchEmail({ sender: gh, subject: "Your application to Stripe", body: "Hi Naren,\n\nThank you for your interest in Stripe and for applying to the Treasury Analyst role. After careful consideration, we have decided to move forward with other candidates whose experience more closely matches our needs.\n\nWe'd encourage you to take a look at some of our other open roles that may be a fit:\nStrategic Finance Manager\nSenior Accountant, Revenue\n\nBest,\nStripe Recruiting" }, list);
  assert.deepEqual([listed.applicationId, listed.matchedBy], [121, "title"]);
  const quoted = matchEmail({ sender: sender("Jane Smith <jane.smith@stripe.com>"), subject: "Re: your application", body: "Hi Naren,\n\nThanks for following up. Unfortunately, the hiring team has decided not to move forward with your application for the Treasury Analyst role.\n\nBest,\nJane\n\nOn Mon, Oct 19, 2026 at 9:14 AM Naren <naren@example.com> wrote:\n> Hi Jane, I also applied to the Strategic Finance Manager role last week." }, list);
  assert.deepEqual([quoted.applicationId, quoted.matchedBy], [121, "title"]);
});

test("adversarial: a company that only resembles yours doesn't vouch for it", () => {
  const list: Candidate[] = [
    { id: 130, stage: "applied", company: "Block", title: "Financial Analyst", domains: ["block.xyz"] },
    { id: 131, stage: "approved", company: "Mercury", title: "Senior Financial Analyst", domains: [] },
    { id: 132, stage: "applied", company: "Ramp", title: "Financial Analyst", domains: [] },
  ];
  const t = (raw: string, subject: string, body: string) => matchEmail({ sender: sender(raw), subject, body }, list).trusted;
  assert.equal(t("H&R Block <hrblock@myworkday.com>", "Your application to H&R Block", "Thank you for your interest in the Financial Analyst position at H&R Block."), false);
  assert.equal(t("Mercury Systems <mrcy@myworkday.com>", "Thank you for applying to Mercury Systems", "Thank you for applying for the Senior Financial Analyst position at Mercury Systems."), false);
  assert.equal(t("Anna Kowalska <anna.kowalska@ramp.network>", "Financial Analyst - Ramp Network", "Thank you for taking the time to apply for the Financial Analyst position."), false);
  assert.equal(t("Ramp Talent Acquisition <hr@ramp.careers>", "Interview Invitation - Financial Analyst", "We would like to invite you to an online interview for the Financial Analyst position."), false);
  // The real ones still do.
  assert.equal(t("Ramp Recruiting <no-reply@ashbyhq.com>", "Thanks for applying to Ramp", "We received your application for Financial Analyst."), true);
  assert.equal(t("Ramp <talent@ramp.com>", "Financial Analyst", "Thanks for applying."), true);
  assert.equal(t("Block <no-reply@block.xyz>", "Financial Analyst", "Thanks for applying."), true);
});

test("adversarial: assessment tools are kept and read as tests; Indeed's relayed employer mail doesn't vouch", () => {
  assert.equal(classify("Stripe has invited you to an assessment", "Hello", sender("Criteria <noreply@criteriacorp.com>")).kind, "assessment");
  const list: Candidate[] = [{ id: 140, stage: "applied", company: "Stripe", title: "Strategic Finance Manager", domains: ["stripe.com"] }];
  assert.equal(matchEmail({ sender: sender("Stripe <employer-reply@indeedemail.com>"), subject: "Strategic Finance Manager at Stripe", body: "Can you interview tomorrow?" }, list).trusted, false);
});

// ---------- Regressions from the second adversarial pass ----------

test("adversarial 2: a recruiter who couldn't reach you, or wants you for another opening, isn't rejecting you", () => {
  const person = sender("Jane Smith <jane.smith@stripe.com>");
  for (const body of [
    "I tried calling you this morning about your application for the Strategic Finance Manager role, but we have not been successful in reaching you. Please give me a call back at 415-555-0100 at your earliest convenience.",
    "I've tried to reach you twice about scheduling your phone screen for the Strategic Finance Manager role, but have not been successful.",
    "The Senior Strategic Finance Manager role has been offered to another candidate, but the hiring manager was impressed with your background and would like you to interview for our Strategic Finance Manager opening instead. I'll send over a few times shortly.",
  ]) {
    assert.deepEqual(classify("Strategic Finance Manager - phone screen", body, person), { kind: "interview", confident: false }, body);
  }
  for (const line of ["Unfortunately, your application has not been shortlisted on this occasion.", "Unfortunately, your application has not been successful on this occasion."]) {
    assert.deepEqual(classify("Your application", `Thank you for applying. ${line}`, gh), { kind: "rejection", confident: true }, line);
  }
});

test("adversarial 2: common rejections aren't confirmations, and a status changed to a decision is announced", () => {
  for (const line of [
    "After careful consideration, we have decided to move forward with candidates whose experience more closely aligns with the needs of the team.",
    "Unfortunately, we will be moving forward with candidates who more closely match our needs.",
    "We've decided to move forward with a candidate whose experience more closely matches our needs.",
    "After reviewing your application, we have decided to pursue candidates whose backgrounds more closely match the role.",
    "We've decided to go with someone else for this role.",
    "We have decided to hire another candidate for this position.",
    "We regret to inform you that you have been unsuccessful on this occasion.",
    "Unfortunately, you were not chosen for this position.",
    "We will not be continuing with your application.",
    "The team has decided to take the role in another direction.",
    "After careful review, we have decided not to move forward with your application.\n\nWe hope you'll consider applying again at another time.",
  ]) {
    assert.deepEqual(classify("Your application to Stripe", `Hi Naren,\n\nThank you for applying to the Strategic Finance Manager role at Stripe. ${line}\n\nStripe Recruiting`, gh), { kind: "rejection", confident: true }, line);
  }
  assert.deepEqual(classify("Application status", "Your application status for the position Strategic Finance Manager (Req 12345) has been updated.\n\nNew status: Rejected", sender("Stripe <noreply@successfactors.com>")), { kind: "rejection", confident: false });
  assert.deepEqual(classify("Application update", "Your application status has been updated to: Not selected by employer.", sender("Indeed <donotreply@match.indeed.com>")), { kind: "rejection", confident: false });
  // Still a confirmation, an interview, and not a rejection.
  assert.deepEqual(classify("Thanks for applying", "Thank you for applying. We will review your application and move forward with candidates whose qualifications best match the role.", gh), { kind: "confirmation", confident: true });
  assert.equal(classify("Next steps", "We have decided to move forward with your application and would like to schedule a phone screen.", gh).kind, "interview");
  assert.notEqual(classify("Next steps", "We have decided to move forward with another round of interviews with you.", gh).kind, "rejection");
});

test("adversarial 2: another job at the company with your title in it isn't yours; places, req numbers and subject words are", () => {
  const list: Candidate[] = [{ id: 150, stage: "applied", company: "Ramp", title: "Financial Analyst", domains: ["ramp.com"] }];
  const ramp = sender("Ramp <no-reply@ashbyhq.com>");
  const by = (subject: string, body = "Thanks for applying.") => matchEmail({ sender: ramp, subject, body }, list).matchedBy;
  for (const subject of ["Financial Analyst, Global Treasury", "Financial Analyst, New Ventures", "Financial Analyst (Treasury)", "Financial Analyst 2", "Senior Financial Analyst (Remote)"]) {
    assert.notEqual(by(subject), "title", subject);
  }
  assert.notEqual(by("Your application to Ramp", "Thank you for applying to the Treasury Analyst role. Unfortunately, we have decided to move forward with other candidates.\n\nOther roles you might like\nFinancial Analyst\nSenior Accountant"), "title");
  for (const subject of ["Financial Analyst - New York, NY", "Financial Analyst, United States", "Financial Analyst - San Francisco, CA", "Financial Analyst, Remote (US)", "Financial Analyst - North America", "Financial Analyst (R12345)", "Financial Analyst - Next Steps", "Financial Analyst - Charlotte, NC - Application Received", "Financial Analyst - Phone Screen"]) {
    assert.equal(by(subject), "title", subject);
  }
  // A title's own parenthesis still matches, with or without it.
  const fpa: Candidate[] = [{ id: 151, stage: "applied", company: "Ramp", title: "Financial Analyst (FP&A)", domains: ["ramp.com"] }];
  assert.equal(matchEmail({ sender: ramp, subject: "Financial Analyst (FP&A)", body: "Thanks for applying." }, fpa).matchedBy, "title");
  assert.equal(matchEmail({ sender: ramp, subject: "Your application", body: "Thanks for applying for the Financial Analyst role." }, fpa).matchedBy, "title");
});

test("adversarial 2: a job board's notice about a lookalike, and a shared career site, don't vouch for your company", () => {
  const list: Candidate[] = [
    { id: 160, stage: "applied", company: "Block", title: "Financial Analyst", domains: ["block.xyz"] },
    { id: 161, stage: "applied", company: "Square", title: "Strategy Associate", domains: [] },
  ];
  const li = sender("LinkedIn <jobs-noreply@linkedin.com>");
  const t = (subject: string, body: string) => matchEmail({ sender: li, subject, body }, list).trusted;
  assert.equal(t("Naren, your application was sent to H&R Block", "Your application was sent to H&R Block\nFinancial Analyst\nH&R Block · Kansas City, MO"), false);
  assert.equal(t("Naren, your application was sent to Square Enix", "Your application was sent to Square Enix\nStrategy Associate\nSquare Enix · Los Angeles, CA"), false);
  assert.equal(t("Naren, your application was sent to Block", "Your application was sent to Block\nFinancial Analyst\nBlock · Oakland, CA"), true);
  // NEOGOV and Workday host many employers' careers pages.
  assert.equal(companyDomain("https://www.governmentjobs.com/careers/austintx/jobs/123"), null);
  assert.equal(companyDomain("https://acme.wd5.myworkdayjobs.com/en-US/External/job/123"), null);
  const austin: Candidate[] = [{ id: 162, stage: "applied", company: "City of Austin", title: "Budget Analyst", domains: [] }];
  const neogov = (raw: string) => matchEmail({ sender: sender(raw), subject: "Budget Analyst", body: "Thank you for your interest in the Budget Analyst position. Unfortunately, you were not selected." }, austin);
  assert.equal(neogov("Williamson County <noreply@governmentjobs.com>").applicationId, null);
  assert.equal(neogov("City of Austin <noreply@governmentjobs.com>").trusted, true);
});

test("adversarial 2: an offer after 'thank you for your application' is an offer", () => {
  for (const body of [
    "Thank you for your application for the Strategic Finance Manager role. We would like to offer you the position, and your offer letter will follow shortly.",
    "Thank you for your application. It is my pleasure to offer you the role of Strategic Finance Manager at Stripe.",
    "Thank you for your application. We're happy to let you know you have been selected for the position.",
  ]) {
    assert.deepEqual(classify("Your application to Stripe", body, gh), { kind: "offer", confident: false }, body);
  }
  assert.equal(classify("Your application", "Thank you for your application. Congratulations, you've been shortlisted!", gh).kind, "interview");
  assert.equal(classify("Next steps", "We'd like to offer you an interview for the role.", gh).kind, "interview");
  assert.deepEqual(classify("Your application", "Thank you for your application. Unfortunately, we are not able to offer you the position.", gh), { kind: "rejection", confident: true });
});

test("adversarial 2: a closed posting, a volume disclaimer, a correction or a duplicate doesn't close the application", () => {
  for (const body of [
    "Thank you for your interest. This posting is no longer accepting applications, so we are unable to move forward with your submission. If you applied earlier, your application is still being reviewed.",
    "Please disregard our previous email, which was sent in error. We are still reviewing your application for the Strategic Finance Manager role.",
    "We received a duplicate submission for the Strategic Finance Manager role, so we won't be moving forward with this one. Your original application remains under review.",
  ]) {
    assert.notDeepEqual(classify("Your application", body, gh), { kind: "rejection", confident: true }, body);
  }
  assert.deepEqual(classify("Thank you for applying", "Thank you for applying to Stripe. We have received your application. Due to the high volume of applications, we are not able to move forward with every applicant, but we review each one carefully.", gh), { kind: "confirmation", confident: true });
});

test("adversarial 2: interview requests and offers from employers you applied to are kept", () => {
  const keep = (raw: string, subject: string, body: string, list: Candidate[]) => {
    const e = { sender: sender(raw), subject, body };
    const m = matchEmail(e, list);
    return { kept: isJobEmail(e, m), id: m.applicationId };
  };
  const stripe: Candidate[] = [{ id: 170, stage: "applied", company: "Stripe", title: "Strategic Finance Manager", domains: ["stripe.com"] }];
  assert.deepEqual(keep("Jane Smith <jane.smith@stripe.com>", "Strategic Finance Manager", "Hi Naren, thanks for applying. Could you send me your availability to interview next week?", stripe), { kept: true, id: 170 });
  const sofi: Candidate[] = [{ id: 171, stage: "applied", company: "SoFi", title: "Treasury Analyst", domains: ["sofi.com"] }];
  assert.deepEqual(keep("Amy Lee <alee@sofi.com>", "Quick call?", "Hi Naren, are you free for a quick call on Thursday about the Treasury Analyst role?\n\nAmy Lee | Recruiting\nSoFi: personal loans, credit cards and more. Unsubscribe", sofi), { kept: true, id: 171 });
  const harvey: Candidate[] = [{ id: 172, stage: "applied", company: "Harvey", title: "Strategic Finance Lead", domains: [] }];
  const h = keep("Alex Kim <alex@harvey.ai>", "Strategic Finance Lead - next steps", "Thanks for applying for the Strategic Finance Lead role. I'd love to set up a 30 minute call. Does Thursday at 2pm PT work for you?", harvey);
  assert.deepEqual(h, { kept: true, id: 172 });
  const workday: Candidate[] = [{ id: 173, stage: "applied", company: "Workday", title: "Senior Financial Analyst", domains: [] }];
  assert.deepEqual(keep("Megan Lee <megan.lee@workday.com>", "Senior Financial Analyst - next steps", "Thanks for applying! Do you have 30 minutes this week for a quick phone screen?", workday), { kept: true, id: 173 });
  const wdRej = matchEmail({ sender: sender("Workday <workday@myworkday.com>"), subject: "Senior Financial Analyst at Workday", body: "Thank you for your interest in the Senior Financial Analyst position at Workday." }, workday);
  assert.deepEqual([wdRej.applicationId, wdRej.matchedBy, wdRej.trusted], [173, "title", true]);
  // harvey.ai names Harvey but doesn't vouch for it; "& Co." is part of the name.
  assert.equal(matchEmail({ sender: sender("Alex Kim <alex@harvey.ai>"), subject: "Strategic Finance Lead", body: "Thanks for applying." }, harvey).trusted, false);
  assert.deepEqual(companyAliases("JPMorgan Chase & Co."), ["JPMorgan Chase & Co.", "JPMorgan Chase"]);
  // An interviewer's mail still isn't kept.
  assert.equal(keep("Greenhouse <no-reply@greenhouse.io>", "Interview scheduled", "Please share your availability to interview candidates for the Strategic Finance Manager role.", stripe).kept, false);
});

test("adversarial 2: standard applicant-system footers don't hold up a confirmation or rejection", () => {
  const workday = sender("Visa <visa@myworkday.com>");
  for (const footer of [
    "We invite you to learn more about life at Visa on our careers site.",
    "We'd love for you to follow us on LinkedIn.",
    "If you need an accommodation during the hiring process, please let us know how we can help.",
    "As an equal opportunity employer, we invite you to complete our voluntary self-identification survey using the link below.",
    "We invite you to apply for other roles that match your skills.",
  ]) {
    assert.deepEqual(classify("Thank you for your application", `Thank you for applying to the Payments Strategy Manager position. We have received your application. ${footer}`, workday), { kind: "confirmation", confident: true }, footer);
  }
  for (const footer of [
    "Your candidate profile remains active, and we invite you to join our Talent Community.",
    "We invite you to apply for other roles that match your skills.",
    "We invite you to consider other openings on our careers site.",
  ]) {
    assert.deepEqual(classify("Your application", `Thank you for applying to Visa. Unfortunately, we have decided not to move forward with your application. ${footer}`, workday), { kind: "rejection", confident: true }, footer);
  }
  // An invitation to an interview is still one.
  assert.equal(classify("Your application", "Thank you for applying to Visa. Unfortunately, we have decided not to move forward with your application for the Senior role. We invite you to join us for an interview for the Analyst role instead.", workday).kind, "interview");
});

// ---------- Regressions from the third adversarial pass ----------

test("adversarial 3: a confirmation's 'we regret we can't reply to candidates who weren't selected' is still a confirmation", () => {
  const monzo = sender("Monzo <no-reply@us.greenhouse-mail.io>");
  for (const line of [
    "Due to the high volume of applications we receive, we regret that we are unable to provide feedback to candidates who were not selected for interview.",
    "We regret that we cannot respond individually to applicants who have not been selected for the next stage.",
    "Unfortunately, due to the number of applications, we are unable to give feedback to applicants who were unsuccessful at the screening stage.",
    "Unfortunately, due to the high volume of applications, only selected candidates who meet the requirements will be contacted.",
    "We regret that only shortlisted candidates will be contacted.",
  ]) {
    assert.deepEqual(classify("Thank you for applying to Monzo", `Hi Sam,\n\nThank you for applying for the Data Analyst role at Monzo. We've received your application and our team will review it carefully.\n\n${line}\n\nMonzo Talent Team`, monzo), { kind: "confirmation", confident: true }, line);
  }
  for (const line of ["Unfortunately, we have selected candidates whose experience more closely matches our needs.", "Regrettably, we will be progressing with candidates who more closely match the role."]) {
    assert.deepEqual(classify("Your application", `Thank you for applying to Monzo. ${line}`, monzo), { kind: "rejection", confident: true }, line);
  }
});

test("adversarial 3: 'as the next step, we invite you to join / connect…' is an interview invitation", () => {
  for (const line of [
    "As the next step in our hiring process, we invite you to join a 30-minute video interview with our recruiting team.",
    "We are excited to invite you to join us for the next step in our interview process.",
    "As the next step in our hiring process, we'd love for you to connect with our hiring manager for a 30-minute call.",
    "As the next step in the hiring process, we invite you to connect with our hiring manager for a 30-minute introductory conversation.",
  ]) {
    assert.deepEqual(classify("Strategic Finance Manager - Next Steps", `Hi Naren,\n\nThank you for applying to the Strategic Finance Manager role at Stripe. ${line}\n\nStripe Recruiting`, gh), { kind: "interview", confident: false }, line);
  }
  assert.deepEqual(classify("Thank you for applying", "Thank you for applying. We have received your application. We also invite you to connect with us on LinkedIn.", gh), { kind: "confirmation", confident: true });
});

test("adversarial 3: '<title>, <team> - <city>, <state>' is the team's job, not the plain title", () => {
  const both: Candidate[] = [
    { id: 180, stage: "applied", company: "Toast", title: "Senior Financial Analyst", domains: ["toasttab.com"] },
    { id: 181, stage: "found", company: "Toast", title: "Senior Financial Analyst, Revenue", domains: ["toasttab.com"] },
  ];
  const icims = sender("Toast Talent Acquisition <toast+autoreply@talent.icims.com>");
  const e = { sender: icims, subject: "Your application for Senior Financial Analyst, Revenue - Boston, MA", body: "Thank you for your interest in the Senior Financial Analyst, Revenue - Boston, MA position at Toast. After careful review, we have decided to move forward with other candidates." };
  assert.deepEqual([matchEmail(e, both).applicationId, matchEmail(e, both).matchedBy], [181, "title"]);
  assert.notEqual(matchEmail(e, both.slice(0, 1)).matchedBy, "title");
  const li = matchEmail({ sender: sender("LinkedIn <jobs-noreply@linkedin.com>"), subject: "Naren, your application was sent to Toast", body: "Your application was sent to Toast\n\nSenior Financial Analyst, Revenue - Boston, MA\nToast · Boston, MA (Hybrid)" }, both.slice(0, 1));
  assert.notEqual(li.matchedBy, "title");
  for (const subject of ["Senior Financial Analyst - Boston, MA", "Senior Financial Analyst - Salt Lake City, UT", "Senior Financial Analyst - Winston-Salem, NC", "Senior Financial Analyst (R-251234)", "Senior Financial Analyst (JR-0012345)", "Senior Financial Analyst - Full Time", "Senior Financial Analyst - New York Metro", "Senior Financial Analyst - San Francisco HQ"]) {
    assert.equal(matchEmail({ sender: icims, subject, body: "Thanks for applying." }, both.slice(0, 1)).matchedBy, "title", subject);
  }
  // A part-time requisition is its own job.
  for (const subject of ["Senior Financial Analyst (Part-Time)", "Senior Financial Analyst - Part Time"]) {
    assert.notEqual(matchEmail({ sender: icims, subject, body: "Thanks for applying." }, both.slice(0, 1)).matchedBy, "title", subject);
  }
});

test("adversarial 3: a recruiter calling off one slot isn't rejecting you; 'at another time' still is", () => {
  const person = sender("Priya Patel <priya.patel@shopify.com>");
  for (const body of [
    "I'm so sorry for the late notice, but we won't be able to move forward with tomorrow's phone screen. Jordan is out sick. I'll send over some new times later this week.",
    "The hiring manager is out sick, so we won't be able to move forward with Thursday's interview. I'll reach out early next week with a couple of new dates.",
    "Unfortunately the hiring manager is out sick, so we're unable to move forward with today's call. Would another day next week work?",
    "Unfortunately we can't move forward with the phone screen at 2pm today, as the hiring manager has a conflict. We'll need to move it to a different day this week.",
  ]) {
    assert.notEqual(classify("Re: Data Scientist interview", body, person).kind, "rejection", body);
  }
  for (const tail of ["Perhaps our paths will cross at another time.", "We hope to work with you at another time."]) {
    assert.deepEqual(classify("Your application", `Unfortunately, we have decided not to move forward with your application. ${tail}`, gh), { kind: "rejection", confident: true }, tail);
  }
});

test("adversarial 3: 'not in a position to offer you the role' is a rejection; real offers stay offers", () => {
  for (const line of [
    "Unfortunately, we have decided to move forward with other candidates and are not in a position to offer you the role at this time.",
    "We have decided not to move forward with your application. We are not going to offer you the position at this time.",
    "Unfortunately, we have decided to move forward with other candidates. We'd love to have you join us as a member of our Talent Community.",
  ]) {
    assert.deepEqual(classify("Your application for Backend Engineer at Stripe", `Thank you for your interest in the Backend Engineer role at Stripe. ${line}`, gh), { kind: "rejection", confident: true }, line);
  }
  assert.equal(classify("Next steps", "It is my pleasure to offer you an interview with our team next week.", gh).kind, "interview");
  for (const line of ["We would like to offer you the position of Backend Engineer.", "I know waiting is not fun, so I'm thrilled to finally offer you the role!", "We are pleased to offer you employment with Stripe."]) {
    assert.equal(classify("Great news", line, gh).kind, "offer", line);
  }
});

test("adversarial 3: a rejection with an 'if you received this in error' footer, or a filled position, closes on its own", () => {
  const workday = sender("Target <target@myworkday.com>");
  assert.deepEqual(classify("Senior Data Analyst - Application Update", "Thank you for your interest in the Senior Data Analyst position at Target. After careful review, we have decided to move forward with other candidates whose qualifications more closely match our needs.\n\nThis is an automated message. If you received this email in error, please disregard it.", workday), { kind: "rejection", confident: true });
  assert.deepEqual(classify("Application Status", "Unfortunately, the position has been filled. Your application for this position is no longer under consideration. If you believe you have received this message by mistake, please disregard.", workday), { kind: "rejection", confident: true });
  assert.deepEqual(classify("Application Status", "We wanted to let you know that this position has been filled and we are no longer accepting applications. Unfortunately, we will not be moving forward with your application.", workday), { kind: "rejection", confident: true });
  // A correction is still only a guess.
  assert.equal(classify("Correction", "Please disregard our previous email, which was sent in error. Unfortunately, we are unable to move forward with that message's contents.", workday).confident, false);
});

test("adversarial 3: another employer's notice, bank mailings and job-board subjects are read for who sent them", () => {
  // Another employer's Workday notice shown as "Workday" isn't about your Workday application.
  const wd: Candidate[] = [{ id: 190, stage: "applied", company: "Workday", title: "Senior Financial Analyst", domains: [] }];
  const athene = matchEmail({ sender: sender("Workday <athene@myworkday.com>"), subject: "Update on your application for Senior Financial Analyst", body: "Thank you for your interest in the Senior Financial Analyst position at Athene. After careful consideration, we have decided to move forward with other candidates." }, wd);
  assert.notEqual(athene.applicationId, 190);
  // A bank's own mailings aren't job mail, even with an application there.
  const kept = (raw: string, subject: string, body: string, list: Candidate[]) => {
    const e = { sender: sender(raw), subject, body };
    return isJobEmail(e, matchEmail(e, list));
  };
  assert.equal(kept("Capital One <capitalone@notification.capitalone.com>", "Naren, you're pre-approved for Venture X", "Good news, Naren! We're pleased to offer you the Capital One Venture X Rewards Credit Card with a $750 travel credit. Accept your offer by November 15.\n\nUnsubscribe | Privacy", [{ id: 191, stage: "applied", company: "Capital One", title: "Senior Financial Analyst", domains: [] }]), false);
  assert.equal(kept("SoFi <info@email.sofi.com>", "Your free career coaching session", "Hi Naren, as a SoFi member you get free career coaching. Book a time with a career coach to talk about your next role.\n\nUnsubscribe", [{ id: 192, stage: "applied", company: "SoFi", title: "Treasury Analyst", domains: ["sofi.com"] }]), false);
  assert.equal(kept("American Express <AmericanExpress@welcome.americanexpress.com>", "An exclusive invitation for Card Members", "Naren, we'd love to invite you to an exclusive dining event. Don't miss this opportunity to reserve your seat.\n\nUnsubscribe", [{ id: 193, stage: "applied", company: "American Express", title: "Senior Analyst", domains: [] }]), false);
  // A job board's "Your application to <company>" still vouches; a public agency's HR team is the agency.
  const stripe: Candidate[] = [{ id: 194, stage: "applied", company: "Stripe", title: "Strategic Finance Manager", domains: ["stripe.com"] }];
  assert.equal(matchEmail({ sender: sender("Glassdoor <noreply@glassdoor.com>"), subject: "Your application to Stripe 🎉", body: "Strategic Finance Manager\nStripe · San Francisco, CA" }, stripe).trusted, true);
  assert.equal(matchEmail({ sender: sender("LinkedIn <jobs-noreply@linkedin.com>"), subject: "Your application to Strategic Finance Manager at Stripe", body: "Your update from Stripe\n\nThank you for your interest in the Strategic Finance Manager position at Stripe." }, stripe).trusted, true);
  assert.equal(matchEmail({ sender: sender("Glassdoor <noreply@glassdoor.com>"), subject: "Your application to H&R Block", body: "Strategic Finance Manager\nH&R Block · Kansas City, MO" }, [{ ...stripe[0], company: "Block" }]).trusted, false);
  const austin: Candidate[] = [{ id: 195, stage: "applied", company: "City of Austin", title: "Budget Analyst", domains: [] }];
  assert.equal(matchEmail({ sender: sender("City of Austin Human Resources <noreply@governmentjobs.com>"), subject: "Budget Analyst", body: "Thank you for applying for the Budget Analyst position." }, austin).trusted, true);
});

// ---------- Regressions from the fourth adversarial pass ----------

test("adversarial 4: rejections that mention all applicants, qualified candidates or the volume of applications are rejections", () => {
  const workday = sender("Target <target@myworkday.com>");
  for (const line of [
    "After careful review of all applicants, we have decided to move forward with another candidate whose experience more closely aligns with the needs of the role.",
    "We received applications from many highly qualified candidates, and after careful consideration we have decided to move forward with a different candidate for this role.",
    "After interviewing our top candidates, we have decided to move forward with another candidate.",
    "We had many qualified candidates apply, and we have decided to move forward with another candidate.",
  ]) {
    assert.deepEqual(classify("Senior Data Analyst - Application Update", `Hi Naren,\n\nThank you for applying to the Senior Data Analyst position at Target. ${line}\n\nTarget Talent Acquisition`, workday), { kind: "rejection", confident: true }, line);
  }
  const monzo = sender("Monzo <no-reply@us.greenhouse-mail.io>");
  for (const line of [
    "We received a very high number of applications, and unfortunately on this occasion the hiring team has shortlisted candidates whose experience more closely matches the role.",
    "Unfortunately, due to the high volume of applications, the role is now closed and we are unable to provide individual feedback.",
  ]) {
    assert.notDeepEqual(classify("Your application to Monzo", `Thank you for your application for the Data Analyst role at Monzo. ${line}`, monzo), { kind: "confirmation", confident: true }, line);
  }
});

test("adversarial 4: an employer's recruiting mailbox asking for a call is kept despite an unsubscribe footer or product words", () => {
  const kept = (raw: string, subject: string, body: string, list: Candidate[]) => {
    const e = { sender: sender(raw), subject, body };
    return isJobEmail(e, matchEmail(e, list));
  };
  const rocket: Candidate[] = [{ id: 200, stage: "applied", company: "Rocket Mortgage", title: "Financial Analyst", domains: ["rocketmortgage.com"] }];
  assert.equal(kept("Rocket Mortgage Recruiting <recruiting@rocketmortgage.com>", "Next steps with Rocket Mortgage", "Hi Naren,\n\nThanks for your interest in joining Rocket Mortgage! I'd like to set up a 30-minute phone screen with you this week. Please let me know your availability on Thursday or Friday.\n\nBest,\nRocket Mortgage Recruiting", rocket), true);
  const stripe: Candidate[] = [{ id: 201, stage: "applied", company: "Stripe", title: "Strategic Finance Manager", domains: ["stripe.com"] }];
  assert.equal(kept("Stripe Recruiting <recruiting@stripe.com>", "Next steps with Stripe", "Hi Naren,\n\nThanks for your interest in Stripe! We'd love to set up a 30-minute call with our recruiting team. Please share your availability for this week.\n\nStripe Recruiting\n\nUnsubscribe | Privacy Policy", stripe), true);
  // The company's own marketing still isn't.
  assert.equal(kept("Rocket Mortgage <rocket@email.rocketmortgage.com>", "Talk to a Home Loan Expert", "Schedule a call with a Home Loan Expert to talk about your mortgage options.\n\nUnsubscribe", rocket), false);
});

test("adversarial 4: a correction of a mistaken rejection never closes the application", () => {
  for (const body of [
    "Yesterday you received an email letting you know that we would not be moving forward with your application for the Strategic Finance Manager role. That email was sent in error, and we apologize for any confusion it may have caused. Your recruiter will be in touch shortly with next steps.",
    "Yesterday we sent an email saying that we will not be moving forward with your application for the Strategic Finance Manager role. If you received this message, please disregard it. We apologize for the confusion.",
    "We recently sent you an email saying we had decided not to move forward with your application for the Strategic Finance Manager role. That email was sent in error, and we apologize for any confusion this may have caused.",
  ]) {
    assert.notDeepEqual(classify("Update on your application for Strategic Finance Manager", body, gh), { kind: "rejection", confident: true }, body);
  }
  // A rejection with an error footer still closes.
  for (const footer of ["If you have received this email in error, please notify the sender and delete it.", "If this email was sent to you in error, please disregard it."]) {
    assert.deepEqual(classify("Your application", `Unfortunately, we will not be moving forward with your application at this time.\n\n${footer}`, gh), { kind: "rejection", confident: true }, footer);
  }
});

test("adversarial 4: a part-time posting is its own job; offers with 'couldn't be happier' are offers", () => {
  const ft: Candidate[] = [{ id: 220, stage: "applied", company: "Chase", title: "Relationship Banker", domains: ["chase.com"] }];
  const wd = sender("Chase <chase@myworkday.com>");
  for (const subject of ["Relationship Banker - Part Time", "Relationship Banker (Part-Time)", "Part-Time Relationship Banker"]) {
    assert.notEqual(matchEmail({ sender: wd, subject, body: "Thanks for applying." }, ft).matchedBy, "title", subject);
  }
  assert.equal(matchEmail({ sender: wd, subject: "Relationship Banker - Full Time", body: "Thanks for applying." }, ft).matchedBy, "title");
  const both: Candidate[] = [...ft, { id: 221, stage: "applied", company: "Chase", title: "Relationship Banker - Part Time", domains: ["chase.com"] }];
  assert.equal(matchEmail({ sender: wd, subject: "Relationship Banker - Part Time", body: "Unfortunately, we have decided to move forward with other candidates." }, both).applicationId, 221);
  const person = sender("Priya Patel <priya.patel@stripe.com>");
  for (const line of ["The team loved meeting you, and we couldn't be happier to offer you the role!", "I didn't want to wait to call, so here it is in writing: we'd like to offer you the role!", "We know you didn't expect to hear back so soon, but we'd like to offer you the position!"]) {
    assert.equal(classify("Great news!", `Hi Naren,\n\n${line}\n\nPriya`, person).kind, "offer", line);
  }
  for (const line of ["After careful consideration, we have decided not to offer you the position.", "Unfortunately, we won't be able to offer you the position."]) {
    assert.equal(classify("Your application", `Thank you for interviewing with us. ${line}`, gh).kind, "rejection", line);
  }
  // A colleague covering your phone screen isn't a rejection; job boards name employers with "for" and "!" in them.
  for (const opener of ["Sadly", "Unfortunately"]) {
    assert.notEqual(classify("Re: phone screen", `${opener}, Jordan is out sick today, so we'll be going ahead with someone else from the team for your 2pm phone screen.`, person).kind, "rejection", opener);
  }
  assert.deepEqual(classify("Your application", "Thank you for applying. Unfortunately, we will be moving forward with someone else for this role.", gh), { kind: "rejection", confident: true });
  assert.deepEqual(classify("Your application", "Thank you for applying. Regrettably, on this occasion we will be moving forward with someone whose experience more closely matches the role.", gh), { kind: "rejection", confident: true });
  const hss: Candidate[] = [{ id: 222, stage: "applied", company: "Hospital for Special Surgery", title: "Financial Analyst", domains: [] }];
  assert.equal(matchEmail({ sender: sender("LinkedIn <jobs-noreply@linkedin.com>"), subject: "Naren, your application was sent to Hospital for Special Surgery", body: "Financial Analyst" }, hss).trusted, true);
});
