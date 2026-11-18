import type { InboundMessage, StopRequest } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { memoryLogger } from "../testing.ts";
import type { ApiClient, PostMessageResult } from "./api-client.ts";
import fixture from "./fixtures/app-mention.json" with { type: "json" };
import {
  handleMention,
  handleReaction,
  isStopCommand,
  type MentionDelivery,
  type SlackActions,
} from "./handler.ts";

const accepted: PostMessageResult = {
  kind: "accepted",
  accepted: { id: "0b6c9a52-2c43-4a8e-9f5e-0d5f2b0a4c11", status: "accepted" },
};

function setup(
  options: {
    api?: () => Promise<PostMessageResult>;
    react?: () => Promise<void>;
    userName?: (id: string) => Promise<string | undefined>;
  } = {},
) {
  const posted: { message: InboundMessage; correlationId: string }[] = [];
  const stops: StopRequest[] = [];
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
  };
  const slack: SlackActions = {
    addReaction: async (input) => {
      reactions.push(input);
      await (options.react ?? (() => Promise.resolve()))();
    },
    userName: options.userName ?? (() => Promise.resolve("Ilya")),
  };
  const { log, lines } = memoryLogger();
  return { deps: { api, slack, log }, posted, stops, reactions, lines };
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
