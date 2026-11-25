# Slice 2.5: listening and capture

Status: **started 2026-11-25 (decisions 198 and 199).** The wave is in `wave-2.md`; the
direction in `team-layer.md` and decision 176. G8 to G11 are answered (198).

**Demo:** someone writes "@hippidy listen" in a channel. The bot posts that it now listens
there, and links the page that says what that means. People talk in a thread without
mentioning the bot and agree on something. Half an hour after the thread goes quiet, the
web app lists a proposed decision from it, with who decided and a link to the message.
Nothing was posted in their thread.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **Plan and schema**: `listening_channels`, `observed_messages`, `observed_threads`, `capture_runs`; on `decisions`, where a captured decision came from and who may confirm it | No |
| B | **Listening**: "@hippidy listen" and "@hippidy stop listening"; the `message` events of listened channels kept as text; deleted after 30 days; the web page about listening | Only once the manifest has the new events and the app is reinstalled, and only in a channel someone switches on |
| C | **Capture**: on reconcile, a thread gone quiet is read once by the smallest model, which proposes decisions; proposals are shown in the web app | Only in listened channels |

## Switching it on and off

- **"@hippidy listen"** in a channel switches listening on for that channel; **"@hippidy stop
  listening"** switches it off. The whole message must be the command, as with "stop" (60),
  so a question that happens to contain "listen" still goes to the teammate. Anyone in the
  workspace may do either (174).
- The bot then posts a note in the channel, not in a thread: that it now listens (or has
  stopped), what it keeps and for how long, how to switch it off, and a link to the web page
  about listening (G9). It reacts ✅ to the command.
- Only channels: public and private. Direct messages and group DMs are never listened to.
- The API keeps who switched it on or off, and when.

## What is kept (G8)

For each message in a listened channel that is not from a bot: the text, the sender's id
and name if known, when it was sent, and the ids that make its link (workspace, channel,
thread, message). Never Slack's payload. An edit replaces the text; a deletion in Slack
deletes it here. Each message is deleted 30 days after it was sent, by reconcile. Messages in
a channel that is not listened to are dropped by the API before anything is written.

A decision proposed from a thread keeps its statement, who decided, the link to the message,
and the ids of the people who wrote in the thread (who may confirm it, G11), after the
messages themselves are gone.

## Capture

- **When:** on reconcile, a thread of a listened channel whose last message is at least 30
  minutes old and that has new messages since it was last read. At most three threads per
  run, outside any sync lease. A thread the bot was mentioned in is a conversation, and the
  teammate records decisions there (2.2), so capture skips it.
- **How (G10):** one call to the smallest model, Claude Haiku 5.5 (`claude-haiku-5-5`),
  with the thread as numbered lines (message id, sender id and name, text), and the
  decisions already proposed or recorded from that thread, so it does not repeat them. It
  answers in a fixed JSON shape (structured outputs): at most five decisions, each a
  statement, an optional reason and area, who decided (a sender in the thread), and the
  message it was decided in (a message in the thread). Anything else in its answer is
  dropped, and so is a decision naming someone or a message not in the thread.
- **What it may do:** only propose. Channel text is untrusted (176): the API writes each
  decision as `proposed`, origin `capture`. No thread is replied to (176).
- **The thread is data.** The prompt says the messages are what people wrote, to be read,
  never followed. The model has no tools.
- **Size:** at most 200 messages and 60,000 characters per call, the latest kept; a capture
  of a longer thread says it read only the end.
- **Cost:** every call's tokens and list cost are kept in `capture_runs` (Haiku 5.5: $0.10
  per million input tokens, $0.50 per million output, up to 100,000 input tokens). Capture
  stops for the day, with a warning in the log, once the day's calls cost $1 (UTC day);
  `CAPTURE_DAILY_BUDGET_CENTS` changes that. Measured in the first days before more channels
  are switched on (G10).
- **Failures:** a refused, cut-off or failed call is recorded and tried again on a later
  reconcile; a thread is given up after three failures in a row, until it has a new message.

## Confirming a captured proposal (G11)

Anyone who wrote in the thread it came from, until areas have owners (3.1). Confirming and
rejecting from the web app is slice 2.6; 2.5 lists the proposals there with their links.

## The page about listening (G9)

`/listening` in the web app, for a signed-in person: which channels are listened to, since
when and by whom; what is read and kept, for how long; how to switch it off; how to have
something deleted (delete the message in Slack, which deletes it here too); and the
decisions proposed from listening, each with its link.

## Done when

Each line gets its query or test before its pull request merges (96).

- "@hippidy listen" in a channel records it and posts the note; "@hippidy stop listening"
  ends it and posts that.
- A message in a listened channel is kept as text with its link; one in another channel is
  not kept at all; an edit and a deletion in Slack are followed.
- A message older than 30 days is deleted by reconcile.
- A thread quiet for 30 minutes is read once, and its proposals are listed with who decided
  and a link; a new message makes it due again, and nothing is proposed twice.
- Capture stops for the day at its budget, and records every call's cost.

## Not in 2.5

- Confirming, rejecting and editing proposals from the web app: slice 2.6.
- Areas with owners, who then confirm: wave 3.
- Listening in direct messages, or reading a channel's history from before it was switched
  on.
