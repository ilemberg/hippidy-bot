# Slice 3.4: daily briefs by direct message

Status: **built 2026-11-26, not merged (decisions 212 and 213).** The wave is in `wave-3.md`.

**Demo:** at about 9:00 on a weekday in her own time zone, Ada gets one direct message from the
bot: two decisions were proposed in `search` yesterday, one waiting for her; a pull request
touched `search`; Grace has been waiting on her for a review for two days; one conflict is
hers to settle. Each line links to its page in the web app or its thread. Grace, with nothing
new, gets nothing. Linus writes "stop briefs" to the bot and gets no more until he writes
"start briefs". On the web app's `/brief` page anyone sees what their brief would say now.

## What it needs

| Part | What | Live behaviour changes? |
|---|---|---|
| A | **Schema**: `brief_people` (who, their time zone, whether they said stop, the direct message channel) and `briefs` (one per person per local day: what it said, sent or not) | No |
| B | **The brief**: built from the records, no model; `GET /v1/briefs/me` for the web app's preview, and `POST /v1/briefs/me` to switch them off or on | Only the web app |
| C | **Direct messages**: the Slack adapter opens a direct message and posts in it; reads a person's time zone; "stop briefs" and "start briefs" as a direct message or a mention | **Yes**: the bot answers those two commands |
| D | **Sending**: reconcile sends the day's briefs, outside any lease, a few per run | **Yes**: people get briefs |
| E | **The page**: `/brief` in the web app | Only the web app |

## Who gets one (G13)

Everyone in the workspace who has written to the bot, owns an area, or is waited on (an open
wait), unless they said "stop briefs". Nobody else is messaged: a person the bot has never
dealt with does not hear from it.

## When

On weekdays, the first reconcile after 9:00 in the person's Slack time zone (read with
`users.info`, kept, and read again after a week), and before noon there: a brief missed by
noon is not sent that day. One brief a day at most (rule 13); one row per person and local day,
taken by one run only before it is sent, so overlapping runs send it once (213). A send that
fails is tried again on the next runs, three times at most. At most ten briefs a reconcile run,
and no new send after 20 seconds, so it stays short. A time zone that cannot be read is asked
again later; nobody gets a brief on a guessed clock (213). Slack has no zone for them: UTC.

## What is in it

Built from the records since the person's last brief (at most three days back, so a first
brief or one after a weekend is not a wall), with no model and no Slack lookup:

- **Waiting on you:** open waits where they are the person waited on, oldest first, with how
  long.
- **Yours to decide:** open conflicts where they are a decider; proposals they may confirm as a
  decider (3.2) or as owner of the area (3.1).
- **In your areas:** decisions recorded or proposed in areas they own; changes and pull requests
  named for those areas (`change_areas`).
- **Your areas:** an area whose owner changed to or from them (3.1).
- **You are waiting on:** their own open waits, so they can end one that is done.

Each section lists at most five lines and says how many more there are; each line links to its
page in the web app (`WEB_BASE_URL`) or its thread. A brief is sent only when something in it is
new since the last one: what still waits rides along but never sends one alone (rule 13, 213).
It is one Slack message, links to the whole brief in the web app, and ends with "Reply stop
briefs to stop these."

## Stop and start

"stop briefs" and "start briefs", each the whole message: written to the bot in a direct
message, or after a mention anywhere. The bot answers once, in the same place. In the web app,
`/brief` has the same switch. A direct message that is neither command gets one line saying
what the bot does in direct messages for now; talking to the bot there is not in 3.4.

## By hand, the owner's

Update the Slack app from `slack/manifest.yaml` and reinstall it: it gains `im:write` (to open a
direct message), `im:history` and the `message.im` event (to read "stop briefs" there). Until
then, sending fails, is logged, and is tried again the next day.

## Done when

Each line gets its query or test before its pull request merges (96).

- A person with something new gets one brief on a weekday morning in their time zone, once,
  with each section and its links; a person with nothing gets none.
- "stop briefs" stops them, in a direct message or after a mention, and "start briefs" starts
  them again; the web app's switch does the same.
- A failed send is retried at most three times; a brief is never sent twice for one day.
- `/brief` shows a person what their brief would say now.

## Not in 3.4

- Talking to the bot in a direct message about anything else.
- Choosing another hour, or days, for one's brief: later, if wanted.
- Acting for a person in a shared space (G13).
