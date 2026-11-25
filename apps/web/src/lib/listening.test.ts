import { describe, expect, it } from "vitest";
import { loadListening } from "./listening.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { messageLink } from "./sessions-view.ts";
import { config } from "./testing.ts";
import { signSession, type Person } from "./tokens.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const channel = {
  source: "slack",
  workspaceId: "T0123456789",
  channelId: "C1",
  listening: true,
  startedAt: "2026-11-25T10:00:00.000Z",
  changedAt: "2026-11-25T10:00:00.000Z",
  changedBy: { actorId: "U1", name: "Ada" },
};

describe("loadListening", () => {
  it("reads where the bot listens and the proposals from listening, as the person", async () => {
    const urls: string[] = [];
    const fetch: Fetch = (url) => {
      urls.push(url);
      return Promise.resolve(
        url.includes("/v1/listening")
          ? Response.json({ channels: [channel], retentionDays: 30 })
          : Response.json({ decisions: [] }),
      );
    };
    const cookie = await signSession(person, config.sessionSecret);
    const view = await loadListening(
      { sessionCookie: cookie },
      { config, fetch, log: memoryLogger().log, now: () => new Date("2026-11-25T11:00:00Z") },
    );
    expect(view).toMatchObject({
      kind: "signed_in",
      listening: { kind: "ok", value: { channels: [channel] } },
      proposals: { kind: "ok", value: [] },
    });
    expect(urls.sort()).toEqual([
      "https://api.example.test/v1/decisions?status=proposed&origin=capture&limit=50",
      "https://api.example.test/v1/listening",
    ]);
  });

  it("asks a signed-out visitor to sign in, and calls nothing", async () => {
    const fetch: Fetch = () => Promise.reject(new Error("no call expected"));
    expect(
      await loadListening({ sessionCookie: undefined }, { config, fetch, log: memoryLogger().log }),
    ).toEqual({ kind: "signed_out" });
  });
});

describe("messageLink", () => {
  it("links a reply in its thread, and a thread's first message alone", () => {
    expect(messageLink("slack", "C1", "1700.000100", "1700.000200")).toBe(
      "https://slack.com/archives/C1/p1700000200?thread_ts=1700.000100&cid=C1",
    );
    expect(messageLink("slack", "C1", "1700.000100", "1700.000100")).toBe(
      "https://slack.com/archives/C1/p1700000100",
    );
    expect(messageLink("ui", "C1", null, "1")).toBeUndefined();
  });
});
