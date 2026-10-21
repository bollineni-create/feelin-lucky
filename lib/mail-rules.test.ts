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
