// node --import tsx --test lib/*.test.ts   (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, companyAliases, companyDomain, emailStageMove, isJobEmail, matchEmail, parseSender, prefilter, type Candidate } from "./mail-rules";

const sender = parseSender;

test("parseSender reads names, quoted names and bare addresses", () => {
  assert.deepEqual(parseSender("Stripe Recruiting <no-reply@Stripe.com>"), { name: "Stripe Recruiting", address: "no-reply@stripe.com", domain: "stripe.com" });
  assert.deepEqual(parseSender('"Doe, Jane" <jane@x.io>'), { name: "Doe, Jane", address: "jane@x.io", domain: "x.io" });
  assert.deepEqual(parseSender("jobs@workday.com"), { name: null, address: "jobs@workday.com", domain: "workday.com" });
  assert.deepEqual(parseSender(""), { name: null, address: null, domain: null });
});

test("classify: confirmations", () => {
  const c = classify("Thank you for applying to Stripe", "Hi Naren,\nThank you for applying for the Strategic Finance Manager role. We'll review your application and be in touch. If your experience is a match, a recruiter will reach out to schedule an interview.");
  assert.deepEqual(c, { kind: "confirmation", confident: true });
  assert.deepEqual(classify("Naren, your application was sent to Plaid", "Your application was sent to Plaid. Corporate Development Associate."), { kind: "confirmation", confident: true });
  assert.deepEqual(classify("Application received", "We have received your application for Treasury Analyst. Should your background match, we may contact you."), { kind: "confirmation", confident: true });
});

test("classify: a confirmation that also asks for something is a guess, not recorded on its own", () => {
  const c = classify("Thanks for applying!", "Thanks for applying to Ramp. Please share your availability for a 30 minute call next week.");
  assert.equal(c.kind, "interview");
  assert.equal(c.confident, false);
  const generic = classify("Thank you for your application", "Thank you for your application. Our recruiting team will reach out to schedule interviews.");
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
  assert.deepEqual(classify("Application status update", "Your application is under review."), { kind: "update", confident: true });
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
    assert.deepEqual(classify(subject, body), { kind: "confirmation", confident: true }, subject);
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
