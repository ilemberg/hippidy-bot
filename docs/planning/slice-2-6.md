# Slice 2.6: the wiki

Status: **built 2026-11-25, not merged (decisions 201 and 202).** The wave is in `wave-2.md`; the
direction in `team-layer.md`, "Its records". G11 is answered (198); who may reject, edit and
supersede is answered by 201.

**Demo:** a member signs in to the web app and opens **Decisions**: every decision on record,
grouped by area, searchable, with who decided, when and a link to where. Someone who wrote in
the thread a proposal came from opens it, fixes its wording, and confirms it; it becomes
active, and its page shows who proposed, edited and confirmed it, and when. Someone who did
not write there sees the proposal but no buttons, and is told why.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **Schema**: `decision_events`, the history of each decision (recorded, edited, confirmed, rejected, superseded), with who and when | No |
| B | **The API**: one rule for who may act on a proposal; `GET /v1/decisions/:number` with its history and what the caller may do; confirm, reject and edit for a signed-in person; Slack's Confirm under the same rule | **Yes**: Slack's Confirm refuses someone who did not write in the thread |
| C | **The pages**: `/decisions` (by area, search, status) and `/decisions/<number>` (the decision, its history, and the buttons the person may use) | Only the web app |

## Who may do what (G11, 201)

- **A proposal** is confirmed, rejected or edited by anyone who wrote in the thread it came
  from: for a teammate's proposal, a person whose message is in that conversation; for one
  from listening, a person in its `confirmable_by`. Always within the same source and
  workspace. The same rule in Slack and in the web app.
- **An active decision** is never edited in place. To change it, a person asks the teammate
  in a thread to record a decision that supersedes it (`record_decision` with `supersedes`,
  2.2), which then follows the usual rules.
- **An imported decision** (from `decisions.md`) is read-only in the wiki: the log is its
  source, and a new log entry supersedes it there.
- **Rejected** decisions stay on record, with who rejected them and when, and are no longer
  put before messages or recalled.

## Editing a proposal

The statement (at most 500 characters), the reason (2,000) and the area (100). Each edit is
kept in `decision_events` with the text before and after, who, and when. Editing does not
confirm: a person confirms separately, and may be the one who edited it.

## The web app writes for the first time

- Each action is a form posted to the web app's own server (`/decisions/<number>/confirm`,
  `/reject`, `/edit`), refused unless it comes from the app's own pages (`Origin` or
  `Sec-Fetch-Site`, as sign-out is, 196). The server calls the API as the person, with a
  person token, and sends the browser back to the decision's page.
- The API takes who acts from the person token, never from the request body.
- Persons may call only these new write routes; every other write stays on the service token.

## Done when

- The decisions page lists every decision by area, and finds one by its words.
- A person who wrote in the thread confirms, rejects and edits a proposal from the web app;
  its page shows each step with who and when.
- A person who did not write there is refused, in the web app and by Slack's Confirm, and
  told why.
- An imported or active decision has no edit button, and the API refuses an edit to it.

## Not in 2.6

- Areas with owners (wave 3), who then confirm in their area.
- Proposing a new or superseding decision from the web app: ask the teammate in a thread.
- Confirming from Slack a proposal made by listening: no message is posted in its thread
  (176), so it is confirmed in the web app.
