# Slice 4.2: job management

Status: **built 2026-11-26, not merged (decisions 217 and 218).** The wave is in `wave-4.md`; the record in
`slice-4-1.md`.

**Demo:** on `/jobs` Ada sees capture and briefs, each with its schedule, state and this
month's spend against its cap. She opens capture, reads its last wakes (most silent, each
saying why), raises its cap to $40 and pauses it; the change is kept with her name, and capture
does not wake until she resumes it.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **The API**: `PATCH /v1/jobs/:id` from a signed-in person, on the version they saw: state (active or paused), cap, interval and goal; each change kept in `job_events` with the before and after; `GET /v1/jobs/:name` adds the history | **Yes**: people can pause jobs and change caps |
| B | **The pages**: `/jobs` and `/jobs/<name>` in the web app | Only the web app |

## Rules

- **Who:** anyone signed in, as themselves (174), on the version they saw (as 203); never the
  service token, never the job itself (G16).
- **State:** a person sets `active` or `paused`. A `capped` job is made active again by raising
  its cap above this month's spend, or by a person resuming it after raising the cap; resuming
  a capped job without a higher cap is refused (`still_capped`).
- **Cap:** $0 to $100 a month in whole cents (all jobs together stay inside decision 11's $100,
  which the page shows but does not enforce in 4.2). **Interval:** 1 to 1,440 minutes.
  **Goal:** up to 2,000 characters, or none.
- An edit that changes nothing records nothing.

## Done when

- A person pauses and resumes a job, raises its cap and changes its interval, each kept with
  who and when; an edit on an old version is refused; a paused job does not wake.
- A capped job wakes again after its cap is raised above its spend.
- `/jobs` and `/jobs/<name>` show the jobs, their spend, wakes and history, and change them.
