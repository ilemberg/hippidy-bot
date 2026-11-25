# Slice 3.1: areas, owners and routing

Status: **built 2026-11-25, not merged (decisions 205 to 207).** The wave is in `wave-3.md`.

**Demo:** in the web app, someone creates the area `search`, owned by Ada, with the code path
`apps/api/src/store/decisions.ts` and the word "full-text". In a thread, Grace asks the bot to
change how full-text search ranks results. The brief is posted, and under it the bot says
"This touches search, owned by @Ada." When the worker's pull request changes a file under that
path, nothing more is said (the area was already named); a pull request that touches another
area's path names that area's owner too. Later the teammate proposes a decision in `search`,
and Ada may confirm it although she never wrote in that thread.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **Schema**: `areas` (name, description, owner, paths, words, a version) and `area_events` (each change, who, when, before and after); `change_areas` (which areas a change was said to touch) | No |
| B | **The API**: the areas routes (list, read, create, edit; a person writes as themselves, with the version they saw); `GET /v1/people`, the people the record knows, for choosing an owner; matching text and paths to areas | No: nothing routes until C |
| C | **Routing**: a brief names the areas it touches and their owners in its thread; so does a pull request that touches an area's path; a proposed decision in an area names its owner; the owner of a decision's area may confirm, reject or reword it | **Yes**: briefs and proposals in owned areas mention their owner |
| D | **The pages**: `/areas` and `/areas/<name>` in the web app, with the history of each | Only the web app |

## An area (G19)

- **Name:** lowercase, 1 to 60 characters, unique; the same label decisions already carry, so
  a decision in `search` is in the area `search` once it exists.
- **Owner:** one person (source, workspace, id, name), or none; none means the fallback
  (`FALLBACK_OWNER`, rule 10 of `wave-3.md`).
- **Paths:** up to 50 glob patterns over the repository, like a CODEOWNERS file
  (`apps/api/src/store/**`). Matched by the API's own glob reader: `*`, `**` and `?` only (207).
- **Words:** up to 30 words or short phrases that mark it in text ("full-text", "recall"),
  matched case-insensitively as whole words. The name itself always counts as one.
- **Description:** a sentence, optional.
- **Who may change it:** anyone signed in (174), as themselves, on the version they saw
  (like 203). Every change is kept in `area_events` with the before and after. The old owner of
  an area whose owner changed hears of it in their next brief (3.4); until then the page shows
  it.

## Routing

- **A brief.** When the teammate writes a brief, the API matches its title, what, why and
  done-when against every area's words, and the paths it names against every area's paths.
  The teammate may also name areas (`start_change` gains an optional `areas`, checked against
  the known ones). For each area touched and not yet named for that change, the API posts once
  under the brief: "This touches search, owned by @Ada." The mention is what tells the owner;
  nothing else is sent until 3.4.
- **A pull request.** When the worker's turn has a pull request (as CI is judged, 132), the API
  reads its changed files from GitHub with the token it already holds for checks, matches them
  against paths, and posts the same line for any area not yet named for the change. Read on the
  turn's settling, outside any sync lease.
- **A decision.** A decision recorded in an area that exists names its owner in the post
  ("Proposed. Owner of search: @Ada."). The teammate is given, before a message that matches
  an area, the line "Areas this may touch: search (owner Ada)".
- **Who may confirm (G11 from 3.1).** A proposal is confirmed, rejected or reworded by anyone
  who wrote in its thread, as before, or by the owner of its area. Slack's Confirm and the web
  app follow the same rule.
- **No owner:** the line names the fallback instead, and says the area has no owner.

## People

`GET /v1/people` lists the people the record knows: who has written to the bot, who owns an
area, who decided or confirmed something; with their Slack id and the latest name seen. The
web app offers them when choosing an owner. Nobody is looked up in Slack for it.

## Done when

Each line gets its query or test before its pull request merges (96).

- An area is created, its owner changed and its paths edited in the web app, each kept with who
  and when; an edit on an old version is refused.
- A brief whose text matches an area's word names the area and its owner once in its thread.
- A pull request touching an area's path names that area, if not named already.
- A proposal in an area names its owner, who may confirm it without having written in the
  thread.
- An area with no owner names the fallback.

## Not in 3.1

- Conflicts and who decides them: 3.2.
- Telling an owner outside the thread (a direct message, the brief): 3.4.
- Suggesting areas from the code or from the decisions already recorded: later, if wanted.
