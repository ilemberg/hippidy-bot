import { describe, expect, it } from "vitest";
import { memoryLogger } from "../testing.ts";
import type { ApiClient } from "./api-client.ts";
import { handleChannelMessage, listenCommand, listeningNote, toObservation } from "./listening.ts";

// Slice 2.5: Slack's channel messages as observations (decisions 198 and 199).

describe("listenCommand", () => {
  it.each([
    ["listen", "on"],
    ["Listen here", "on"],
    ["start listening in this channel!", "on"],
    ["stop listening", "off"],
    ["Stop  listening here.", "off"],
    ["listen to this", undefined],
    ["stop", undefined],
    ["please listen", undefined],
  ])("reads %j as %s", (text, expected) => {
    expect(listenCommand(text)).toBe(expected);
  });
});

describe("listeningNote", () => {
  it("says what is kept and how to switch it off, with or without the page", () => {
    const on = listeningNote(true, "U1", undefined);
    expect(on).toContain("<@U1> switched listening on");
    expect(on).toContain("30 days");
    expect(on).toContain("stop listening");
    expect(on).not.toContain("<http");
    expect(listeningNote(false, "U1", "https://w.test")).toContain("<https://w.test/listening|");
  });
});

const envelope = (event: Record<string, unknown>) => ({
  team_id: "T1",
  event_id: "Ev1",
  event: { type: "message", channel: "C1", channel_type: "channel", ts: "1700.000100", ...event },
});

describe("toObservation", () => {
  it("maps a person's message, in a thread or starting one", () => {
    expect(toObservation(envelope({ user: "U1", text: " We use Postgres. " }))).toEqual({
      kind: "posted",
      source: "slack",
      workspaceId: "T1",
      channelId: "C1",
      messageId: "1700.000100",
      threadId: "1700.000100",
      actor: { id: "U1" },
      text: "We use Postgres.",
      sentAt: "1970-01-01T00:28:20.000Z",
    });
    expect(
      toObservation(envelope({ user: "U1", text: "agreed", thread_ts: "1699.000001" })),
    ).toMatchObject({ threadId: "1699.000001" });
    expect(
      toObservation(envelope({ user: "U1", text: "also here", subtype: "thread_broadcast" })),
    ).toMatchObject({ kind: "posted" });
  });

  it("clips a long message to what the API keeps", () => {
    const long = toObservation(envelope({ user: "U1", text: "x".repeat(20_000) }));
    expect(long?.kind === "posted" ? long.text.length : 0).toBe(12_000);
  });

  it("maps an edit and a deletion, and ignores an unfurl", () => {
    expect(
      toObservation(
        envelope({
          subtype: "message_changed",
          message: { user: "U1", text: "fixed", ts: "1699.000002", edited: { ts: "1700.000000" } },
        }),
      ),
    ).toMatchObject({ kind: "edited", messageId: "1699.000002", text: "fixed" });
    expect(
      toObservation(
        envelope({ subtype: "message_changed", message: { user: "U1", text: "x", ts: "1.2" } }),
      ),
    ).toBeUndefined();
    expect(
      toObservation(envelope({ subtype: "message_deleted", deleted_ts: "1699.000002" })),
    ).toMatchObject({ kind: "deleted", messageId: "1699.000002" });
  });

  it.each([
    ["a direct message", { user: "U1", text: "hi", channel_type: "im", channel: "D1" }],
    ["a group DM", { user: "U1", text: "hi", channel_type: "mpim" }],
    ["a bot", { bot_id: "B1", text: "beep", subtype: "bot_message" }],
    ["a join", { user: "U1", text: "joined", subtype: "channel_join" }],
    ["a file with no text", { user: "U1", text: "", subtype: "file_share" }],
    ["something else", { type: "reaction_added" }],
  ])("ignores %s", (_name, event) => {
    expect(toObservation(envelope(event))).toBeUndefined();
  });
});

describe("handleChannelMessage", () => {
  function api(observe: ApiClient["observe"]): ApiClient {
    return { observe } as unknown as ApiClient;
  }

  it("forwards a message with its sender's name, and drops a retry after a timeout", async () => {
    const sent: unknown[] = [];
    const deps = {
      api: api((observation) => {
        sent.push(observation);
        return Promise.resolve({ kind: "done", result: { result: "not_listening" } });
      }),
      userName: () => Promise.resolve("Ada"),
      log: memoryLogger().log,
    };
    const body = envelope({ user: "U1", text: "hello" });
    expect(await handleChannelMessage({ body, retryNum: 0, retryReason: "" }, deps)).toBe(
      "observed",
    );
    expect(sent).toMatchObject([{ actor: { id: "U1", displayName: "Ada" } }]);
    expect(
      await handleChannelMessage({ body, retryNum: 1, retryReason: "http_timeout" }, deps),
    ).toBe("dropped_retry");
    expect(
      await handleChannelMessage(
        { body: envelope({ bot_id: "B1" }), retryNum: 0, retryReason: "" },
        deps,
      ),
    ).toBe("ignored");
    expect(sent).toHaveLength(1);
  });

  it("logs a refusal and never throws", async () => {
    const { log, lines } = memoryLogger();
    const deps = {
      api: api(() => Promise.reject(new Error("down"))),
      userName: () => Promise.reject(new Error("no")),
      log,
    };
    expect(
      await handleChannelMessage(
        { body: envelope({ user: "U1", text: "hi" }), retryNum: 0, retryReason: "" },
        deps,
      ),
    ).toBe("api_rejected");
    expect(lines.map((l) => l.msg)).toEqual(["slack.user_lookup_failed", "slack.api_call_failed"]);
  });
});
