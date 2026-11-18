import type { InboundMessage } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { memoryLogger } from "../testing.ts";
import type { ApiClient, PostMessageResult } from "./api-client.ts";
import fixture from "./fixtures/app-mention.json" with { type: "json" };
import { handleMention, type MentionDelivery, type SlackActions } from "./handler.ts";

const accepted: PostMessageResult = {
  ok: true,
  accepted: { id: "0b6c9a52-2c43-4a8e-9f5e-0d5f2b0a4c11", status: "accepted" },
};

function setup(
  options: { api?: () => Promise<PostMessageResult>; react?: () => Promise<void> } = {},
) {
  const posted: { message: InboundMessage; correlationId: string }[] = [];
  const reactions: { channel: string; timestamp: string; name: string }[] = [];
  const api: ApiClient = {
    postMessage: async (message, correlationId) => {
      posted.push({ message, correlationId });
      return (options.api ?? (() => Promise.resolve(accepted)))();
    },
  };
  const slack: SlackActions = {
    addReaction: async (input) => {
      reactions.push(input);
      await (options.react ?? (() => Promise.resolve()))();
    },
  };
  const { log, lines } = memoryLogger();
  return { deps: { api, slack, log }, posted, reactions, lines };
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

  it("adds no reaction when the API rejects the message", async () => {
    const { deps, reactions, lines } = setup({
      api: () =>
        Promise.resolve({
          ok: false,
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
