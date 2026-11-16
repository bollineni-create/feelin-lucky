import { test } from "node:test";
import assert from "node:assert/strict";
import { triageScore } from "./triage";

const c = { primaryLocations: ["Seattle, WA", "Boston, MA"], secondaryLocations: ["New York, NY"], workModes: ["remote", "hybrid", "onsite"], lookbackDays: 7 };
const now = new Date("2026-11-15T12:00:00Z");
const t = (title: string, extra: Partial<Parameters<typeof triageScore>[0]> = {}) =>
  triageScore({ title, location: "Seattle, WA", workMode: null, postedAt: "2026-11-12", priority: "normal", lookupId: null, ...extra }, c, now);

test("triage puts squarely-matching, right-level, nearby, fresh jobs first", () => {
  assert.ok(t("Treasury Manager") > t("Finance Manager"), "core function beats a broad match");
  assert.ok(t("Treasury Manager") > t("Director, Treasury"), "too senior ranks lower");
  assert.ok(t("Associate Director, Treasury") > t("Director, Treasury"));
  assert.ok(t("Partnerships Manager") > t("Partner, Strategy"), "'Partnerships' isn't a seniority");
  assert.ok(t("Treasury Analyst") > t("Treasury Intern"));
  assert.ok(t("Treasury Manager") > t("Treasury Manager", { location: "Austin, TX" }));
  assert.ok(t("Treasury Manager", { priority: "high" }) > t("Treasury Manager", { priority: null }));
  assert.ok(t("Treasury Manager") > t("Treasury Manager", { postedAt: "2026-08-01" }), "stale postings wait");
  assert.ok(t("Anything at all", { lookupId: 3 }) > t("Treasury Manager", { priority: "high" }), "what the user asked for goes first");
});
