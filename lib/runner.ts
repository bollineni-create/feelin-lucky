import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { ROOT, db, schema } from "./db";
import { activeRun, iso, runProcess } from "./logic";

const LAUNCHER_LOG = path.join(ROOT, "logs", "launcher.log");
/** How long the script gets to create its run record (it does so right after checking the app answers). */
const START_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const newestRunId = () => db.select({ id: schema.runs.id }).from(schema.runs).orderBy(desc(schema.runs.id)).limit(1).get()?.id ?? 0;

const START_MARK = "starting scripts/daily-run.sh";

/** What this start's script wrote to logs/launcher.log (the lines after the last start marker). */
function launcherTail(lines = 4): string {
  try {
    const all = fs.readFileSync(LAUNCHER_LOG, "utf8").split("\n").filter((l) => l.trim() !== "");
    const from = all.map((l) => l.includes(START_MARK)).lastIndexOf(true);
    return all.slice(from + 1).slice(-lines).join(" ");
  } catch {
    return "";
  }
}

export const PHASES = ["submit", "scan", "search", "prepare", "track"] as const;

/**
 * The runs the app can start. The scan and the job search are separate runs (scripts/daily-run.sh --run):
 * scan is submit, scan the watchlist's careers sites, prepare and track; search is submit, the LinkedIn and
 * broad searches, and prepare.
 */
export type RunKind = "scan" | "search" | "submit";

/**
 * Starts scripts/daily-run.sh in the background, the same script launchd runs, and waits for it to create its
 * run record, so a script that stops before then (the app not answering, a lock held, no token) reports why
 * instead of leaving the button looking like it did nothing.
 */
export async function startAgentRun(kind: RunKind, trigger: "manual" | "submit-now"): Promise<{ ok: true; runId: number } | { ok: false; error: string }> {
  const running = activeRun();
  if (running) return { ok: false, error: `Run #${running.id} is still in progress.` };
  if (process.platform !== "darwin" && !process.env.JOBHUNT_ALLOW_NON_MAC) {
    return { ok: false, error: "Agent runs need Claude in Chrome on your Mac; this server is not running on macOS." };
  }
  const script = path.join(ROOT, "scripts", "daily-run.sh");
  if (!fs.existsSync(script)) return { ok: false, error: "scripts/daily-run.sh is missing." };

  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  const before = newestRunId();
  const out = fs.openSync(LAUNCHER_LOG, "a");
  fs.writeSync(out, `[${iso()}] ${START_MARK} --run ${kind} --trigger ${trigger}\n`);
  const child = spawn("/bin/bash", [script, "--run", kind, "--trigger", trigger], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? -1;
  });
  child.on("error", () => {
    exited = -1;
  });
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(500);
    const newest = newestRunId();
    if (newest > before) return { ok: true, runId: newest };
    if (exited !== null) break;
  }
  const said = launcherTail().replace(/\.$/, "");
  if (exited !== null) {
    return { ok: false, error: `The run script stopped before it started a run${said ? `: ${said}` : ""}. See logs/launcher.log.` };
  }
  return { ok: false, error: `The run script hasn't created a run after ${START_TIMEOUT_MS / 1000}s${said ? `: ${said}` : ""}. See logs/launcher.log.` };
}

/** Stops the run in progress. The script's signal trap stops Claude Code and marks the run failed. */
export function stopAgentRun(): { ok: true } | { ok: false; error: string } {
  const running = activeRun();
  if (!running) return { ok: false, error: "No run is in progress." };
  const proc = runProcess();
  if (proc) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch {
      // Gone already; closed below.
    }
  }
  // A script from before the signal trap leaves Claude Code running on its own; stop that too.
  try {
    execFileSync("pkill", ["-TERM", "-f", "running the daily job-hunt agent"]);
  } catch {
    // Nothing matched.
  }
  if (!proc) {
    db.update(schema.runs)
      .set({ status: "failed", finishedAt: iso(), errors: [...(running.errors ?? []), "Stopped from the app."] })
      .where(eq(schema.runs.id, running.id))
      .run();
  }
  return { ok: true };
}
