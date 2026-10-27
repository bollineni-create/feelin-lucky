# jobscout

Scores job postings against `criteria.md` with a cheap model (Haiku), then writes a tailored resume-bullet set and cover letter for the best ones with a stronger model (Sonnet). Everything is grounded in `master_resume.txt`.

## Setup
```bash
pip install anthropic
export ANTHROPIC_API_KEY="sk-ant-api03-..."   # a key from its own Console workspace, so spend is visible
cp criteria.example.md criteria.md              # then edit: roles, cities, pay, deal-breakers, writing voice
cp master_resume.example.txt master_resume.txt  # then paste your resume text
python3 -m unittest -v                         # offline tests, spends nothing
```
`criteria.md`, `master_resume.txt`, `state.json` and `out/` are git-ignored, so your resume and search criteria stay on your machine. Never commit the API key either.

## Feed it postings
Any of: a `.jsonl` file (one JSON object per line), a `.json` list, a `.csv`, or a folder of `.txt`/`.md` files (one posting per file).
Fields (case-insensitive): `description` (required), `title`, `company`, `location`, `url`.

## Run
```bash
python3 jobscout.py postings.jsonl --dry-run          # counts only, no API calls
python3 jobscout.py postings.jsonl --max-postings 5   # first real run: small and cheap
python3 jobscout.py postings.jsonl                    # normal run
python3 jobscout.py postings/ --threshold 75 --limit-tailor 10
python3 jobscout.py postings.jsonl --score-only       # ranking only, no packets
```

## Output (`out/<date>/`)
- `summary.md` and `results.csv`: every posting scored this run, best first, with work mode, stated base pay, deal-breaker, reasons, flags.
- `packets/*.md`: per posting at or above the threshold: positioning line, rewritten bullets (shown next to the original), keywords to mirror, cover letter, private gaps list.
- `usage.jsonl`: tokens per API call. The run prints totals per model.

## How scoring works
The model rates fit, location, comp/level and company 0-100. The script computes the weighted overall (35/25/20/20). A deal-breaker caps the score at 39. Score >= `--threshold` (default 70) gets tailored; within 20 points of it is "maybe".

## Checks on the tailoring (advisory, read every packet)
- Each rewritten bullet must name a source bullet that exists in the resume, or it is flagged.
- Any number in a rewritten bullet that is not in the resume is flagged.
- Numbers in the cover letter must appear in the resume or the posting, or they are flagged.
- Letters over ~230 words are flagged.

Flagged items show up under **CHECK BEFORE SENDING** at the top of the packet and in `results.csv`.

## Cost controls
- `--max-postings` (new postings scored per run, default 100), `--limit-tailor` (packets per run, default 15), `--max-total-tokens` (hard stop, default 2,000,000).
- Postings already scored are skipped on later runs. One that qualified but hit the packet limit is tailored next run without being re-scored.
- A failed call is not marked as seen, so it retries next run. A bad key stops the run immediately.
- The system prompt (criteria + resume) is marked cacheable. It only caches if it clears the model's minimum cacheable length; check the "cache read" number in the run output to see whether it did.
- Dollar cost is not computed here. Check Console > Usage for the key's workspace.
- Change models with `JOBSCOUT_SCORE_MODEL` / `JOBSCOUT_TAILOR_MODEL`.

## How it relates to Lodestar
Lodestar's daily agent already finds, scores and tailors jobs, and it runs on a claude.ai subscription sign-in on purpose (Claude in Chrome needs it, and `scripts/daily-run.sh` unsets `ANTHROPIC_API_KEY`). jobscout is a separate, standalone tool that calls the API directly, so it is the one that spends Console credits. It is not wired into the agent or the database; feed it postings you export yourself.

## Not included
It does not fetch postings, apply to anything, or send anything. It does not use the Batch API (about half price for non-urgent runs); worth adding once the daily volume justifies it.

## Keeping it current
`criteria.md` is yours to edit; both stages read it every run. `master_resume.txt` is a plain-text copy of your resume (leave out the contact line). Refresh it whenever your resume changes. If either file is missing, the script stops and tells you to copy the matching `.example` file.
