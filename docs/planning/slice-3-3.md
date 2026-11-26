# Slice 3.3: tasks and the waiting-on list

Status: **built 2026-11-26, not merged (decisions 210 and 211).** The wave is in `wave-3.md`.

**Demo:** the web app's `/tasks` page lists the team's tasks, from Jira's `SCRUM` project or
from the built-in tracker, the same way whichever is the home: key, title, status, who it is
assigned to, and the threads working on it. Beside it, `/waits` shows who is waiting on whom,
for what and since when. In a thread, Grace says she cannot finish the search change until Ada
reviews the ranking; the teammate records it, and the bot says so in the thread. When Ada
reviews it, either of them ends the wait, in the thread or on the page.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **Schema**: `tasks` and `task_events` (the built-in tracker); `waits`; a thread's task on `conversations` | No |
| B | **Tasks behind a provider**: one interface in the API (list, read), with the built-in tracker and Jira (its REST API, with a credential of the API's own); the tasks routes; creating and editing a built-in task in the web app | No: only the web app reads them |
| C | **A thread's task (SCRUM-8)**: `link_task`, a teammate tool that links the thread to the task it works on, checked against the provider | **Yes**: the teammate may link a thread |
| D | **Waiting-on**: `record_wait` and `end_wait`, teammate tools; the waits routes; recording and ending one in the web app | **Yes**: the teammate may record a wait, posted in the thread |
| E | **The pages**: `/tasks`, `/tasks/<key>`, `/waits` | Only the web app |

## Tasks behind a provider (G14, 178)

- **One home.** `TASK_PROVIDER` is `jira` or `builtin`; unset, it is `builtin`, which needs no
  credential. A team uses one; nothing is synced between the two (rule 5 of `wave-2.md`).
- **The interface:** list (open first, by latest change, up to 100, optionally words to search)
  and read one by key. A task is its key, title, status (`todo`, `doing` or `done`, with the
  provider's own name for it), who it is assigned to, its link, and when it last changed.
- **Jira:** the REST API (`/rest/api/3/search/jql` and `/rest/api/3/issue/:key`) at
  `JIRA_BASE_URL`, with `JIRA_EMAIL` and `JIRA_API_TOKEN` (basic auth), in the project
  `JIRA_PROJECT_KEY` (default `SCRUM`). A status is mapped by its Jira status category. Calls
  time out after five seconds; a missing or bad setting is logged and the tasks page says Jira
  is not configured (fail closed). The agent keeps its own Atlassian tools (rule 4 of
  `wave-1.md`); this credential is the API's, read-only use, and never reaches the agent.
- **Built-in:** keys `T-1`, `T-2`, …; created and edited by a signed-in person as themselves
  (title, description, status, assignee from the people the record knows), on the version they
  saw, every change kept in `task_events`. The teammate cannot create tasks in 3.3.
- **Nothing is cached:** each page reads the provider. A failing provider makes the page say
  so; nothing else depends on it.

## A thread's task (SCRUM-8)

`link_task` takes a task's key. The API checks it exists in the provider, waiting at most 1.5
seconds since the thread's sync lease is held (or, when the provider does not answer, records
it as given and says so), and keeps it on the thread. A
thread has one task at a time; linking another replaces it. The task's page lists the threads
linked to it. Showing a thread's task on the agents page is left for later (211).

## Waiting-on (178)

- **A wait:** who waits, on whom, for what (at most 300 characters), optionally a task's key,
  since when, and where it was said (a thread). It ends when either person, or whoever recorded
  it, ends it; it is kept with who ended it and when.
- **`record_wait`:** only in a turn answering the waiter or the person waited on (211); the
  person waited on must be someone the record knows. Posted in the thread: "Grace is waiting on
  @Ada: review the ranking." with the person waited on mentioned. One wait per call; at most ten
  open waits per thread, and 20 recorded a day.
- **`end_wait`:** by number, from the thread it was recorded in, in a turn answering the waiter,
  the person waited on or whoever recorded it (211). Posted in the thread, with the end.
- **Routes:** `GET /v1/waits` (open by default; for one person), `POST /v1/waits` (a signed-in
  person records their own wait), `POST /v1/waits/:id/end` (the waiter, the person waited on,
  or whoever recorded it).
- **Shown** on `/waits`, grouped by the person waited on, and on each task's page; 3.4 puts each
  person's in their brief.

## Done when

Each line gets its query or test before its pull request merges (96).

- `/tasks` shows the built-in tracker's tasks, and Jira's through a faked Jira, the same way.
- A built-in task is created and edited in the web app, each change kept; an edit on an old
  version is refused.
- A thread is linked to a task by the teammate, and the task's page lists it.
- A wait is recorded in a thread, posted once with the person waited on mentioned, listed, and
  ended by one of its people, in the thread or the web app.

## Not in 3.3

- The teammate creating or changing tasks (Jira or built-in): its own Atlassian tools stay as
  they are.
- Goals, and giving work to the bot from a task: wave 4.
- Telling a person what waits on them outside the thread: 3.4.
