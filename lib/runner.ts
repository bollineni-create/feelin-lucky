import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ROOT, db, schema } from "./db";
import { activeRun, iso, runProcess } from "./logic";

export const PHASES = ["submit", "find", "prepare", "track"] as const;

/** Starts scripts/daily-run.sh in the background, the same script launchd runs. */
export function startAgentRun(phase: string, trigger: "manual" | "submit-now"): { ok: true } | { ok: false; error: string } {
  const running = activeRun();
  if (running) return { ok: false, error: `Run #${running.id} is still in progress.` };
  if (process.platform !== "darwin" && !process.env.JOBHUNT_ALLOW_NON_MAC) {
    return { ok: false, error: "Agent runs need Claude in Chrome on your Mac; this server is not running on macOS." };
  }
  const script = path.join(ROOT, "scripts", "daily-run.sh");
  if (!fs.existsSync(script)) return { ok: false, error: "scripts/daily-run.sh is missing." };

  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  const out = fs.openSync(path.join(ROOT, "logs", "launcher.log"), "a");
  const child = spawn("/bin/bash", [script, "--phase", phase, "--trigger", trigger], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  return { ok: true };
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
