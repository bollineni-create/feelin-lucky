import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatcher, detectBoard, fetchBoard, htmlToText, titlePhrases, workdayPostedOn, type Fetcher } from "./feed-boards";

const CRITERIA = {
  functions: ["Corporate development", "Strategy & operations", "Strategic finance", "Treasury / payments", "Corporate & commercial banking", "Fintech product", "Fintech partnerships"],
  primaryLocations: ["Seattle, WA", "Boston, MA"],
  secondaryLocations: ["Los Angeles, CA", "Chicago, IL", "Washington, DC"],
  workModes: ["remote", "hybrid", "onsite"],
};

test("detectBoard reads the board and company token from a careers URL", () => {
  assert.deepEqual(detectBoard("https://boards.greenhouse.io/stripe"), { kind: "greenhouse", token: "stripe" });
  assert.deepEqual(detectBoard("https://job-boards.greenhouse.io/ramp/jobs/123"), { kind: "greenhouse", token: "ramp" });
  assert.deepEqual(detectBoard("https://boards.greenhouse.io/embed/job_board?for=brex"), { kind: "greenhouse", token: "brex" });
  assert.deepEqual(detectBoard("https://jobs.lever.co/plaid"), { kind: "lever", token: "plaid", eu: false });
  assert.deepEqual(detectBoard("https://jobs.eu.lever.co/monzo/"), { kind: "lever", token: "monzo", eu: true });
  assert.deepEqual(detectBoard("https://jobs.ashbyhq.com/mercury"), { kind: "ashby", token: "mercury" });
  assert.deepEqual(detectBoard("https://jobs.smartrecruiters.com/Visa"), { kind: "smartrecruiters", token: "Visa" });
  assert.deepEqual(detectBoard("https://jpmc.wd5.myworkdayjobs.com/en-US/External"), { kind: "workday", host: "jpmc.wd5.myworkdayjobs.com", tenant: "jpmc", site: "External" });
  assert.deepEqual(detectBoard("https://amex.wd1.myworkdayjobs.com/AmexCareers/job/Phoenix/Analyst_R1"), { kind: "workday", host: "amex.wd1.myworkdayjobs.com", tenant: "amex", site: "AmexCareers" });
  assert.equal(detectBoard("https://stripe.com/jobs"), null);
  assert.equal(detectBoard("https://jpmc.wd5.myworkdayjobs.com/"), null);
  assert.equal(detectBoard(null), null);
  assert.equal(detectBoard("not a url"), null);
});

test("htmlToText decodes Greenhouse's escaped HTML into readable text", () => {
  const html = "&lt;p&gt;Own &amp;amp; run treasury.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Cash&lt;/li&gt;&lt;li&gt;FX&lt;/li&gt;&lt;/ul&gt;";
  assert.equal(htmlToText(html), "Own & run treasury.\n• Cash\n• FX");
  assert.equal(htmlToText(""), null);
  assert.equal(htmlToText("<p>" + "x".repeat(50) + "</p>", 10), "xxxxxxxxxx…");
});

test("workdayPostedOn turns relative dates into days", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  assert.equal(workdayPostedOn("Posted Today", now), "2026-11-15");
  assert.equal(workdayPostedOn("Posted Yesterday", now), "2026-11-14");
  assert.equal(workdayPostedOn("Posted 3 Days Ago", now), "2026-11-12");
  assert.equal(workdayPostedOn("Posted 30+ Days Ago", now), "2026-10-16");
  assert.equal(workdayPostedOn(undefined, now), null);
});

test("the matcher keeps the user's functions in the user's places and drops the rest", () => {
  const m = buildMatcher(CRITERIA);
  assert.ok(titlePhrases(CRITERIA.functions).includes("treasury"));
  const keep = (title: string, location: string | null, workMode: "remote" | "hybrid" | "onsite" | null = null) => m.keep({ title, location, workMode });
  // Functions, by their usual titles.
  assert.ok(keep("Senior Treasury Analyst", "Seattle, WA"));
  assert.ok(keep("Manager, Corporate Development", "Boston, MA"));
  assert.ok(keep("Strategic Finance Lead", "Remote - US", "remote"));
  assert.ok(keep("FP&A Manager", "Chicago, IL"));
  assert.ok(keep("Product Manager, Payments", "Los Angeles, CA"));
  assert.ok(keep("Partnerships Manager", null));
  assert.ok(keep("Business Operations Associate", "Multiple Locations"));
  // Not the user's function, or a title that only shares a word with it.
  assert.ok(!keep("Software Engineer, Payments", "Seattle, WA"));
  assert.ok(!keep("Treasury Intern", "Seattle, WA"));
  assert.ok(!keep("Account Executive", "Seattle, WA"));
  assert.ok(!keep("Recruiter, Finance", "Boston, MA"));
  // Places the user doesn't take.
  assert.ok(!keep("Treasury Manager", "London, UK"));
  assert.ok(!keep("Treasury Manager", "Austin, TX"));
  assert.ok(!keep("Strategic Finance Manager", "Remote - Canada", "remote"));
  assert.ok(keep("Strategic Finance Manager", "Remote (US or Canada)", "remote"));
  assert.ok(!keep("Treasury Manager", "Dublin, Ireland"));
  // High-priority companies: anywhere in the US, never abroad.
  assert.ok(m.keepAnywhereInUS({ title: "Treasury Analyst", location: "Hawthorne, CA", workMode: null }));
  assert.ok(m.keepAnywhereInUS({ title: "Treasury Analyst", location: "New York, NY / London, UK", workMode: null }));
  assert.ok(!m.keepAnywhereInUS({ title: "Treasury Analyst", location: "London, UK", workMode: null }));
  assert.ok(!m.keepAnywhereInUS({ title: "Associate, Financial Planning & Analysis", location: "Edinburgh, Scotland", workMode: null }));
  assert.ok(!m.keepAnywhereInUS({ title: "Software Engineer, Treasury", location: "Hawthorne, CA", workMode: null }));
  // No remote in the criteria: remote postings drop.
  const onsiteOnly = buildMatcher({ ...CRITERIA, workModes: ["onsite"] });
  assert.ok(!onsiteOnly.keep({ title: "Treasury Manager", location: "Remote", workMode: "remote" }));
  assert.ok(onsiteOnly.keep({ title: "Treasury Manager", location: "Seattle, WA", workMode: null }));
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("fetchBoard reads Greenhouse, Lever, Ashby and SmartRecruiters into one shape", async () => {
  const m = buildMatcher(CRITERIA);
  const fetcher: Fetcher = async (url) => {
    if (url.includes("boards-api.greenhouse.io/v1/boards/stripe/jobs"))
      return json({
        jobs: [
          { id: 11, title: "Treasury Manager", first_published: "2026-11-10T08:00:00Z", location: { name: "Seattle, WA" }, absolute_url: "https://stripe.com/jobs/11", content: "&lt;p&gt;Run treasury.&lt;/p&gt;" },
          { id: 12, title: "Backend Engineer", location: { name: "Seattle, WA" }, absolute_url: "https://stripe.com/jobs/12" },
        ],
      });
    if (url.includes("api.lever.co/v0/postings/plaid"))
      return json([
        { id: "a1", text: "Corporate Development Associate", hostedUrl: "https://jobs.lever.co/plaid/a1", createdAt: Date.parse("2026-11-01"), workplaceType: "hybrid", categories: { location: "Boston, MA" }, descriptionPlain: "Do deals.", salaryRange: { min: 140000, max: 170000, interval: "per-year-salary" } },
      ]);
    if (url.includes("api.ashbyhq.com/posting-api/job-board/mercury"))
      return json({
        jobs: [
          { id: "x", title: "Strategic Finance Lead", location: "Remote", isRemote: true, workplaceType: "Remote", jobUrl: "https://jobs.ashbyhq.com/mercury/x", publishedAt: "2026-11-12", descriptionPlain: "Model.", compensation: { compensationTierSummary: "$160K – $190K" } },
          { id: "y", title: "Unlisted Treasury Role", location: "Remote", isListed: false, jobUrl: "https://jobs.ashbyhq.com/mercury/y" },
        ],
      });
    if (url.includes("api.smartrecruiters.com/v1/companies/Visa/postings"))
      return json({ totalFound: 1, content: [{ id: "s1", name: "Payments Strategy Manager", releasedDate: "2026-11-05T00:00:00Z", location: { city: "Washington", region: "DC", country: "us" } }] });
    return json({}, 404);
  };

  const gh = await fetchBoard({ kind: "greenhouse", token: "stripe" }, m, fetcher);
  assert.equal(gh.seen, 2);
  assert.deepEqual(gh.kept.map((p) => [p.title, p.postedAt, p.description]), [["Treasury Manager", "2026-11-10", "Run treasury."]]);

  const lv = await fetchBoard({ kind: "lever", token: "plaid", eu: false }, m, fetcher);
  assert.equal(lv.kept[0].workMode, "hybrid");
  assert.equal(lv.kept[0].payText, "$140K–$170K per year salary");
  assert.equal(lv.kept[0].externalId, "lever:a1");

  const ab = await fetchBoard({ kind: "ashby", token: "mercury" }, m, fetcher);
  assert.equal(ab.seen, 1, "unlisted postings are left out");
  assert.equal(ab.kept[0].workMode, "remote");
  assert.equal(ab.kept[0].payText, "$160K – $190K");

  const sr = await fetchBoard({ kind: "smartrecruiters", token: "Visa" }, m, fetcher);
  assert.equal(sr.kept[0].url, "https://jobs.smartrecruiters.com/Visa/s1");
  assert.equal(sr.kept[0].location, "Washington, DC, US");

  await assert.rejects(fetchBoard({ kind: "greenhouse", token: "nobody" }, m, fetcher), /board not found/);
});

test("fetchBoard searches Workday by title keyword and reads details only for matches", async () => {
  const m = buildMatcher({ ...CRITERIA, functions: ["Treasury / payments"] });
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/wday/cxs/jpmc/External/jobs")) {
      const q = JSON.parse(String(init?.body)).searchText as string;
      if (q !== "treasury") return json({ total: 0, jobPostings: [] });
      return json({
        total: 3,
        jobPostings: [
          { title: "Treasury Services Associate", externalPath: "/job/Seattle/Treasury-Services-Associate_R1", locationsText: "Seattle, WA", postedOn: "Posted 2 Days Ago", bulletFields: ["R1"] },
          { title: "Treasury Associate", externalPath: "/job/London/Treasury-Associate_R2", locationsText: "London, UK", postedOn: "Posted Today", bulletFields: ["R2"] },
          { title: "Treasury Manager", externalPath: "/job/Multi/Treasury-Manager_R3", locationsText: "2 Locations", postedOn: "Posted Today", bulletFields: ["R3"] },
        ],
      });
    }
    if (url.endsWith("/wday/cxs/jpmc/External/job/Seattle/Treasury-Services-Associate_R1"))
      return json({ jobPostingInfo: { jobDescription: "<p>Cash management.</p>", startDate: "2026-11-13", jobReqId: "R1", externalUrl: "https://jpmc.wd5.myworkdayjobs.com/External/job/Seattle/Treasury-Services-Associate_R1" } });
    if (url.endsWith("/wday/cxs/jpmc/External/job/Multi/Treasury-Manager_R3"))
      return json({ jobPostingInfo: { jobDescription: "<p>EMEA cash.</p>", location: "London, UK", additionalLocations: ["Dublin, Ireland"], jobReqId: "R3" } });
    return json({}, 404);
  };
  const r = await fetchBoard({ kind: "workday", host: "jpmc.wd5.myworkdayjobs.com", tenant: "jpmc", site: "External" }, m, fetcher, new Date("2026-11-15T12:00:00Z"));
  assert.equal(r.kept.length, 1, "a '2 Locations' row whose details are all abroad is dropped");
  assert.equal(r.kept[0].description, "Cash management.");
  assert.equal(r.kept[0].postedAt, "2026-11-13");
  assert.equal(calls.filter((c) => c.startsWith("GET")).length, 2, "only the matches' details are fetched");
});
