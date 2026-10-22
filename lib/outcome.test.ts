import { test } from "node:test";
import assert from "node:assert/strict";
import { closedOutcome, closedReasonLabel, normalizeClosedReason } from "./outcome";

test("normalizeClosedReason folds the other words for the same reason into one", () => {
  assert.equal(normalizeClosedReason("rejected"), "rejected");
  assert.equal(normalizeClosedReason("Not selected"), "rejected");
  assert.equal(normalizeClosedReason("withdrawn"), "declined");
  assert.equal(normalizeClosedReason("Didn't take"), "declined");
  assert.equal(normalizeClosedReason("declined offer"), "declined");
  assert.equal(normalizeClosedReason("posting-closed"), "posting_closed");
  assert.equal(normalizeClosedReason("role filled"), "role_filled");
  assert.equal(normalizeClosedReason("  "), null);
  assert.equal(normalizeClosedReason(null), null);
});

test("closedOutcome sorts closed applications into rejected, not taken, never pursued and the rest", () => {
  assert.equal(closedOutcome({ stage: "closed", closedReason: "rejected" }), "rejected");
  assert.equal(closedOutcome({ stage: "closed", closedReason: "withdrawn" }), "declined");
  assert.equal(closedOutcome({ stage: "closed", closedReason: "declined" }), "declined");
  assert.equal(closedOutcome({ stage: "closed", closedReason: "skipped" }), "not_pursued");
  assert.equal(closedOutcome({ stage: "closed", closedReason: "low_fit" }), "not_pursued");
  assert.equal(closedOutcome({ stage: "closed", closedReason: "posting_closed" }), "other");
  assert.equal(closedOutcome({ stage: "closed", closedReason: null }), "other");
  assert.equal(closedOutcome({ stage: "interviewing", closedReason: null }), null);
});

test("closedReasonLabel reads known reasons in words and keeps unknown ones", () => {
  assert.equal(closedReasonLabel("withdrawn"), "You didn't take it");
  assert.equal(closedReasonLabel("posting_closed"), "Posting closed");
  assert.equal(closedReasonLabel("role_filled"), "Role filled");
  assert.equal(closedReasonLabel(null), "Closed");
});
