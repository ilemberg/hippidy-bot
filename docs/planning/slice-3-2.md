# Slice 3.2: conflict surfacing

Status: **built 2026-11-25, not merged (decisions 208 and 209).** The wave is in `wave-3.md`; areas and owners in
`slice-3-1.md`.

**Demo:** Ada owns the area `search`, and decision 12 says "Search uses Postgres full-text
search", decided by Grace. In a thread, Linus asks the bot to record that search moves to a
vector index instead. The bot records the new decision as a proposal that replaces 12 and
posts: "This would replace decision 12, which Grace decided. @Ada decides, as owner of search;
until then decision 12 stands." Linus cannot confirm it, nor can anyone else in the thread; Ada
can, in Slack or the web app. In another thread, Grace and Linus want opposite things and the
teammate raises it: the conflict is posted the same way and listed on `/conflicts` until Ada
settles it there.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **Schema**: `conflicts` (a number, the thread, the area, the decisions involved, the positions, who decides, open or settled, how and by whom); `decisions.deciders`, who alone may confirm a proposal that replaces someone else's decision | No |
| B | **The rule**: a proposal that replaces an active decision someone else made is guarded: only its deciders may confirm or reword it; a conflict is recorded and posted with them mentioned | **Yes**: replacing another person's decision now waits for the owner |
| C | **`raise_conflict`**: a teammate tool for disagreements that are not (yet) a decision; the conflicts routes; settling one | **Yes**: the teammate may post a conflict |
| D | **Capture** flags a proposal that would replace an active decision: guarded, with a conflict, nothing posted (176) | Only what listening proposes |
| E | **The pages**: `/conflicts` and `/conflicts/<number>` in the web app, with a form to settle one; a decision's page shows its open conflicts | Only the web app |

## Who decides (G12, rule 11)

The **deciders** of a conflict, or of a guarded proposal, are fixed when it is recorded:

- the owner of the area of the decision being replaced (or of the areas of the decisions a
  conflict names), if they owned it when that decision was made (`owner_since`, as 207 and
  209);
- otherwise the fallback (`FALLBACK_OWNER`);
- and, for a replacement, the person who made the decision being replaced: changing your own
  decision is not a conflict with yourself.

Fixing them at recording keeps one rule in Slack, the web app and the record, and means
changing an area's owner later does not reopen or take over what is already waiting. With no
owner and no fallback configured, the post says nobody is set to decide, and the proposal waits
(configuration fails closed).

## The rule for replacements (part B)

- When `record_decision` names `supersedes` N and N is active, the decision is recorded as
  **proposed**, with its deciders and a conflict of kind `replacement`, unless it would be
  active anyway (its decider asked, alone, 192 and 195) and that person is one of N's deciders
  (209). Who the call names as deciding is not trusted on its own.
- **Confirm and reword:** only a decider. **Reject:** a decider, or whoever could act on it
  before (G11, 201): withdrawing a proposal does not change the record.
- The decision post says "This would replace decision N, which X decided. @Owner decides, as
  owner of search; until then decision N stands." with the deciders mentioned.
- When the proposal is confirmed the conflict closes as `changed`; when rejected, as `kept`.
- A person refused is told why: `not_decider` ("Only Ada, owner of search, decides this").

## `raise_conflict` (part C)

For two people in a thread wanting opposite things, or a request that contradicts an active
decision without a new decision being recorded:

- **Input:** a summary (at most 300 characters), up to three decision numbers it bears on
  (active ones), up to four positions (who, and what they want, at most 300 characters each),
  and an optional area. At least one decision, or two positions.
- **Checks:** each position's person wrote in the thread or made one of the named decisions;
  the decisions are active; the area exists or is left out (then the first decision's area).
  At most three open conflicts per thread; a fourth is refused with a message the teammate
  can relay. One conflict per call (keyed on its id).
- **Posted** in the thread like a replacement, deciders mentioned, positions listed.
- The teammate is told, in its prompt, to raise a conflict rather than pick a side, and never
  to record a decision that replaces someone else's just because the latest message asks.

## Settling and showing

- `GET /v1/conflicts` (open by default, or `settled` or `all`) and `GET /v1/conflicts/:number`
  with what the caller may do; readable by the service token and a signed-in person.
- `POST /v1/conflicts/:id/settle` from a signed-in decider: `kept`, `changed` or `dismissed`,
  with a note (at most 500 characters). A conflict with a guarded proposal is settled by acting
  on the proposal, not here. The thread gets a note when it is settled.
- The web app lists open conflicts at `/conflicts`, shows one with its positions and decisions
  at `/conflicts/<number>`, and a decision's page lists its open conflicts.
- 3.4 puts each open conflict in its deciders' brief.

## Capture (part D)

The extractor is also given up to five active decisions that share words with the thread, and
may say a decision it found replaces one of them. Such a proposal is recorded with
`supersedes`, guarded by the rule above, with a conflict; nothing is posted in the channel
(176). Its deciders see it on `/conflicts` and, from 3.4, in their brief.

## Done when

Each line gets its query or test before its pull request merges (96).

- A replacement of another person's decision is proposed, posted with the owner mentioned, and
  only the owner, the fallback for an area with no owner, or the original decider may confirm
  it; the thread's writers may still withdraw it.
- Replacing your own decision follows the rules of 2.2 as before.
- A conflict raised by the teammate is posted once, listed, and settled by a decider in the
  web app, with a note in the thread.
- A captured proposal that replaces an active decision is guarded and listed, with nothing
  posted.

## Not in 3.2

- Finding conflicts with a model call of its own: the teammate and capture already read the
  decisions near a message.
- Telling deciders outside the thread: 3.4.
- Conflicts between two active decisions recorded long apart: later, if wanted.
