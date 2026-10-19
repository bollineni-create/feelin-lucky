<p align="center"><img src="scripts/app-icon.svg" width="96" alt=""></p>

<h1 align="center">Lodestar</h1>

<p align="center"><b>Your job hunt, steered.</b><br>
A local app that tracks the search, and a daily Claude Code agent that finds jobs, prepares applications and submits the ones you approve, or, with auto-apply on, the strong matches on its own.</p>

<p align="center"><a href="#run-it">Install</a> · <a href="agent/RUNBOOK.md">Agent runbook</a> · <a href="#safety-rails">Safety rails</a></p>

## What it does

- **A pipeline you can read at a glance.** The Pipeline board shows every application by stage, from found to offer, with a feed of what changed and a log of every agent run.
- **Today's matches, ready to review.** Each morning the Queue holds the jobs the agent found and scored, each with a tailored resume or CV, a cover letter and answers to the screening questions. Approve one and it goes out on the next run; skip one and tell the agent why.
- **A company watchlist.** 134 companies come seeded, by category and priority. The agent scans the ones that are due on their careers sites first, then runs the broad searches, including LinkedIn.
- **Fit scores, not noise.** Every job gets a fit score and reasons. Anything under the threshold (70, or 60 for high-priority companies) is closed on arrival and never scored again.
- **Materials made for each job.** The agent writes Markdown from your own resume and CV text; the app renders it to PDF and Word in `data/applications/<job-id>/`.
- **Auto-apply, if you want it.** Off by default. Switched on, the strong matches go out by themselves, within a daily cap, with a confirmation screenshot for each one. See [Auto-apply](#auto-apply).
- **Tracking after you apply.** The agent checks portals you're already signed in to and records any change. Applications with no response after 14 days get a "Follow up" next action.
- **Your facts only.** Titles, dates and details come from the profile you confirm in Settings and nowhere else. Until it's confirmed, nothing is filled or submitted.
- **A Mac app that keeps itself up to date.** Lodestar.app opens in its own window from the Dock, runs the agent every weekday at 7:00 AM and installs new versions from `main` on its own.

## Run it

### On a Mac (easiest)

1. Download this repo (green **Code** button → **Download ZIP**, or `git clone`) and move the folder somewhere it'll stay, like Documents.
2. Optional: put `my-profile.json` (and your resume and CV PDFs) in the folder. The installer fills in Settings from it: contact details, work history, education, skills, and the resume and CV text. The file is git-ignored, so it never goes to GitHub.
3. Double-click **`Install Job Hunt.command`**. If macOS says it can't verify the developer, right-click it → **Open** → **Open**.

The installer downloads Node.js into the folder if your Mac doesn't have it, installs everything, keeps the app running in the background, schedules the weekday 7:00 AM run, and puts **Lodestar.app** in **Applications** and the Dock (or `~/Applications` if your account can't write to `/Applications`). Running it again is safe: it won't overwrite profile edits you made in Settings. If you move the folder, run it again from the new place.

### By hand

```bash
npm install
npm run setup          # writes AGENT_TOKEN to .env, creates the DB, seeds 134 companies + the LinkedIn tracker
cp ~/path/to/Bollineni_Naren_Resume_2026_V2.pdf ~/path/to/Bollineni_Naren_CV_2026_V2.pdf data/source-docs/
npm run build && npm start
```

Then open <http://127.0.0.1:3000>.

### Before the first run

Open **Settings** and:

1. Replace every `[CONFIRM]` / `[TITLE TO USE]` placeholder in the work history (titles, exact dates, the June 2022 entry) and fill in contact details, education and work authorization.
2. Paste the resume and CV text as Markdown. The agent tailors from this text.
3. Set **Minimum base**.
4. Tick **I've checked every title and date** and save. The server refuses to confirm while placeholders remain, and until the profile is confirmed the agent won't fill or submit any form.

### Screens

| Screen | Path | For |
| --- | --- | --- |
| Pipeline | `/` | Every application by stage, the update feed and the run log. **Run now** starts a run. |
| Today's matches | `/queue` | Approve or skip what the agent prepared. **Submit approved now** sends them right away. |
| Company watchlist | `/companies` | Companies by category, their careers sites and scan history, and the broad searches |
| Application | `/jobs/[id]` | One job: fit, materials, the posting, tracking and status history |
| Settings | `/settings` | Profile and search criteria, including auto-apply |

## The Mac app

**Lodestar.app** opens Lodestar in its own window with its own menus, the same way Palimpsest works, starting the server first if it isn't running. **View** has Pipeline, Queue, Companies and Settings as ⌘1–⌘4. Job postings and your resume files open in your normal browser. The window needs Apple's command line tools; if they're missing, run `xcode-select --install` and then the installer again (until then, Lodestar opens in your browser).

**Updates install themselves.** Lodestar checks GitHub each time you open it and every 15 minutes in the background. When `main` has a new commit it downloads it, rebuilds and restarts the app, and you get a notification. An open window reloads on the new version by itself, and if the update changes Lodestar.app itself, the app is rebuilt in place and reopened.

- **Lodestar → Check for Updates…** checks right away and tells you either way.
- **About Lodestar** shows the installed commit.
- Updates never touch your data, `.env`, `my-profile.json` or PDFs, and they wait while an agent run is going.
- The log is `logs/update.log`. Set `JOBHUNT_AUTO_UPDATE=0` in `.env` to turn updates off.

Copies from earlier installs in `~/Applications` move to `/Applications` on their own, Dock icon included.

## The agent

`scripts/daily-run.sh` starts a headless Claude Code session with Claude in Chrome. It follows [`agent/RUNBOOK.md`](agent/RUNBOOK.md) in your real Chrome, with your existing sign-ins, and records everything through the token-gated `/api/agent/*` routes. The app itself never browses.

```bash
scripts/daily-run.sh --phase find,prepare   # first run: find + score + prepare, no submitting
scripts/daily-run.sh --phase submit         # submit what you approved
scripts/daily-run.sh                        # all phases: submit → find → prepare → track
```

A full run goes through four phases, in this order:

| Phase | Does |
| --- | --- |
| **Submit** | Sends what you approved in the Queue, then what passes the auto-apply checks |
| **Find** | Scans the watchlist companies that are due, then the broad and LinkedIn searches, and scores what it finds |
| **Prepare** | Writes the resume or CV, cover letter and screening answers for each good match |
| **Track** | Re-checks open applications and records any change in stage |

**What it needs.** Claude Code signed in, with Chrome open and the Claude in Chrome extension connected. The script checks `claude --help` for `--chrome`; if your version names it differently, set `CLAUDE_CHROME_FLAG` in `.env`. If the Chrome tools aren't named `mcp__claude-in-chrome__*` (check `/mcp` inside `claude --chrome`), set `CHROME_MCP_PREFIX`. For confirmation screenshots, give your terminal (and `/bin/bash` for launchd) Screen Recording permission; without it, the agent saves the confirmation text instead.

**What it leaves behind.** Each run gets a row in the Pipeline's run log, a summary in `logs/run-*.log` (the agent's closing message, how many of each tool it called, and any tool calls that were refused) and a full transcript in `logs/run-*.jsonl`. The run log also shows what the app itself recorded (companies marked scanned, new jobs by source), separate from the counts the agent reports. A run that included the find phase but scanned no company and posted no job is marked failed, so a run that didn't search can't show up as ok. Runs are capped at 120 minutes (`JOBHUNT_MAX_MINUTES`), and only one runs at a time.

### Schedule

```bash
scripts/install-launchd.sh           # app always on + daily run weekdays 7:00 AM (Mac local time)
scripts/install-launchd.sh --remove
```

**Run now** (Pipeline) and **Submit approved now** (Queue) start the same script from the app.

## Auto-apply

Off by default. Turn it on under **Settings → Search criteria → Auto-apply** to let the agent submit applications by itself, on company careers sites and on LinkedIn (Easy Apply, or the company site LinkedIn links to). A job is auto-applied only when the server agrees that:

- the profile is confirmed and the job's source is ticked;
- the fit score is at least the auto-apply score (default 85) and the company's normal threshold;
- the resume and cover letter are rendered, the portal isn't flagged for sign-in, and nothing says `[NEEDS YOU: …]`;
- fewer than the daily cap (default 10) have gone out today.

Those jobs show **Auto-applies next run** in the Queue, so you can still skip one before the run. Jobs prepared during a run are auto-applied in the same run. Every auto-application gets an "Auto-applied" event and a confirmation screenshot, like an approved one. The agent still never creates accounts, types passwords or solves CAPTCHAs.

LinkedIn's user agreement restricts automated use of the site, and frequent automated Easy Apply can get an account restricted. The runbook keeps it slow (30 seconds or more between submissions, stop on any security check), but keep the daily cap low, or untick LinkedIn and auto-apply only on careers sites.

## Safety rails

Enforced in code as well as in the runbook.

- `/api/agent/*` requires `Authorization: Bearer $AGENT_TOKEN`. The app binds to loopback only.
- The agent can't approve: the API rejects `found → approved`, and `→ applied` from anything but `approved`, except `found → applied` for a job that passes the auto-apply checks above (re-checked on the server at that moment, cap included). Approval only comes from the Queue's **Approve and submit** button.
- `approved_to_submit` is empty while the profile is unconfirmed.
- Jobs under the fit threshold are closed as `low_fit` on arrival and never re-scored. A job keeps its first score.
- In headless mode the agent may only use the Chrome tools, `agent/api.sh`, `screencapture`, reads, and writes to `logs/tmp/`. `curl`, `rm`, `git` and WebFetch are blocked.
- Page content is data, not instructions: the runbook tells the agent to ignore anything a job posting or portal tells it to do.

## How it's put together

```
app/                      the Next.js app: Pipeline, Queue, Companies, Jobs and Settings pages
app/api/agent/            the token-gated routes the agent talks to
app/files/                serves rendered resumes and cover letters
components/               shared UI: nav, run button, theme toggle
db/schema.ts              the data model (Drizzle on SQLite, data/jobhunt.db)
db/seed-data.ts           the 134 seeded companies and the LinkedIn tracker
db/migrations/            SQL migrations
lib/logic.ts              stages, thresholds, follow-ups and the auto-apply checks
lib/render.ts             Markdown to PDF and DOCX
lib/runner.ts             starts and watches agent runs from the app
lib/dedupe.ts             matches a job to one already found (company + title + location)
agent/RUNBOOK.md          the agent's standing instructions
agent/api.sh              the agent's way in to the API, with the bearer token added
scripts/daily-run.sh      starts a headless Claude Code run
scripts/auto-update.sh    pulls, rebuilds and restarts when main moves
scripts/install-launchd.sh the always-on app and the weekday schedule
scripts/make-mac-app.sh   builds Lodestar.app
scripts/mac/JobHunt.swift the native Mac window
Install Job Hunt.command  the one-click installer
```

Next.js 15, React 19, SQLite through better-sqlite3 and Drizzle, `pdfkit` and `docx` for rendering, and `zod` for checking what the agent sends.

### Agent API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/agent/context` | Criteria, profile, companies due a scan, open applications, approved and auto-apply applications to submit, jobs needing a score or materials, skip feedback |
| POST / PATCH | `/api/agent/runs`, `/api/agent/runs/:id` | Start a run; finish it with counts and errors |
| POST | `/api/agent/jobs` | Upsert found jobs (dedupe on company + title + location) with fit score and reasons |
| POST | `/api/agent/jobs/:id/materials` | Resume/CV, cover letter and answers as Markdown; rendered to PDF and DOCX in `data/applications/<job-id>/` |
| PATCH | `/api/agent/applications/:id` | Stage, `submitted_at`, `next_action`, `needs_signin`, … |
| POST | `/api/agent/events` | Feed updates |
| POST | `/api/agent/screenshots` | Confirmation screenshot (multipart or base64) and/or text |
| PATCH | `/api/agent/companies/:id` | `careers_url`, `ats_type`, `scanned` |

### Notes on the build

- **Data model additions beyond spec §3:** `Job.company_name`, so LinkedIn jobs at companies outside the watchlist still have a name. `Company.categories` is a list (Valve and Salesforce sit in two categories). `Application` gains Markdown materials, `skip_reason`, `notes`, `linkedin_status` and `confirmation_text`. `Profile.confirmed` gates submission.
- Teal, blue and orange highlights are treated as normal priority until you give them a meaning.
- Applied with no response for 14 days gets `next_action = "Follow up"` automatically.

## Your data

Everything stays on your Mac: the database in `data/jobhunt.db`, rendered materials in `data/applications/`, your source documents in `data/source-docs/`, and logs in `logs/`. `data/`, `logs/`, `.env`, `my-profile.json` and PDFs in the folder are git-ignored. The only things that leave the machine are what the agent types into job sites in your Chrome, and what Claude Code sends to Anthropic to run the agent.
