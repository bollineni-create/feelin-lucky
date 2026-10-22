import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameEmployer, normalizeCompanyName } from "./employer";

test("normalizeCompanyName drops punctuation and legal suffixes", () => {
  assert.equal(normalizeCompanyName("JPMorgan Chase & Co."), "jpmorganchase");
  assert.equal(normalizeCompanyName("J.P. Morgan"), "jpmorgan");
  assert.equal(normalizeCompanyName("Stripe, Inc."), "stripe");
});

test("isSameEmployer matches the current employer's variants only", () => {
  assert.ok(isSameEmployer("JPMorgan Chase", "JPMorgan Chase & Co."));
  assert.ok(isSameEmployer("JPMorgan Chase", "J.P. Morgan"));
  assert.ok(isSameEmployer("JPMorgan Chase", "JPMorganChase"));
  assert.ok(!isSameEmployer("JPMorgan Chase", "Morgan Stanley"));
  assert.ok(!isSameEmployer("JPMorgan Chase", "Chase Bank Holdings Ltd"));
  assert.ok(isSameEmployer("Stripe", "Stripe, Inc."));
  assert.ok(!isSameEmployer("GE", "General Electric"));
  assert.ok(!isSameEmployer(null, "Anything"));
  assert.ok(!isSameEmployer("JPMorgan Chase", null));
});
