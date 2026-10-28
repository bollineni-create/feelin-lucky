import { test } from "node:test";
import assert from "node:assert/strict";
import { portalHost, splitSigninWaits } from "./signin";

const now = new Date("2026-10-28T12:00:00Z");
const app = (id: number, url: string, needsSignin = false, signinCheckedAt: string | null = null, companyName = "Acme") => ({
  id,
  needsSignin,
  signinCheckedAt,
  job: { url, companyName },
});

test("portalHost groups by tenant host and folds LinkedIn", () => {
  assert.equal(portalHost("https://jpmc.wd5.myworkdayjobs.com/x/job/1", "JPMorgan"), "jpmc.wd5.myworkdayjobs.com");
  assert.equal(portalHost("https://www.linkedin.com/jobs/view/1", "Acme"), "linkedin.com");
  assert.equal(portalHost(null, " Brex "), "brex");
});

test("unflagged items all go out; one flagged item per portal goes out", () => {
  const items = [app(1, "https://boards.greenhouse.io/a/1"), app(2, "https://a.wd1.myworkdayjobs.com/1", true), app(3, "https://a.wd1.myworkdayjobs.com/2", true), app(4, "https://b.wd1.myworkdayjobs.com/1", true)];
  const { toSubmit, waiting } = splitSigninWaits(items, now);
  assert.deepEqual(toSubmit.map((a) => a.id), [1, 2, 4]);
  assert.deepEqual(waiting.map((w) => [w.portal_host, w.count, w.recheck_after]), [["a.wd1.myworkdayjobs.com", 1, null]]);
});

test("a portal checked within the last few days waits whole", () => {
  const recent = "2026-10-27T12:00:00Z";
  const old = "2026-10-20T12:00:00Z";
  const items = [app(1, "https://a.wd1.myworkdayjobs.com/1", true, recent), app(2, "https://a.wd1.myworkdayjobs.com/2", true, null), app(3, "https://b.wd1.myworkdayjobs.com/1", true, old)];
  const { toSubmit, waiting } = splitSigninWaits(items, now);
  assert.deepEqual(toSubmit.map((a) => a.id), [3]);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].count, 2);
  assert.equal(waiting[0].recheck_after, "2026-10-30T12:00:00.000Z");
});
