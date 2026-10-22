<p align="center"><img src="scripts/app-icon.svg" width="96" alt=""></p>

<h1 align="center">Lodestar</h1>

<p align="center"><b>Your job hunt, steered.</b><br>
A local app that tracks the search, and a daily Claude Code agent that finds jobs, prepares applications and submits the ones you approve, or, with auto-apply on, the strong matches on its own.</p>

<p align="center"><a href="#run-it">Install</a> · <a href="agent/RUNBOOK.md">Agent runbook</a> · <a href="#safety-rails">Safety rails</a></p>

## What it does

- **A pipeline you can read at a glance.** The Pipeline board shows every application by stage, from found to offer, with a feed of what changed and a log of every agent run. While a run is on, the log says what the agent is doing right now (the application it's on and the step), and a run that stopped early, from Stop run, the time limit or a crash, can be finished with **Finish run**: the next run picks up the phase it was in and the item it was on.
- **Today's matches, ready to review.** Each morning the Queue holds the jobs the agent found and scored, each with a tailored resume or CV, a cover letter and answers to the screening questions. Approve one and it goes out on the next run, or right away with **Apply to approved now**; skip one and tell the agent why.
- **A company watchlist.** 134 companies come seeded, by category and priority. The agent scans the ones that are due on their careers sites first, then runs the broad searches, including LinkedIn.
- **Jobs at your own company go through the internal site.** Set **Where you work now** in Settings (it defaults to the current entry in your work history, and you can add the internal job site's link). Jobs at that company are earmarked **Apply internally**: the agent still finds, scores and prepares them, but never submits one. The Queue links to your internal site and has an **I applied internally** button that moves the job to Applied. When you change jobs, change the employer in Settings and the earmark follows.
- **Ask for something specific.** Heard about a role, or want one company checked now? On the Pipeline, under **Look for something on the next scan**, type a job title, a company, or both (with a link or a note if you have one). The next run searches for it before anything else, on the company's careers site and on LinkedIn, and reports back in one line. Whatever it finds is kept and prepared whatever the fit score, marked **You asked for this**, so you decide in the Queue. **Look again** sends a finished lookup back out.
- **Fit scores, not noise.** Every job gets a fit score and reasons. Anything under the threshold (70, or 60 for high-priority companies) is closed on arrival and never scored again.
- **Materials made for each job.** The agent writes Markdown from your own resume and CV text; the app renders it to PDF and Word in `data/applications/<job-id>/`.
- **Auto-apply, if you want it.** Off by default. Switched on, the strong matches go out by themselves, within a daily cap, with a confirmation screenshot for each one. See [Auto-apply](#auto-apply).
- **Tracking by email.** Lodestar reads Apple Mail on your Mac for what employers send back: the "we received your application" confirmation, rejections, interview requests, assessments. Each one lands on its application, so you don't have to sign in to every careers portal to see where things stand. Job emails are filed in a Lodestar mailbox and the ones that need a reply are flagged. See [Email tracking](#email-tracking-apple-mail). Applications with no response after 14 days get a "Follow up" next action.
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
| Pipeline | `/` | Every application by stage, the update feed and the run log. **Run scan now** starts a run; **Finish run** picks up one that stopped early. **Look for something on the next scan** queues a job title or company for the agent. |
| Today's matches | `/queue` | Approve or skip what the agent prepared. **Apply to approved now** sends the approved ones right away. |
| Company watchlist | `/companies` | Companies by category, their careers sites and scan history, and the broad searches |
| Application | `/jobs/[id]` | One job: fit, materials, the posting, tracking, its emails and status history |
| Mail | `/mail` | Email tracking: connect Apple Mail, the emails that need a look, and recent job emails |
| Settings | `/settings` | Profile and search criteria, including auto-apply |

## The Mac app

**Lodestar.app** opens Lodestar in its own window with its own menus, the same way Palimpsest works, starting the server first if it isn't running. **View** has Pipeline, Queue, Companies, Settings and Mail as ⌘1–⌘5. Job postings and your resume files open in your normal browser. The window needs Apple's command line tools; if they're missing, run `xcode-select --install` and then the installer again (until then, Lodestar opens in your browser).

**Updates install themselves.** Lodestar checks GitHub each time you open it and every minute in the background, so a commit on `main` (a merged pull request from Claude, say) is installed within a minute or two of landing: it downloads it, rebuilds and restarts the app, and you get a notification. An open window reloads on the new version by itself, and if the update changes Lodestar.app itself, the app is rebuilt in place and reopened.

- **Lodestar → Check for Updates…** checks right away and tells you either way.
- **About Lodestar** shows the installed commit.
- Updates never touch your data, `.env`, `my-profile.json` or PDFs, and they wait while an agent run is going. The check is a `git ls-remote` against GitHub, not an API call, so checking every minute stays within GitHub's limits.
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
| **Find** | Searches for what you asked for (lookups), then scans the watchlist companies that are due, then the broad and LinkedIn searches, and scores what it finds |
| **Prepare** | Writes the resume or CV, cover letter and screening answers for each good match |
| **Track** | Reads Apple Mail for replies and settles the emails the app wasn't sure of, then re-checks postings, and portals only where email is silent |

**What it needs.** Claude Code signed in with `/login` (Claude in Chrome is off for an API key or a `claude setup-token` token, so the script ignores `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`), and the Claude in Chrome extension installed and signed in. The script opens Chrome if it isn't running (set `JOBHUNT_CHROME_APP` in `.env` for another Chromium browser). The script checks `claude --help` for `--chrome`; if your version names it differently, set `CLAUDE_CHROME_FLAG` in `.env`. If the Chrome tools aren't named `mcp__claude-in-chrome__*` (check `/mcp` inside `claude --chrome`), set `CHROME_MCP_PREFIX`. For confirmation screenshots, give your terminal (and `/bin/bash` for launchd) Screen Recording permission; without it, the agent saves the confirmation text instead.

**What it leaves behind.** Each run gets a row in the Pipeline's run log, a summary in `logs/run-*.log` (the agent's closing message, how many of each tool it called, and any tool calls that were refused) and a full transcript in `logs/run-*.jsonl`. The run log also shows what the app itself recorded (companies marked scanned, new jobs by source, and jobs closed as low fit), separate from the counts the agent reports, so you can tell a run that found nothing from one that found jobs and scored them all under the threshold. A run that included the find phase but scanned no company and posted no job is marked failed, so a run that didn't search can't show up as ok. Runs are capped at 120 minutes (`JOBHUNT_MAX_MINUTES`), and only one runs at a time. **Stop run** on the Pipeline ends the run in progress. A run whose process is gone (the app or Mac restarted under it) is marked failed the next time the app looks, instead of sitting at "running", and the next run takes over its lock.

### If a run fails with "no browser tools" or "extension not reachable"

The agent drives Chrome through Claude in Chrome, so a run is only as good as that connection. The run log on the Pipeline shows what the agent is doing (its last tool call, how many it has made, and whether Claude in Chrome loaded), with the last lines of the run's log underneath, and refreshes itself while a run is going. A run that can't get going is marked failed within a couple of minutes with the reason. The cases, from most to least common:

- **Claude in Chrome isn't loaded (the agent has no browser tools).** Claude Code turns the integration off, even with `--chrome`, unless it's signed in with a claude.ai subscription through `/login`. An API key, a Console account, a `claude setup-token` token or `CLAUDE_CODE_OAUTH_TOKEN` all leave it off; so does an organization policy. The script checks `claude auth status` before each run and quotes Claude Code's own reason (from `logs/run-*.debug.log`) in the run's error. Fix: in Terminal run `claude auth logout`, then `claude` and `/login`, and remove `ANTHROPIC_API_KEY`, `apiKeyHelper` and `CLAUDE_CODE_OAUTH_TOKEN` from `~/.claude/settings.json` (the script already ignores them in `.env`).
- **The tools are there but every call says "Browser extension is not connected".** "Claude in Chrome at start: connected" in the log is Claude Code's side only; the extension in Chrome attaches separately, on the agent's first browser call. With Chrome open, the usual reason it doesn't is that the extension's service worker has gone idle (Chrome has been sitting open for a while), and the other is that the extension is signed in to a different claude.ai account or organization than Claude Code (`/status` shows Claude Code's). The agent waits 20 and then 40 seconds between its three tries before it gives up, and the run log says how many calls failed this way, with Claude Code's own `[Claude in Chrome]` notes from `logs/run-*.debug.log` underneath. Fix: fully quit and reopen Chrome, then run `claude --chrome`, check `/chrome` shows **Enabled** and **Installed**, use **Reconnect extension**, and run the scan again. If Chrome was closed, the extension is missing or disabled, or the native messaging host was just installed, the same steps apply. A call or two answered this way and then answers again (the run line says "answering again", or "answered, after …" once the run is over) is the extension taking a retry to attach, or a drop it came back from; the agent waits it out and there's nothing to fix unless it keeps happening. "Stopped answering after N calls" is a drop it hasn't come back from yet: the agent is still on its three tries while the run is going, and the same fix applies once it gives up.
- **Claude Code wrote nothing.** Usually the one-time Chrome introduction, which a headless run can't press Enter through. Run `claude --chrome` once in Terminal and go through it.
- **The button itself reports an error.** The script stopped before it created a run: the app wasn't answering, another run holds `logs/.run.lock`, or `AGENT_TOKEN` is missing from `.env`. `logs/launcher.log` has the detail.
- **It ran, found jobs, and is still marked failed.** The run log lists every reason, and the last one is the script's: usually the run hit the 120-minute limit before the agent wrote its closing counts, or the agent exited early. Everything recorded up to then is kept, and the next run carries on from there. The agent is told the deadline and wraps up 10 minutes before it; raise `JOBHUNT_MAX_MINUTES` in `.env` if the watchlist needs longer.

### If a company says "not an allowed domain for the Chrome extension"

Claude in Chrome has its own site permissions, and some sites (financial ones, among others) are blocked by the extension's own policy or by Chrome's site access setting. The agent can't change that. It leaves the company unscanned and records the reason on it: the company shows a red `!` on the watchlist, its page shows the note, and the run's row on the Pipeline names the companies it couldn't scan. Allow the site in the extension's settings (Claude in Chrome → site permissions), or if the extension still refuses it, set the company's careers page to a job board it can reach (its Greenhouse, Lever or Workday board, say), or pause the company and check its site yourself. The note clears itself after the next successful scan, or with **Clear the note** on the company's page. A company like this never makes the run fail on its own.

**If a run leaves many companies unscanned this way at once**, Greenhouse, Lever, Workday and other job boards among them, the extension isn't blocking those sites one by one: it's only allowed on some sites in Chrome. Fix it once rather than site by site: in Chrome open `chrome://extensions`, find Claude, and set **Site access** to **On all sites**; then in the extension's own settings allow sites without asking each time (a headless run can't answer the prompt the extension shows on a new site). The run's row on the Pipeline and the run log name the hosts that were refused, and say when the count points to this setting. The agent still looks for those companies' jobs on LinkedIn in the meantime, and re-finds a careers page whose recorded URL has stopped working, so a moved job search doesn't leave a company unscanned.

To see it all at once, run in Terminal: `claude auth status` (should say `"authMethod": "claude.ai"`), then `claude --chrome` and `/chrome`. The first browser action on a site can also wait on the extension's own site permission in Chrome; allow the site there and the run carries on. A run that starts with "Claude in Chrome: still connecting" is normal: the extension connects on the agent's first browser call, and the line goes away once a call has been answered.

### Schedule

```bash
scripts/install-launchd.sh           # app always on + daily run weekdays 7:00 AM (Mac local time)
scripts/install-launchd.sh --remove
```

**Run now** (Pipeline) and **Apply to approved now** (Queue, and the Pipeline when something is approved) start the same script from the app. Applying runs only the submit phase: it sends what you approved, and auto-apply matches if auto-apply is on, without scanning.

## Auto-apply

Off by default. Turn it on under **Settings → Search criteria → Auto-apply** to let the agent submit applications by itself, on company careers sites and on LinkedIn (Easy Apply, or the company site LinkedIn links to). A job is auto-applied only when the server agrees that:

- the profile is confirmed and the job's source is ticked;
- the fit score is at least the auto-apply score (default 85) and the company's normal threshold;
- the resume and cover letter are rendered, the portal isn't flagged for sign-in, and nothing says `[NEEDS YOU: …]`;
- fewer than the daily cap (default 10) have gone out today.

Those jobs show **Auto-applies next run** in the Queue, so you can still skip one before the run. Jobs prepared during a run are auto-applied in the same run. Every auto-application gets an "Auto-applied" event and a confirmation screenshot, like an approved one. The agent still never creates accounts, types passwords or solves CAPTCHAs.

LinkedIn's user agreement restricts automated use of the site, and frequent automated Easy Apply can get an account restricted. The runbook keeps it slow (30 seconds or more between submissions, stop on any security check), but keep the daily cap low, or untick LinkedIn and auto-apply only on careers sites.

## Email tracking (Apple Mail)

Employers answer by email: a confirmation that the application arrived, then a rejection, a request to talk, an assessment or an offer. Lodestar reads those from the Mail app on your Mac, whatever accounts it has (Gmail, iCloud, Outlook), so the pipeline stays current without signing in to each portal.

**Turn it on.** Open **Mail** in Lodestar and click **Connect Apple Mail**. macOS asks whether **node** (the program Lodestar's server runs as) may control Mail: choose **OK**. Lodestar then reads the last 30 days of your inbox and Junk, and after that checks every 15 minutes while Mail is open, each time looking back over the last 10 days so mail an account downloads late isn't missed. A check reads up to 80 job emails, oldest first; when there are more (a busy first month), the next check carries on from where that one started. Each morning's run checks too, opening Mail in the background if it's closed.

**What happens to each email.**

| The email | In Lodestar | In Mail |
| --- | --- | --- |
| Confirmation ("we received your application") | Marked **Email ✓** on the application. If it was still found or approved (you applied yourself, or a submit wasn't recorded), it moves to Applied | Moved to the **Lodestar** mailbox |
| Rejection | Closed as rejected | Moved to **Lodestar** |
| Status update ("under review") | Noted on the application; it doesn't move the stage. A portal's "your status changed, log in to see it" waits under **Needs a look** and you're told about it | Moved to **Lodestar** |
| Interview request, assessment, offer | Noted, with the next action "Read the email from …"; the morning run (or you) moves the stage forward | Flagged and left in the inbox (moved back to the inbox if it landed in Junk), when it's tied to an application and the sender vouches for the company |
| One Lodestar can't tie to a single application, matched by company alone, or a rejection found in Junk | Waits under **Needs a look** on the Mail page, with the applications it could be | Left where it is, Junk included |

The Lodestar mailbox is created inside each Mail account (not "On My Mac"), so it shows on your phone too, and unread mail stays unread. On Gmail it's a label: a scripted move adds it but usually leaves the email in the inbox as well. Exchange accounts don't reliably take a mailbox made by a script, so there Lodestar only flags. The mailbox name, filing, flagging, Junk, notifications and which accounts to read are all settings on the Mail page.

**How it tells which job an email is about.** By the company, named by the sender (its name, its domain, a Workday or iCIMS address) or in the subject, and the job title as written near the top of the email, on its own: "Senior Strategic Finance Manager" isn't your "Strategic Finance Manager" application, and neither is a title named as another opening ("see our other roles, such as …"). Confirmations, rejections and status updates are recorded straight away only when both match, the sender's address vouches for the company (an applicant tracking system, a job board's own notice, or the company's own domain, not just a display name anyone can type), and the email asks for nothing (a "we can't make Tuesday's interview, when are you free?" isn't a rejection). A confirmation or status update also has to come from a system (an applicant tracking system, a job board, or a no-reply or careers mailbox) with no question, time or call in it: a recruiter's own "thanks for applying" often goes on to ask for one. When only the company matches, the title is reworded, the sender doesn't vouch for it, a rejection comes after you've already talked to them, or the email asks for something, it waits for review with the likely application suggested: the agent's next run settles it, or you do on the Mail page. A guess from an address that doesn't vouch for the company waits there without a notification or a next action. A job still found or approved is only ever marked applied by the app's own title match or by you, never by the agent. **Wrong? Look again** on the Mail page puts an email back up for review and undoes what it did to the application, if nothing has happened since.

**What it keeps.** Only emails about your job search: from applicant tracking systems (Greenhouse, Workday, Lever, Ashby, iCIMS and the like), job boards' "your application was sent" notices and messages an employer sends through them ("Interview request from Stripe", "Jane messaged you"), and recruiters or companies you've applied to writing about an application. Reminders to finish an application, saved-job notices, and bank, shopping and newsletter mail from the same companies ("your credit card application", "book a time with a specialist") aren't kept. Lodestar never sends, replies to, forwards or deletes an email; it only moves and flags the job emails as above, and only ones tied to an application from a sender that vouches for the company (a scam "interview invitation" in Junk stays in Junk). The agent's reading of an email never moves it or takes a flag off; only you do, on the Mail page. Payslips and benefits mail from the same HR systems, and mail for interviewing someone else (a hiring panel at your current job), aren't kept.

**If it says Lodestar isn't allowed to use Mail.** Open System Settings → Privacy & Security → Automation, find **node**, and turn on **Mail** under it. If node isn't listed, click **Check mail now** on the Mail page while you're at the Mac and answer the prompt. If there's still no prompt, the server isn't running as node yet: run **Install Job Hunt.command** again (or `scripts/install-launchd.sh --app-only`). A server you started yourself in Terminal is listed under **Terminal** instead. To ask again from scratch, run `tccutil reset AppleEvents` in Terminal (it resets every app's Automation choices, not just Lodestar's) and click **Check mail now**.

- macOS only asks on behalf of a real program, so the always-on server now runs as `node` itself rather than through `npm start`. Installs from before this change are moved over by the updater on its next check (not during a run); running **Install Job Hunt.command** again does the same.
- Permission belongs to that `node`. After Homebrew upgrades Node (`brew upgrade node`), macOS asks once more. The copy of Node the installer downloads into the Lodestar folder keeps it.
- Notifications come from **Script Editor** as far as macOS is concerned. If none appear, allow Script Editor under System Settings → Notifications. They're a convenience: the Mail page and the Pipeline always have the full picture.
- On a very large inbox (tens of thousands of messages), Mail can pause for a moment while Lodestar checks it.

## Safety rails

Enforced in code as well as in the runbook.

- `/api/agent/*` requires `Authorization: Bearer $AGENT_TOKEN`. The app binds to loopback only.
- Only Lodestar itself and the launcher at https://bollineni-create.vercel.app may show Lodestar in a frame (`frame-ancestors` in `next.config.ts`), so no other page can load it out of sight and trick a click. `LODESTAR_FRAME_ANCESTORS` adds more origins.
- The agent can't approve: the API rejects `found → approved`, and `→ applied` from anything but `approved`, except `found → applied` for a job that passes the auto-apply checks above (re-checked on the server at that moment, cap included). Approval only comes from the Queue's **Approve and submit** button.
- `approved_to_submit` is empty while the profile is unconfirmed.
- An email moves an application only forward (to applied, screening, interviewing or offer, or closed as rejected), never to approved, and only an email the app read from Mail itself. The agent can only settle emails the app put up for review.
- Lodestar never sends, replies to, forwards or deletes email. It keeps only job emails, and moves or flags only those.
- Jobs at the current employer (`search_criteria.current_employer`, or the profile's current work-history entry) are never in `approved_to_submit` or `auto_apply_to_submit`, and the agent API refuses to move one to `applied`. The user applies internally and marks it from the Queue.
- Jobs under the fit threshold are closed as `low_fit` on arrival and never re-scored, except jobs found for a lookup you asked for, which stay open for you to decide. A job keeps its first score.
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
lib/mail.ts               email tracking: reads Apple Mail, records job emails, files and flags them
lib/mail-rules.ts         what an email is and which application it's about (tests in lib/mail-rules.test.ts)
scripts/mail/mail.js      the bridge to Apple Mail (JavaScript for Automation, run with osascript)
instrumentation.ts        starts the 15-minute mail check when the app starts
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
| GET | `/api/agent/context` | Criteria, profile, current employer (jobs there are prepared but never submitted), lookups (titles or companies you asked for), companies due a scan, open applications, approved and auto-apply applications to submit, jobs needing a score or materials, skip feedback |
| POST / PATCH | `/api/agent/runs`, `/api/agent/runs/:id` | Start a run; finish it with counts and errors |
| POST | `/api/agent/jobs` | Upsert found jobs (dedupe on company + title + location) with fit score and reasons; `lookup_id` ties a job to a lookup and keeps it open whatever it scores |
| PATCH | `/api/agent/lookups/:id` | Mark a lookup done, with one line on what was found |
| POST | `/api/agent/jobs/:id/materials` | Resume/CV, cover letter and answers as Markdown; rendered to PDF and DOCX in `data/applications/<job-id>/` |
| PATCH | `/api/agent/applications/:id` | Stage, `submitted_at`, `next_action`, `needs_signin`, … |
| POST | `/api/agent/events` | Feed updates |
| POST | `/api/agent/screenshots` | Confirmation screenshot (multipart or base64) and/or text |
| PATCH | `/api/agent/companies/:id` | `careers_url`, `ats_type`, `scanned` |
| POST | `/api/agent/mail/sync` | Check Apple Mail now and record the job emails |
| PATCH | `/api/agent/emails/:id` | Settle an email the app put up for review: application, kind, stage (forward only), or dismiss |

### Notes on the build

- **Data model additions beyond spec §3:** `Job.company_name`, so LinkedIn jobs at companies outside the watchlist still have a name. `lookups` (a title and/or company you asked the agent to look for, with its result) and `Job.lookup_id`. `Company.categories` is a list (Valve and Salesforce sit in two categories). `Application` gains Markdown materials, `skip_reason`, `notes`, `linkedin_status` and `confirmation_text`. `Profile.confirmed` gates submission.
- Teal, blue and orange highlights are treated as normal priority until you give them a meaning.
- Applied with no response for 14 days gets `next_action = "Follow up"` automatically.

## Your data

Everything stays on your Mac: the database in `data/jobhunt.db` (with the job emails Lodestar keeps), rendered materials in `data/applications/`, your source documents in `data/source-docs/`, and logs in `logs/`. `data/`, `logs/`, `.env`, `my-profile.json` and PDFs in the folder are git-ignored. The only things that leave the machine are what the agent types into job sites in your Chrome, and what Claude Code sends to Anthropic to run the agent, which includes the job emails it settles for you (the ones under **Needs a look**).
