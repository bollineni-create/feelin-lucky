// The run log's reading of Claude Code's transcript: which browser calls Claude in Chrome refused on its site
// permissions, and which hosts it refused, so the run log can say what to allow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProgress, hostsIn, hostsInRefusal, readTranscript, siteBlockedLine } from "./run-progress";

const call = (id: string, name: string, input: unknown) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__claude-in-chrome__${name}`, input }] } });
const answer = (id: string, text: string, isError = false) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] } });

test("hosts come from any URL in the call, batched actions included", () => {
  assert.deepEqual(hostsIn({ url: "https://www.lockheedmartinjobs.com/search-jobs" }), ["lockheedmartinjobs.com"]);
  assert.deepEqual(hostsIn({ actions: [{ type: "navigate", url: "https://careers.rtx.com/x" }, { type: "find", query: "jobs" }] }), ["careers.rtx.com"]);
  assert.deepEqual(hostsIn({ tabId: 3, query: "rtx.com" }), []);
});

test("the refusal's own wording names the host when the call had no URL", () => {
  assert.deepEqual(hostsInRefusal("rapid7.com is not an allowed domain for the Chrome extension"), ["rapid7.com"]);
  assert.deepEqual(hostsInRefusal('Site permissions: https://www.shopify.com/careers is blocked. Allow it at claude.ai/settings.'), ["shopify.com"]);
  assert.deepEqual(hostsInRefusal("Permission denied by the extension's site permissions."), []);
});

test("a transcript's refused calls are counted and their hosts listed", () => {
  const text = [
    call("a", "navigate", { url: "https://www.lockheedmartinjobs.com/" }),
    answer("a", "lockheedmartinjobs.com is not an allowed domain", true),
    call("b", "browser_batch", { actions: [{ type: "navigate", url: "https://careers.rtx.com/" }, { type: "get_page_text" }] }),
    answer("b", "Blocked by site permissions", true),
    call("c", "navigate", { url: "https://www.rapid7.com/careers" }),
    answer("c", "Navigated"),
    call("d", "get_page_text", { tabId: 7 }),
    answer("d", "rapid7.com is not an allowed domain for the Chrome extension", true),
    call("e", "navigate", { url: "https://jobs.lever.co/example" }),
    answer("e", "Navigated"),
  ].join("\n");
  const p = emptyProgress();
  readTranscript(text, p);
  assert.equal(p.toolCalls, 5);
  assert.equal(p.siteBlocked, 3);
  assert.equal(p.browserOk, 2);
  assert.deepEqual(p.siteBlockedHosts, ["careers.rtx.com", "lockheedmartinjobs.com", "rapid7.com"]);
  assert.match(siteBlockedLine(p), /refused 3 browser calls on careers\.rtx\.com, lockheedmartinjobs\.com, rapid7\.com: the extension is only allowed on some sites/);
});
