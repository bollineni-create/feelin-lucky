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
  /** Claude in Chrome's status in Claude Code's init event: "connected", "failed", "missing" (not loaded), or null (no init yet). */
  chrome: string | null;
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

type Event = { type?: string; subtype?: string; mcp_servers?: { name?: string; status?: string }[]; message?: { content?: { type?: string; name?: string; text?: string }[] } };

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
  const out: RunProgress = { logLines: [], toolCalls: null, toolCallsPartial: false, lastTool: null, lastText: null, lastEventAt: null, chrome: null };
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
    for (const e of events(text)) {
      if (e.type !== "assistant") continue;
      for (const c of e.message?.content ?? []) {
        if (c.type === "tool_use" && c.name) {
          calls++;
          out.lastTool = c.name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");
        } else if (c.type === "text" && c.text?.trim()) {
          out.lastText = c.text.trim().slice(0, 240);
        }
      }
    }
    out.toolCalls = calls;
    out.toolCallsPartial = partial;
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
  if (p.chrome === "missing") parts.push("Claude in Chrome wasn't loaded, so the agent has no browser tools (see the error)");
  else if (p.chrome && p.chrome !== "connected") parts.push(`Claude in Chrome: ${p.chrome}`);
  if (p.toolCalls != null) {
    parts.push(`${p.toolCalls}${p.toolCallsPartial ? "+" : ""} tool call${p.toolCalls === 1 ? "" : "s"}`);
    if (p.lastTool) parts.push(`last: ${p.lastTool}`);
  }
  return parts.join(" · ");
}
