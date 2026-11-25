import type { InboundMessage, StartBriefRequest, StopRequest } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { memoryLogger } from "../testing.ts";
import type { ApiClient, PostMessageResult, StartBriefCallResult } from "./api-client.ts";
import fixture from "./fixtures/app-mention.json" with { type: "json" };
import {
  handleMention,
  handleReaction,
  handleConfirmDecisionAction,
  handleStartBriefAction,
  isStopCommand,
  type MentionDelivery,
  type SlackActions,
} from "./handler.ts";
import type { SlackThreadMessage } from "./thread.ts";

const accepted: PostMessageResult = {
  kind: "accepted",
  accepted: { id: "0b6c9a52-2c43-4a8e-9f5e-0d5f2b0a4c11", status: "accepted" },
};

function setup(
  options: {
    api?: () => Promise<PostMessageResult>;
    react?: () => Promise<void>;
    userName?: (id: string) => Promise<string | undefined>;
    threadReplies?: (channel: string, threadTs: string) => Promise<SlackThreadMessage[]>;
    startBrief?: () => Promise<StartBriefCallResult>;
  } = {},
) {
  const threadReads: { channel: string; threadTs: string }[] = [];
  const posted: { message: InboundMessage; correlationId: string }[] = [];
  const stops: StopRequest[] = [];
  const starts: { briefId: string; request: StartBriefRequest; correlationId: string }[] = [];
  const confirms: { decisionId: string; request: unknown; correlationId: string }[] = [];
  const reactions: { channel: string; timestamp: string; name: string }[] = [];
  const api: ApiClient = {
    postMessage: async (message, correlationId) => {
      posted.push({ message, correlationId });
      return (options.api ?? (() => Promise.resolve(accepted)))();
    },
    stop: (request) => {
      stops.push(request);
      return Promise.resolve({ kind: "done", result: { status: "stopped" } });
    },
    confirmDecision: (decisionId, request, correlationId) => {
      confirms.push({ decisionId, request, correlationId });
      return Promise.resolve({ kind: "done", result: { status: "confirmed" } });
    },
    startBrief: async (briefId, request, correlationId) => {
      starts.push({ briefId, request, correlationId });
      return (
        options.startBrief ??
        (() => Promise.resolve({ kind: "done", result: { status: "started" } }))
      )();
    },
  };
  const slack: SlackActions = {
    addReaction: async (input) => {
      reactions.push(input);
      await (options.react ?? (() => Promise.resolve()))();
    },
    userName: options.userName ?? (() => Promise.resolve("Ilya")),
    threadReplies: (channel, threadTs) => {
      threadReads.push({ channel, threadTs });
      return (options.threadReplies ?? (() => Promise.resolve([])))(channel, threadTs);
    },
  };
  const { log, lines } = memoryLogger();
  return {
    deps: { api, slack, log, threadReadTimeoutMs: 50 },
    posted,
    stops,
    starts,
    confirms,
    reactions,
    lines,
    threadReads,
  };
}

function mentionSaying(text: string): MentionDelivery {
  return { body: { ...fixture, event: { ...fixture.event, text } }, retryNum: 0, retryReason: "" };
}

const first: MentionDelivery = { body: fixture, retryNum: 0, retryReason: "" };

describe("handleMention", () => {
  it("sends one message to the API and adds one 👀 reaction", async () => {
    const { deps, posted, reactions, lines } = setup();
    expect(await handleMention(first, deps)).toBe("reacted");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.correlationId).toBe("Ev0LAN670R");
    expect(posted[0]?.message.text).toBe("What is the hour of the pearl, ?");
    expect(reactions).toEqual([
      { channel: "C0LAN2Q65", timestamp: "1515449522.000016", name: "eyes" },
    ]);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "slack.mention.raw", correlationId: "Ev0LAN670R" }),
    );
  });

  it("never logs Slack's verification token", async () => {
    const { deps, lines } = setup();
    await handleMention(first, deps);
    expect(JSON.stringify(lines)).not.toContain(fixture.token);
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "slack.mention.raw",
        body: expect.objectContaining({ token: "[redacted]" }) as unknown,
      }),
    );
  });

  it("adds no reaction when the API rejects the message", async () => {
    const { deps, reactions, lines } = setup({
      api: () =>
        Promise.resolve({
          kind: "rejected",
          status: 401,
          error: { code: "unauthorized", message: "nope" },
        }),
    });
    expect(await handleMention(first, deps)).toBe("api_rejected");
    expect(reactions).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "slack.api_rejected", status: 401 }),
    );
  });

  it("adds no reaction when the API call throws", async () => {
    const { deps, reactions } = setup({ api: () => Promise.reject(new Error("down")) });
    expect(await handleMention(first, deps)).toBe("api_rejected");
    expect(reactions).toEqual([]);
  });

  it("treats Slack's already_reacted error as success", async () => {
    const { deps } = setup({
      react: () =>
        Promise.reject(Object.assign(new Error("x"), { data: { error: "already_reacted" } })),
    });
    expect(await handleMention(first, deps)).toBe("reacted");
  });

  it("reports other reaction errors", async () => {
    const { deps, lines } = setup({
      react: () =>
        Promise.reject(Object.assign(new Error("x"), { data: { error: "not_in_channel" } })),
    });
    expect(await handleMention(first, deps)).toBe("reaction_failed");
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "slack.reaction_failed", slackError: "not_in_channel" }),
    );
  });

  it("drops a retry that follows a timeout", async () => {
    const { deps, posted, reactions } = setup();
    const outcome = await handleMention(
      { ...first, retryNum: 1, retryReason: "http_timeout" },
      deps,
    );
    expect(outcome).toBe("dropped_retry");
    expect(posted).toEqual([]);
    expect(reactions).toEqual([]);
  });

  it("processes a retry that follows an error, since the first attempt may have done nothing", async () => {
    const { deps, posted } = setup();
    const outcome = await handleMention({ ...first, retryNum: 1, retryReason: "http_error" }, deps);
    expect(outcome).toBe("reacted");
    expect(posted).toHaveLength(1);
  });

  it("ignores an event it cannot read, and logs why", async () => {
    const { deps, posted, lines } = setup();
    expect(await handleMention({ ...first, body: { event: {} } }, deps)).toBe("invalid_event");
    expect(posted).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ msg: "slack.mention.invalid" }));
  });
});

describe("names", () => {
  it("passes the sender's display name to the API", async () => {
    const { deps, posted } = setup();
    await handleMention(first, deps);
    expect(posted[0]?.message.actor).toEqual({ id: "U061F7AUR", displayName: "Ilya" });
  });

  it("still sends the message when the name lookup fails", async () => {
    const { deps, posted, lines } = setup({
      userName: () => Promise.reject(new Error("missing_scope")),
    });
    expect(await handleMention(first, deps)).toBe("reacted");
    expect(posted[0]?.message.actor).toEqual({ id: "U061F7AUR" });
    expect(lines).toContainEqual(expect.objectContaining({ msg: "slack.user_lookup_failed" }));
  });
});

describe("reading the thread (decision 140)", () => {
  const BOT = "U0LAN0Z89";
  const THREAD = "1515449000.000100";
  const MENTION = "1515449522.000016";
  const inThread: MentionDelivery = {
    body: { ...fixture, event: { ...fixture.event, thread_ts: THREAD } },
    retryNum: 0,
    retryReason: "",
  };
  const names: Record<string, string> = { U1: "Ana", U2: "Ben" };
  const userName = (id: string) => Promise.resolve(names[id]);

  function said(ts: string, user: string, text: string): SlackThreadMessage {
    return { ts, user, text };
  }

  it("sends what people said since the bot's latest message, oldest first, with names", async () => {
    const { deps, posted, threadReads, lines } = setup({
      userName,
      threadReplies: () =>
        Promise.resolve([
          said(THREAD, "U1", "starting the thread"),
          { ts: "1515449100.000001", user: BOT, botId: "B1", text: "the bot's answer" },
          said("1515449200.000001", "U1", "what about caching?"),
          said("1515449300.000001", "U3", "no idea\nreally"),
          said(MENTION, "U061F7AUR", `<@${BOT}> what do you think?`),
          said("1515449600.000001", "U2", "said after the mention"),
        ]),
    });
    expect(await handleMention(inThread, deps)).toBe("reacted");
    expect(threadReads).toEqual([{ channel: "C0LAN2Q65", threadTs: THREAD }]);
    expect(posted[0]?.message.context).toEqual([
      {
        actorId: "U1",
        actorName: "Ana",
        text: "what about caching?",
        sentAt: "2018-01-08T22:06:40.000Z",
      },
      { actorId: "U3", text: "no idea\nreally", sentAt: "2018-01-08T22:08:20.000Z" },
    ]);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "slack.thread_read", contextMessages: 2, dropped: 0 }),
    );
    expect(JSON.stringify(lines)).not.toContain("caching");
  });

  it("takes the whole thread before the mention when the bot has not spoken in it", async () => {
    const { deps, posted } = setup({
      userName,
      threadReplies: () =>
        Promise.resolve([said(THREAD, "U1", "first"), said("1515449100.000001", "U2", "second")]),
    });
    await handleMention(inThread, deps);
    expect(posted[0]?.message.context?.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("leaves out messages that mention the bot, other bots' messages and empty ones", async () => {
    const { deps, posted } = setup({
      userName,
      threadReplies: () =>
        Promise.resolve([
          said("1515449100.000001", "U1", `<@${BOT}> an earlier question`),
          said("1515449101.000001", "U1", `also <@${BOT}|hippidy> this`),
          said("1515449102.000001", "U2", "   "),
          { ts: "1515449103.000001", user: "U2" },
          said("1515449104.000001", "U2", "kept"),
          said("1515449105.000001", "U2", "<@U9OTHER> a mention of someone else"),
        ]),
    });
    await handleMention(inThread, deps);
    expect(posted[0]?.message.context?.map((m) => m.text)).toEqual([
      "kept",
      "<@U9OTHER> a mention of someone else",
    ]);
  });

  it("never sends another app's message, and does not let it hide what came before", async () => {
    const { deps, posted } = setup({
      userName,
      threadReplies: () =>
        Promise.resolve([
          said("1515449100.000001", "U1", "before the other app"),
          { ts: "1515449101.000001", botId: "B2", text: "another bot" },
          said("1515449102.000001", "U1", "after"),
        ]),
    });
    await handleMention(inThread, deps);
    expect(posted[0]?.message.context?.map((m) => m.text)).toEqual([
      "before the other app",
      "after",
    ]);
  });

  it("sends no context when nothing was said since the bot's latest message", async () => {
    const { deps, posted } = setup({
      threadReplies: () =>
        Promise.resolve([
          said(THREAD, "U1", "question"),
          { ts: "1515449100.000001", user: BOT, text: "answer" },
        ]),
    });
    await handleMention(inThread, deps);
    expect(posted[0]?.message).not.toHaveProperty("context");
  });

  it("does not read the thread for a top-level mention", async () => {
    const { deps, posted, threadReads } = setup({
      threadReplies: () => Promise.resolve([said("1515449100.000001", "U1", "x")]),
    });
    await handleMention(first, deps);
    expect(threadReads).toEqual([]);
    expect(posted[0]?.message).not.toHaveProperty("context");
  });

  it("keeps the latest 50 messages and caps each at 4000 characters", async () => {
    const messages = Array.from({ length: 60 }, (_, i) =>
      said(`1515449${String(100 + i)}.000001`, "U1", `${String(i)} ${"x".repeat(5000)}`),
    );
    const { deps, posted } = setup({ userName, threadReplies: () => Promise.resolve(messages) });
    await handleMention(inThread, deps);
    const context = posted[0]?.message.context ?? [];
    // 50 messages of 4000 characters are more than the API takes in one body, so the oldest
    // are dropped to fit; the newest is always kept.
    expect(context.length).toBeGreaterThan(0);
    expect(context.length).toBeLessThanOrEqual(50);
    expect(context.at(-1)?.text.startsWith("59 ")).toBe(true);
    expect(context.every((m) => m.text.length === 4000)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(posted[0]?.message))).toBeLessThanOrEqual(64 * 1024);
  });

  it("keeps at most 50 messages", async () => {
    const messages = Array.from({ length: 60 }, (_, i) =>
      said(`1515449${String(100 + i)}.000001`, "U1", `m${String(i)}`),
    );
    const { deps, posted } = setup({ threadReplies: () => Promise.resolve(messages) });
    await handleMention(inThread, deps);
    const texts = posted[0]?.message.context?.map((m) => m.text) ?? [];
    expect(texts).toHaveLength(50);
    expect(texts[0]).toBe("m10");
    expect(texts.at(-1)).toBe("m59");
  });

  it("leaves a name out when its lookup fails", async () => {
    const { deps, posted } = setup({
      userName: (id) => (id === "U1" ? Promise.reject(new Error("x")) : Promise.resolve("Me")),
      threadReplies: () => Promise.resolve([said("1515449100.000001", "U1", "hi")]),
    });
    await handleMention(inThread, deps);
    expect(posted[0]?.message.context).toEqual([
      { actorId: "U1", text: "hi", sentAt: "2018-01-08T22:05:00.000Z" },
    ]);
    expect(posted[0]?.message.actor.displayName).toBe("Me");
  });

  it("answers as before, with a warning, when Slack refuses to read the thread", async () => {
    const { deps, posted, reactions, lines } = setup({
      threadReplies: () =>
        Promise.reject(
          Object.assign(new Error("An API error occurred: missing_scope"), {
            code: "slack_webapi_platform_error",
            data: { ok: false, error: "missing_scope", needed: "channels:history" },
          }),
        ),
    });
    expect(await handleMention(inThread, deps)).toBe("reacted");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.message).not.toHaveProperty("context");
    expect(reactions).toHaveLength(1);
    const warning = lines.find((line) => line.msg === "slack.thread_read_failed");
    expect(warning).toMatchObject({ level: "warn", slackError: "missing_scope" });
    expect(Object.keys(warning ?? {})).not.toContain("error");
  });

  it("answers as before when reading the thread takes too long", async () => {
    const { deps, posted, lines } = setup({
      threadReplies: () => new Promise<never>(() => undefined),
    });
    expect(await handleMention(inThread, deps)).toBe("reacted");
    expect(posted[0]?.message).not.toHaveProperty("context");
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "slack.thread_read_failed", slackError: "timeout" }),
    );
  });
});

describe("stop", () => {
  it.each(["stop", "Stop", " STOP ", "stop!", "stop."])("%j is a stop command", (text) => {
    expect(isStopCommand(text)).toBe(true);
  });

  it.each(["don't stop", "stop the build", "please stop", "", "stopping"])(
    "%j is not a stop command",
    (text) => {
      expect(isStopCommand(text)).toBe(false);
    },
  );

  it("sends '@bot stop' to the API as a stop for the thread, with no 👀", async () => {
    const { deps, posted, stops, reactions } = setup();
    expect(await handleMention(mentionSaying("<@U0LAN0Z89> stop"), deps)).toBe("stopped");
    expect(posted).toEqual([]);
    expect(reactions).toEqual([]);
    expect(stops).toEqual([
      {
        source: "slack",
        sourceEventId: "Ev0LAN670R",
        workspaceId: "T061EG9R6",
        channelId: "C0LAN2Q65",
        threadId: "1515449522.000016",
        stopMessage: { messageId: "1515449522.000016", sentAt: "2018-01-08T22:12:02.000Z" },
        actor: { id: "U061F7AUR" },
      },
    ]);
  });

  it("treats 'don't stop' as an ordinary message", async () => {
    const { deps, posted, stops } = setup();
    expect(await handleMention(mentionSaying("<@U0LAN0Z89> don't stop"), deps)).toBe("reacted");
    expect(stops).toEqual([]);
    expect(posted).toHaveLength(1);
  });
});

describe("handleReaction", () => {
  function reaction(overrides: { reaction?: string; user?: string } = {}) {
    return {
      team_id: "T1",
      event_id: "EvR1",
      authorizations: [{ user_id: "UBOT" }],
      event: {
        type: "reaction_added",
        user: overrides.user ?? "U1",
        reaction: overrides.reaction ?? "octagonal_sign",
        item: { type: "message", channel: "C1", ts: "100.000001" },
      },
    };
  }

  it("asks the API to stop the conversation the 🛑 was put on", async () => {
    const { deps, stops } = setup();
    expect(await handleReaction(reaction(), deps)).toBe("stopped");
    expect(stops).toEqual([
      {
        source: "slack",
        sourceEventId: "EvR1",
        workspaceId: "T1",
        channelId: "C1",
        messageId: "100.000001",
        actor: { id: "U1" },
      },
    ]);
  });

  it("ignores other reactions, and the bot's own 🛑", async () => {
    const { deps, stops } = setup();
    expect(await handleReaction(reaction({ reaction: "eyes" }), deps)).toBe("ignored");
    expect(await handleReaction(reaction({ user: "UBOT" }), deps)).toBe("ignored");
    expect(stops).toEqual([]);
  });

  it("ignores a 🛑 when it can't tell the bot's own reactions apart", async () => {
    const { deps, stops } = setup();
    const { authorizations: _a, ...withoutBotId } = reaction();
    expect(await handleReaction(withoutBotId, deps)).toBe("ignored");
    expect(stops).toEqual([]);
  });
});

describe("handleStartBriefAction", () => {
  const briefId = "6f1c2a9e-4b7d-4c3a-9e2f-1a2b3c4d5e6f";

  function press(overrides: { actionId?: string; value?: string; withActionTs?: boolean } = {}) {
    return {
      type: "block_actions",
      token: "legacy-verification-token",
      trigger_id: "1234.5678.abcd",
      team: { id: "T1", domain: "acme" },
      user: { id: "U2", username: "ilya", team_id: "T1" },
      channel: { id: "C1", name: "general" },
      message: { ts: "100.000002", thread_ts: "100.000001" },
      actions: [
        {
          type: "button",
          block_id: "b1",
          action_id: overrides.actionId ?? "start_change",
          value: overrides.value ?? briefId,
          text: { type: "plain_text", text: "Start" },
          ...(overrides.withActionTs === false ? {} : { action_ts: "1700000000.123456" }),
        },
      ],
    };
  }

  it("starts the brief as the person who pressed Start, with their name", async () => {
    const { deps, starts, lines } = setup({ userName: () => Promise.resolve("Ilya") });
    expect(await handleStartBriefAction(press(), deps)).toBe("started");
    expect(starts).toEqual([
      {
        briefId,
        request: { source: "slack", workspaceId: "T1", actor: { id: "U2", displayName: "Ilya" } },
        correlationId: "1700000000.123456",
      },
    ]);
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "slack.brief_start",
        correlationId: "1700000000.123456",
        result: "started",
      }),
    );
    expect(JSON.stringify(lines)).not.toContain("legacy-verification-token");
  });

  it("uses the trigger id as the correlation id when the action has no timestamp", async () => {
    const { deps, starts } = setup();
    await handleStartBriefAction(press({ withActionTs: false }), deps);
    expect(starts[0]?.correlationId).toBe("1234.5678.abcd");
  });

  it("passes on what the API says, for example that it was already started", async () => {
    const { deps } = setup({
      startBrief: () => Promise.resolve({ kind: "done", result: { status: "already_started" } }),
    });
    expect(await handleStartBriefAction(press(), deps)).toBe("already_started");
  });

  it("still starts the brief when the name lookup fails, without a name", async () => {
    const { deps, starts, lines } = setup({
      userName: () => Promise.reject(new Error("users_not_found")),
    });
    expect(await handleStartBriefAction(press(), deps)).toBe("started");
    expect(starts[0]?.request.actor).toEqual({ id: "U2" });
    expect(lines).toContainEqual(expect.objectContaining({ msg: "slack.user_lookup_failed" }));
  });

  it("logs the API's rejection, and does not throw", async () => {
    const error = { code: "not_found" as const, message: "No such route" };
    const { deps, lines } = setup({
      startBrief: () => Promise.resolve({ kind: "rejected", status: 404, error }),
    });
    expect(await handleStartBriefAction(press(), deps)).toBe("api_rejected");
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "slack.brief_start_rejected", status: 404, error }),
    );
  });

  it("does not throw when the API call does", async () => {
    const { deps, lines } = setup({ startBrief: () => Promise.reject(new Error("boom")) });
    expect(await handleStartBriefAction(press(), deps)).toBe("api_rejected");
    expect(lines).toContainEqual(expect.objectContaining({ msg: "slack.api_call_failed" }));
  });

  it("ignores an action that is not the Start button", async () => {
    const { deps, starts } = setup();
    expect(await handleStartBriefAction(press({ actionId: "something_else" }), deps)).toBe(
      "ignored",
    );
    expect(starts).toEqual([]);
  });

  it("rejects a payload it cannot read, and one whose value is not a brief id", async () => {
    const { deps, starts, lines } = setup();
    expect(await handleStartBriefAction({ type: "block_actions", actions: [] }, deps)).toBe(
      "invalid_action",
    );
    expect(await handleStartBriefAction("not even an object", deps)).toBe("invalid_action");
    expect(await handleStartBriefAction(press({ value: "../stop" }), deps)).toBe("invalid_action");
    expect(starts).toEqual([]);
    expect(lines.filter((line) => line.msg === "slack.brief_start.invalid")).toHaveLength(3);
  });
});

describe("handleConfirmDecisionAction (slice 2.2)", () => {
  const decisionId = "7a1c2a9e-4b7d-4c3a-9e2f-1a2b3c4d5e6f";

  function press(actionId = "confirm_decision", value = decisionId) {
    return {
      type: "block_actions",
      token: "legacy-verification-token",
      trigger_id: "1234.5678.abcd",
      team: { id: "T1" },
      user: { id: "U3" },
      actions: [{ type: "button", action_id: actionId, value, action_ts: "1700000001.000001" }],
    };
  }

  it("confirms the decision as the person who pressed Confirm, with their name", async () => {
    const { deps, confirms, lines } = setup({ userName: () => Promise.resolve("Grace") });
    expect(await handleConfirmDecisionAction(press(), deps)).toBe("confirmed");
    expect(confirms).toEqual([
      {
        decisionId,
        request: { source: "slack", workspaceId: "T1", actor: { id: "U3", displayName: "Grace" } },
        correlationId: "1700000001.000001",
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("legacy-verification-token");
  });

  it("ignores other buttons, and refuses a value that is not a decision id", async () => {
    const { deps, confirms } = setup();
    expect(await handleConfirmDecisionAction(press("start_change"), deps)).toBe("ignored");
    expect(await handleConfirmDecisionAction(press("confirm_decision", "nope"), deps)).toBe(
      "invalid_action",
    );
    expect(await handleConfirmDecisionAction({ type: "view_submission" }, deps)).toBe(
      "invalid_action",
    );
    expect(confirms).toEqual([]);
  });
});
