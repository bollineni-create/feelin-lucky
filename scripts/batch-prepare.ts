// Scores found jobs and writes their materials through the Anthropic Message Batches API (half price, paid from
// Console credits), so the daily Chrome run (claude.ai plan) only has to find jobs and track them.
//
//   npm run batch -- score        submit every unscored job that has a stored description
//   npm run batch -- materials    submit every scored job that still needs materials
//   npm run batch -- collect      record the results of finished batches (safe to run any time)
//   npm run batch -- auto         score → wait → collect → materials → wait → collect
//   npm run batch -- status       list submitted batches
//
// API key: LODESTAR_ANTHROPIC_KEY in .env, else the macOS Keychain item "lodestar-anthropic"
//   (security add-generic-password -s lodestar-anthropic -a anthropic -w <key>).
// Deliberately not ANTHROPIC_API_KEY: that one would switch Claude Code off the claude.ai sign-in Claude in Chrome needs.
// Optional: LODESTAR_BATCH_MAX (jobs per batch, default 500), LODESTAR_LOCAL_MODEL_URL + LODESTAR_LOCAL_MODEL
//   (an OpenAI-compatible local server such as Ollama) to drop clear non-matches before they reach the batch.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { MATERIALS_MODEL, SCORE_MODEL, batchRequest, jobBlock, materialsSystem, parseMaterials, parseScore, resultText, scoreSystem, type Ctx, type JobDetail } from "../lib/batch";

const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "data", "batches");
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3000";
const MAX_JOBS = Number(process.env.LODESTAR_BATCH_MAX ?? 500) || 500;
const API = "https://api.anthropic.com/v1/messages/batches";

loadEnv();

function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function apiKey(): string {
  if (process.env.LODESTAR_ANTHROPIC_KEY) return process.env.LODESTAR_ANTHROPIC_KEY;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "lodestar-anthropic", "-w"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error('No API key. Add one: security add-generic-password -s lodestar-anthropic -a anthropic -w "sk-ant-..."');
  }
}

async function app<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(APP_URL + p, {
    method,
    headers: { Authorization: `Bearer ${process.env.AGENT_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function anthropicText(url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { "x-api-key": apiKey(), "anthropic-version": "2023-06-01", "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  return text;
}
async function anthropic<T>(url: string, init: RequestInit = {}): Promise<T> {
  return JSON.parse(await anthropicText(url, init)) as T;
}

type Kind = "score" | "materials";
type Saved = { id: string; kind: Kind; created_at: string; jobs: Record<string, JobDetail>; collected?: boolean };

function save(s: Saved) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, `${s.id}.json`), JSON.stringify(s, null, 1));
}
function saved(): Saved[] {
  if (!fs.existsSync(STATE_DIR)) return [];
  return fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), "utf8")) as Saved);
}
/** Jobs already in a batch that hasn't been collected, so a second submit doesn't pay for them twice. */
function pendingJobIds(kind: Kind): Set<number> {
  return new Set(saved().filter((s) => s.kind === kind && !s.collected).flatMap((s) => Object.values(s.jobs).map((j) => j.job_id)));
}

type ContextOut = Ctx & {
  jobs_needing_score: { job_id: number; watchlist: string; has_description: boolean }[];
  jobs_needing_materials: { job_id: number; watchlist: string; fit_reasons: string[] | null }[];
};

async function detail(jobId: number, extra: Partial<JobDetail>): Promise<JobDetail> {
  const j = await app<JobDetail>("GET", `/api/agent/jobs/${jobId}`);
  return { ...j, ...extra };
}

/** Optional local pre-filter. Only a clear non-match (local score under 30) is dropped; everything else goes on. */
async function localReject(ctx: Ctx, j: JobDetail): Promise<{ fit_score: number; fit_reasons: string[] } | null> {
  const url = process.env.LODESTAR_LOCAL_MODEL_URL;
  const model = process.env.LODESTAR_LOCAL_MODEL;
  if (!url || !model) return null;
  try {
    const res = await fetch(url.replace(/\/$/, "") + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: scoreSystem(ctx) }, { role: "user", content: jobBlock(j) }] }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const out = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const s = parseScore(out.choices?.[0]?.message?.content ?? "");
    if (s.fit_score >= 30) return null;
    return { fit_score: s.fit_score, fit_reasons: [`Quick local check: ${s.fit_reasons[0] ?? "clear mismatch"}`, ...s.fit_reasons.slice(1, 3)] };
  } catch {
    return null; // The local model is a saving, never a gate: on any trouble the job goes to the batch.
  }
}

async function postScores(rows: { j: JobDetail; s: { fit_score: number; fit_reasons: string[] } }[]) {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map(({ j, s }) => ({
      company: j.company,
      title: j.title,
      location: j.location,
      source: j.source === "linkedin" ? "linkedin" : "careers",
      url: j.url,
      fit_score: s.fit_score,
      fit_reasons: s.fit_reasons.slice(0, 5),
    }));
    await app("POST", "/api/agent/jobs", { jobs: chunk });
  }
}

async function submit(kind: Kind): Promise<string | null> {
  const ctx = await app<ContextOut>("GET", "/api/agent/context?for=batch&score_limit=500&companies_limit=1&recheck_limit=1");
  const pending = pendingJobIds(kind);
  const candidates =
    kind === "score"
      ? ctx.jobs_needing_score.filter((j) => j.has_description).map((j) => ({ job_id: j.job_id, watchlist: j.watchlist }))
      : ctx.jobs_needing_materials.map((j) => ({ job_id: j.job_id, watchlist: j.watchlist, fit_reasons: j.fit_reasons }));
  const todo = candidates.filter((j) => !pending.has(j.job_id)).slice(0, MAX_JOBS);
  if (!todo.length) {
    console.log(`${kind}: nothing to submit.`);
    return null;
  }

  const system = kind === "score" ? scoreSystem(ctx) : materialsSystem(ctx);
  const jobs: Record<string, JobDetail> = {};
  const requests = [];
  const localDrops: { j: JobDetail; s: { fit_score: number; fit_reasons: string[] } }[] = [];
  for (const c of todo) {
    const j = await detail(c.job_id, c);
    if (!j.description || j.description.length < 200) continue; // too thin: the Chrome run opens the posting instead
    if (kind === "score") {
      const drop = await localReject(ctx, j);
      if (drop) {
        localDrops.push({ j, s: drop });
        continue;
      }
    }
    const id = `${kind}-${j.job_id}`;
    jobs[id] = j;
    requests.push(
      kind === "score"
        ? batchRequest(id, SCORE_MODEL, system, jobBlock(j), 400)
        : batchRequest(id, MATERIALS_MODEL, system, jobBlock(j), 4000),
    );
  }
  if (localDrops.length) {
    await postScores(localDrops);
    console.log(`${kind}: the local model closed ${localDrops.length} clear non-matches.`);
  }
  if (!requests.length) {
    console.log(`${kind}: nothing left to submit.`);
    return null;
  }
  const batch = await anthropic<{ id: string }>(API, { method: "POST", body: JSON.stringify({ requests }) });
  save({ id: batch.id, kind, created_at: new Date().toISOString(), jobs });
  console.log(`${kind}: submitted ${requests.length} jobs as batch ${batch.id}.`);
  return batch.id;
}

type BatchInfo = { id: string; processing_status: string; results_url: string | null; request_counts: Record<string, number> };

async function collect(): Promise<{ open: number }> {
  let open = 0;
  for (const s of saved().filter((x) => !x.collected)) {
    const b = await anthropic<BatchInfo>(`${API}/${s.id}`);
    if (b.processing_status !== "ended" || !b.results_url) {
      open++;
      console.log(`${s.kind} ${s.id}: ${b.processing_status} ${JSON.stringify(b.request_counts)}`);
      continue;
    }
    const raw = await anthropicText(b.results_url);
    const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    let ok = 0;
    const failed: string[] = [];
    const scores: { j: JobDetail; s: { fit_score: number; fit_reasons: string[] } }[] = [];
    for (const line of lines) {
      const j = s.jobs[line.custom_id];
      if (!j) continue;
      const { text, error } = resultText(line);
      try {
        if (!text) throw new Error(error);
        if (s.kind === "score") scores.push({ j, s: parseScore(text) });
        else await app("POST", `/api/agent/jobs/${j.job_id}/materials`, parseMaterials(text));
        ok++;
      } catch (e) {
        // A 409 means the job moved on (skipped, closed) since it was submitted: nothing to do.
        failed.push(`${j.company} · ${j.title}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    if (scores.length) await postScores(scores);
    s.collected = true;
    save(s);
    console.log(`${s.kind} ${s.id}: recorded ${ok}/${lines.length}.`);
    for (const f of failed.slice(0, 10)) console.log(`  not recorded: ${f}`);
  }
  return { open };
}

async function waitAll() {
  for (;;) {
    const { open } = await collect();
    if (!open) return;
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

async function main() {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "score" || cmd === "materials") await submit(cmd);
  else if (cmd === "collect") await collect();
  else if (cmd === "auto") {
    await submit("score");
    await waitAll();
    await submit("materials");
    await waitAll();
  } else if (cmd === "status") {
    for (const s of saved()) console.log(`${s.created_at}  ${s.kind.padEnd(9)} ${s.id}  ${Object.keys(s.jobs).length} jobs  ${s.collected ? "collected" : "open"}`);
  } else {
    console.error("usage: npm run batch -- score|materials|collect|auto|status");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
