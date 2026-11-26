import type { SetBriefsRequest } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { memoryLogger } from "../testing.ts";
import type { ApiClient, SetBriefsCallResult } from "./api-client.ts";
import {
  BRIEFS_STARTED_TEXT,
  BRIEFS_STOPPED_TEXT,
  DIRECT_MESSAGE_HELP_TEXT,
  handleDirectMessage,
  isDirectMessageEvent,
  type BriefsSlack,
} from "./briefs.ts";

// Slice 3.4: "stop briefs" and "start briefs" in the bot's direct message (decision 212).

const BOT = "U0BOT";

const direct = (event: Record<string, unknown>) => ({
  type: "event_callback",
  team_id: "T1",
  event_id: "EvD1",
  authorizations: [{ user_id: BOT }],
  event: {
    type: "message",
    channel: "D0PERSON",
    channel_type: "im",
    user: "U7",
    text: "stop briefs",
    ts: "1700000000.000100",
    ...event,
  },
});

function setup(
  options: {
    setBriefs?: (request: SetBriefsRequest) => Promise<SetBriefsCallResult>;
    post?: () => Promise<void>;
    userName?: () => Promise<string | undefined>;
  } = {},
) {
  const switches: { request: SetBriefsRequest; correlationId: string }[] = [];
  const replies: { channel: string; text: string; threadTs?: string }[] = [];
  const api = {
    setBriefs: (request: SetBriefsRequest, correlationId: string) => {
      switches.push({ request, correlationId });
      return (
        options.setBriefs ??
        ((r: SetBriefsRequest): Promise<SetBriefsCallResult> =>
          Promise.resolve({ kind: "done", result: { on: r.on } }))
      )(request);
    },
  } as unknown as ApiClient;
  const slack: BriefsSlack = {
    userName: options.userName ?? (() => Promise.resolve("Linus")),
    postMessage: async (input) => {
      replies.push(input);
      await (options.post ?? (() => Promise.resolve()))();
    },
  };
  const { log, lines } = memoryLogger();
  const handle = (body: unknown, retryNum = 0, retryReason = "") =>
    handleDirectMessage({ body, retryNum, retryReason }, { api, slack, log });
  return { handle, switches, replies, lines };
}

describe("isDirectMessageEvent", () => {
  it("tells a direct message from a channel's", () => {
    expect(isDirectMessageEvent(direct({}))).toBe(true);
    expect(isDirectMessageEvent(direct({ channel_type: "channel", channel: "C1" }))).toBe(false);
    expect(isDirectMessageEvent(direct({ channel_type: "mpim" }))).toBe(false);
    expect(isDirectMessageEvent({})).toBe(false);
  });
});

describe("handleDirectMessage", () => {
  it('switches briefs off on "stop briefs", as the person, and answers once in the DM', async () => {
    const { handle, switches, replies } = setup();
    expect(await handle(direct({}))).toBe("briefs_set");
    expect(switches).toEqual([
      {
        request: {
          source: "slack",
          workspaceId: "T1",
          actor: { id: "U7", displayName: "Linus" },
          on: false,
        },
        correlationId: "EvD1",
      },
    ]);
    expect(replies).toEqual([{ channel: "D0PERSON", text: BRIEFS_STOPPED_TEXT }]);
  });

  it('switches them on with "Start briefs!", and with a mention of the bot in front', async () => {
    const { handle, switches, replies } = setup();
    expect(await handle(direct({ text: "Start briefs!" }))).toBe("briefs_set");
    expect(await handle(direct({ text: `<@${BOT}> start briefs` }))).toBe("briefs_set");
    expect(switches.map((s) => s.request.on)).toEqual([true, true]);
    expect(replies.map((r) => r.text)).toEqual([BRIEFS_STARTED_TEXT, BRIEFS_STARTED_TEXT]);
  });

  it("answers in the DM's thread when the command was written in one", async () => {
    const { handle, replies } = setup();
    await handle(direct({ thread_ts: "1699999999.000001" }));
    expect(replies).toEqual([
      { channel: "D0PERSON", text: BRIEFS_STOPPED_TEXT, threadTs: "1699999999.000001" },
    ]);
  });

  it("answers anything else with one line, and does not call the API", async () => {
    const { handle, switches, replies } = setup();
    expect(await handle(direct({ text: "what is waiting on me?" }))).toBe("answered");
    expect(switches).toEqual([]);
    expect(replies).toEqual([{ channel: "D0PERSON", text: DIRECT_MESSAGE_HELP_TEXT }]);
  });

  it("never answers the bot's own messages, another bot's, or edits, deletions and joins", async () => {
    const { handle, switches, replies } = setup();
    const ignored = [
      // The bot's own reply, as Slack sends it back: its user id and a bot id.
      direct({ user: BOT, bot_id: "B0BOT", text: DIRECT_MESSAGE_HELP_TEXT }),
      direct({ user: BOT, text: "stop briefs" }),
      direct({ bot_id: "B0OTHER", text: "stop briefs" }),
      direct({ subtype: "bot_message", user: undefined, bot_id: "B0BOT" }),
      direct({ subtype: "message_changed", user: undefined }),
      direct({ subtype: "message_deleted", user: undefined }),
      direct({ subtype: "file_share" }),
    ];
    for (const body of ignored) expect(await handle(body)).toBe("ignored");
    expect(switches).toEqual([]);
    expect(replies).toEqual([]);
  });

  it("drops a retry that follows a timeout, so it does not answer twice", async () => {
    const { handle, replies } = setup();
    expect(await handle(direct({}), 1, "http_timeout")).toBe("dropped_retry");
    expect(await handle(direct({}), 1, "http_error")).toBe("briefs_set");
    expect(replies).toHaveLength(1);
  });

  it("switches without a name when the lookup fails", async () => {
    const { handle, switches } = setup({ userName: () => Promise.reject(new Error("no")) });
    expect(await handle(direct({}))).toBe("briefs_set");
    expect(switches[0]?.request.actor).toEqual({ id: "U7" });
  });

  it("logs a refusal and says nothing, and never throws", async () => {
    const refused = setup({
      setBriefs: () => Promise.resolve({ kind: "rejected", status: 503, error: undefined }),
    });
    expect(await refused.handle(direct({}))).toBe("api_rejected");
    expect(refused.replies).toEqual([]);
    expect(refused.lines).toContainEqual(
      expect.objectContaining({
        msg: "slack.briefs_rejected",
        status: 503,
        correlationId: "EvD1",
      }),
    );
    const thrown = setup({ setBriefs: () => Promise.reject(new Error("down")) });
    expect(await thrown.handle(direct({}))).toBe("api_rejected");
  });

  it("still counts briefs switched when the answer cannot be posted", async () => {
    const { handle, lines } = setup({ post: () => Promise.reject(new Error("not_in_channel")) });
    expect(await handle(direct({}))).toBe("briefs_set");
    expect(lines).toContainEqual(expect.objectContaining({ msg: "slack.briefs_reply_failed" }));
    const other = setup({ post: () => Promise.reject(new Error("not_in_channel")) });
    expect(await other.handle(direct({ text: "hello" }))).toBe("reply_failed");
  });

  it("ignores an event it cannot read, and logs why", async () => {
    const { handle, lines } = setup();
    expect(await handle({ event: { type: "message", channel_type: "im" } })).toBe("invalid_event");
    expect(lines).toContainEqual(expect.objectContaining({ msg: "slack.direct_message.invalid" }));
  });
});
