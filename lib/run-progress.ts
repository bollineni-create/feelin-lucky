import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./db";
import type { Run } from "@/db/schema";

/** What a run's own files say it has been doing: the script's log and Claude Code's transcript. */
export type RunProgress = {
  /** Last lines of logs/run-*.log (what the script printed). */
  logLines: string[];
  /** Tool calls seen in the transcript (a lower bound for a very large transcript). */
  toolCalls: number | null;
  toolCallsPartial: boolean;
  /** The agent's most recent tool call and the last text it wrote. */
  lastTool: string | null;
  lastText: string | null;
  /** When the transcript last grew. */
  lastEventAt: string | null;
  /**
   * Claude in Chrome's status in Claude Code's init event: "connected", "pending" (still connecting when the
   * session started; it usually connects on the first browser call), "failed", "missing" (not loaded), or null
   * (no init yet).
   */
  chrome: string | null;
  /** Browser tool calls that got a result, and ones answered "Browser extension is not connected". */
  browserOk: number;
  browserRefused: number;
  /** Browser tool calls Claude in Chrome refused on its site permissions, and the hosts it refused. */
  siteBlocked: number;
  siteBlockedHosts: string[];
};

const TAIL_BYTES = 512 * 1024;
const FULL_READ_LIMIT = 16 * 1024 * 1024;

function tail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function head(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = Math.min(bytes, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

type Content = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; input?: { url?: unknown } };
type Event = { type?: string; subtype?: string; mcp_servers?: { name?: string; status?: string }[]; message?: { content?: Content[] } };

const CHROME_TOOL = /^mcp__claude-in-chrome__/;
const NOT_CONNECTED = "Browser extension is not connected";
/**
 * How Claude in Chrome answers a call on a site its site permissions don't allow (a navigation or a page read).
 * The wording has varied between versions; these are the phrases seen so far.
 */
export const SITE_BLOCKED = /not an allowed domain|not allowed (?:by|for|on)|site permissions?|permission (?:denied|required|not granted)|blocked (?:by|domain|site)|domain is (?:not|blocked)/i;

/** The host of a URL a browser tool was called with, or null. */
export function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function* events(text: string): Generator<Event> {
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      yield JSON.parse(line) as Event;
    } catch {
      // A line cut off at the read boundary.
    }
  }
}

export const LOG_TAIL_LINES = 8;

/** The run's log path must be under logs/ (the script writes it; anything else isn't ours to read). */
function safeLogPath(p: string | null): string | null {
  if (!p) return null;
  const abs = path.resolve(ROOT, p);
  const logs = path.join(ROOT, "logs") + path.sep;
  return abs.startsWith(logs) && abs.endsWith(".log") ? abs : null;
}

export function runProgress(run: Pick<Run, "logPath">): RunProgress | null {
  const log = safeLogPath(run.logPath);
  if (!log) return null;
  const out: RunProgress = { logLines: [], toolCalls: null, toolCallsPartial: false, lastTool: null, lastText: null, lastEventAt: null, chrome: null, browserOk: 0, browserRefused: 0, siteBlocked: 0, siteBlockedHosts: [] };
  try {
    out.logLines = tail(log, 64 * 1024)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-LOG_TAIL_LINES);
  } catch {
    return null;
  }

  const transcript = log.replace(/\.log$/, ".jsonl");
  let size: number;
  try {
    const st = fs.statSync(transcript);
    size = st.size;
    out.lastEventAt = st.mtime.toISOString();
  } catch {
    return out;
  }
  if (size === 0) return out;
  try {
    for (const e of events(head(transcript, 256 * 1024))) {
      if (e.type === "system" && e.subtype === "init") {
        out.chrome = e.mcp_servers?.find((m) => m.name === "claude-in-chrome")?.status ?? "missing";
        break;
      }
    }
    const partial = size > FULL_READ_LIMIT;
    const text = partial ? tail(transcript, TAIL_BYTES) : fs.readFileSync(transcript, "utf8");
    let calls = 0;
    // Browser tool calls by id (with the host each was aimed at, when it had a URL), so their results say
    // whether the extension is actually answering, and which sites it refuses.
    const browserCalls = new Map<string, string | null>();
    const blockedHosts = new Set<string>();
    for (const e of events(text)) {
      if (e.type === "assistant") {
        for (const c of e.message?.content ?? []) {
          if (c.type === "tool_use" && c.name) {
            calls++;
            out.lastTool = c.name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");
            if (CHROME_TOOL.test(c.name) && c.id) browserCalls.set(c.id, hostOf(c.input?.url));
          } else if (c.type === "text" && c.text?.trim()) {
            out.lastText = c.text.trim().slice(0, 240);
          }
        }
      } else if (e.type === "user") {
        for (const c of e.message?.content ?? []) {
          if (c.type !== "tool_result") continue;
          const result = JSON.stringify(c.content ?? "");
          const browser = c.tool_use_id ? browserCalls.has(c.tool_use_id) : false;
          if (result.includes(NOT_CONNECTED)) out.browserRefused++;
          else if (browser && SITE_BLOCKED.test(result)) {
            out.siteBlocked++;
            const host = browserCalls.get(c.tool_use_id!);
            if (host) blockedHosts.add(host);
          } else if (browser && !c.is_error) out.browserOk++;
        }
      }
    }
    out.toolCalls = calls;
    out.toolCallsPartial = partial;
    out.siteBlockedHosts = [...blockedHosts].sort();
  } catch {
    // Unreadable transcript; the log lines still say something.
  }
  return out;
}

/** One line for the run log: what the agent is doing now, or why it has nothing to show. */
export function progressLine(p: RunProgress, running: boolean): string {
  if (p.chrome === null && p.toolCalls === null) {
    return running ? "Claude Code hasn't written anything yet. If this stays for more than a minute or two, see the log below." : "";
  }
  const parts: string[] = [];
  const refused = `${p.browserRefused} browser call${p.browserRefused === 1 ? "" : "s"} answered "not connected"`;
  if (p.chrome === "missing") parts.push("Claude in Chrome wasn't loaded, so the agent has no browser tools (see the error)");
  else if (p.browserOk > 0) {
    // The extension answered, whatever the init event said; only a later drop is worth a word.
    if (p.browserRefused > 0) parts.push(`Claude in Chrome: ${refused}`);
  } else if (p.browserRefused > 0) parts.push(`Claude in Chrome isn't answering (${refused})`);
  else if (p.chrome === "pending") parts.push("Claude in Chrome: still connecting (the first browser call waits for it)");
  else if (p.chrome && p.chrome !== "connected") parts.push(`Claude in Chrome: ${p.chrome}`);
  if (p.siteBlocked > 0) parts.push(siteBlockedLine(p));
  if (p.toolCalls != null) {
    parts.push(`${p.toolCalls}${p.toolCallsPartial ? "+" : ""} tool call${p.toolCalls === 1 ? "" : "s"}`);
    if (p.lastTool) parts.push(`last: ${p.lastTool}`);
  }
  return parts.join(" · ");
}

/** One line on the sites Claude in Chrome refused, and the one setting that usually fixes all of them at once. */
export function siteBlockedLine(p: RunProgress): string {
  const hosts = p.siteBlockedHosts;
  const shown = hosts.slice(0, 6).join(", ") + (hosts.length > 6 ? ` and ${hosts.length - 6} more` : "");
  const calls = `${p.siteBlocked} browser call${p.siteBlocked === 1 ? "" : "s"}`;
  const fix =
    hosts.length >= 3
      ? "the extension is only allowed on some sites; give Claude in Chrome access to all sites (chrome://extensions → Claude → Site access) and allow sites in its own settings without asking each time"
      : "allow the site in the extension's site permissions, or point the company at a job board it can reach";
  return `Claude in Chrome's site permissions refused ${calls}${shown ? ` on ${shown}` : ""}: ${fix}`;
}
