import type { DeliveryTarget } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { createSlackDeliverer, withMentions, type SlackPoster } from "./deliver.ts";

const target: DeliveryTarget = {
  source: "slack",
  workspaceId: "T1",
  channelId: "C1",
  threadId: "100.000001",
};

function fakePoster(failWith?: string) {
  const calls: string[] = [];
  const fail = (what: string) => {
    calls.push(what);
    return failWith === undefined
      ? Promise.resolve()
      : Promise.reject(Object.assign(new Error(failWith), { data: { error: failWith } }));
  };
  const poster: SlackPoster = {
    postMessage: (input) => {
      calls.push(`post ${input.channel} ${input.thread_ts ?? "-"} ${input.text}`);
      return Promise.resolve();
    },
    addReaction: (input) => fail(`add ${input.timestamp} ${input.name}`),
    removeReaction: (input) => fail(`remove ${input.timestamp} ${input.name}`),
    openDirect: (userId) => {
      calls.push(`open ${userId}`);
      return Promise.resolve(`D-${userId}`);
    },
    userTimeZone: () => Promise.resolve(undefined),
  };
  return { poster, calls };
}

describe("createSlackDeliverer", () => {
  it("posts a reply in the thread, converted to Slack's format", async () => {
    const { poster, calls } = fakePoster();
    await createSlackDeliverer(poster).deliver({ kind: "reply", target, text: "**Yes.**" }, "c");
    expect(calls).toEqual(["post C1 100.000001 *Yes.*"]);
  });

  it("swaps 👀 for ✅ on every answered message", async () => {
    const { poster, calls } = fakePoster();
    await createSlackDeliverer(poster).deliver(
      { kind: "status", target, messageIds: ["1.1", "1.2"], status: "answered" },
      "c",
    );
    expect(calls).toEqual([
      "add 1.1 white_check_mark",
      "remove 1.1 eyes",
      "add 1.2 white_check_mark",
      "remove 1.2 eyes",
    ]);
  });

  it("uses ❌ for failed and 🛑 for stopped", async () => {
    const { poster, calls } = fakePoster();
    const deliverer = createSlackDeliverer(poster);
    await deliverer.deliver({ kind: "status", target, messageIds: ["1"], status: "failed" }, "c");
    await deliverer.deliver({ kind: "status", target, messageIds: ["2"], status: "stopped" }, "c");
    expect(calls).toContain("add 1 x");
    expect(calls).toContain("add 2 octagonal_sign");
  });

  it("treats a reaction that is already there, or already gone, as done", async () => {
    for (const code of ["already_reacted", "no_reaction"]) {
      const { poster } = fakePoster(code);
      await expect(
        createSlackDeliverer(poster).deliver(
          { kind: "status", target, messageIds: ["1"], status: "answered" },
          "c",
        ),
      ).resolves.toBeUndefined();
    }
  });

  it("fails the delivery on any other Slack error, so it is retried", async () => {
    const { poster } = fakePoster("not_in_channel");
    await expect(
      createSlackDeliverer(poster).deliver(
        { kind: "status", target, messageIds: ["1"], status: "answered" },
        "c",
      ),
    ).rejects.toThrow("not_in_channel");
  });

  describe("briefs", () => {
    const briefId = "6f1c2a9e-4b7d-4c3a-9e2f-1a2b3c4d5e6f";

    function recordingPoster() {
      const posts: Parameters<SlackPoster["postMessage"]>[0][] = [];
      const poster: SlackPoster = {
        postMessage: (input) => {
          posts.push(input);
          return Promise.resolve();
        },
        addReaction: () => Promise.resolve(),
        removeReaction: () => Promise.resolve(),
        openDirect: () => Promise.resolve("D1"),
        userTimeZone: () => Promise.resolve(undefined),
      };
      return { poster, posts };
    }

    it("posts the brief in the thread with a Start button when a person must start it", async () => {
      const { poster, posts } = recordingPoster();
      await createSlackDeliverer(poster).deliver(
        { kind: "brief", target, briefId, text: "**Fix** the `README`", needsStart: true },
        "c",
      );
      expect(posts).toEqual([
        {
          channel: "C1",
          thread_ts: "100.000001",
          text: "*Fix* the `README`",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "*Fix* the `README`" } },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Start" },
                  style: "primary",
                  action_id: "start_change",
                  value: briefId,
                },
              ],
            },
          ],
        },
      ]);
    });

    it("posts a proposed decision with a Confirm button, and an active one without (slice 2.2)", async () => {
      const { poster, posts } = recordingPoster();
      const decisionId = "7a1c2a9e-4b7d-4c3a-9e2f-1a2b3c4d5e6f";
      const deliverer = createSlackDeliverer(poster);
      await deliverer.deliver(
        { kind: "decision", target, decisionId, text: "**Proposed**", needsConfirm: true },
        "c",
      );
      await deliverer.deliver(
        { kind: "decision", target, decisionId, text: "**Recorded**", needsConfirm: false },
        "c",
      );
      expect(posts[0]?.blocks?.[1]).toEqual({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Confirm" },
            style: "primary",
            action_id: "confirm_decision",
            value: decisionId,
          },
        ],
      });
      expect(posts[1]?.blocks).toEqual([
        { type: "section", text: { type: "mrkdwn", text: "*Recorded*" } },
      ]);
    });

    it("posts the brief with no button when it starts by itself", async () => {
      const { poster, posts } = recordingPoster();
      await createSlackDeliverer(poster).deliver(
        { kind: "brief", target, briefId, text: "Fix the README", needsStart: false },
        "c",
      );
      expect(posts).toEqual([
        {
          channel: "C1",
          thread_ts: "100.000001",
          text: "Fix the README",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Fix the README" } }],
        },
      ]);
    });

    it("splits a long brief to fit Slack's sections, with the button on the last part only", async () => {
      const { poster, posts } = recordingPoster();
      const paragraph = "word ".repeat(400).trim();
      const text = [paragraph, paragraph, paragraph].join("\n\n");
      await createSlackDeliverer(poster).deliver(
        { kind: "brief", target, briefId, text, needsStart: true },
        "c",
      );
      expect(posts.length).toBeGreaterThan(1);
      for (const [index, post] of posts.entries()) {
        const last = index === posts.length - 1;
        expect(post.blocks).toHaveLength(last ? 2 : 1);
        expect(post.blocks?.[0]).toEqual({
          type: "section",
          text: { type: "mrkdwn", text: post.text },
        });
        expect(post.text.length).toBeLessThanOrEqual(3000);
      }
      expect(posts.at(-1)?.blocks?.[1]).toMatchObject({ type: "actions" });
      expect(posts.map((post) => post.text).join("\n\n")).toBe(text);
    });
  });

  it("fails while Slack is not configured", async () => {
    const deliverer = createSlackDeliverer(() => {
      throw new Error("Slack is not configured");
    });
    await expect(deliverer.deliver({ kind: "reply", target, text: "hi" }, "c")).rejects.toThrow(
      "not configured",
    );
  });
});

describe("direct messages (slice 3.4)", () => {
  function directPoster(options: { open?: () => Promise<string>; post?: () => Promise<void> }) {
    const posts: Parameters<SlackPoster["postMessage"]>[0][] = [];
    const opened: string[] = [];
    const poster: SlackPoster = {
      postMessage: async (input) => {
        posts.push(input);
        await (options.post ?? (() => Promise.resolve()))();
      },
      addReaction: () => Promise.resolve(),
      removeReaction: () => Promise.resolve(),
      openDirect: async (userId) => {
        opened.push(userId);
        return (options.open ?? (() => Promise.resolve("D0PERSON")))();
      },
      userTimeZone: () => Promise.resolve(undefined),
    };
    return { poster, posts, opened };
  }

  const direct = (deliverer: ReturnType<typeof createSlackDeliverer>, text: string) => {
    if (deliverer.direct === undefined) throw new Error("no direct");
    return deliverer.direct({ workspaceId: "T1", userId: "U7", text }, "c");
  };

  it("opens the direct message and posts the text there, converted, in no thread", async () => {
    const { poster, posts, opened } = directPoster({});
    await direct(createSlackDeliverer(poster), "**Waiting on you**\n- [PR 12](https://x.test/12)");
    expect(opened).toEqual(["U7"]);
    expect(posts).toEqual([
      { channel: "D0PERSON", text: "*Waiting on you*\n• <https://x.test/12|PR 12>" },
    ]);
  });

  it("splits a long message like a reply", async () => {
    const { poster, posts } = directPoster({});
    const paragraph = "word ".repeat(600).trim();
    const text = [paragraph, paragraph, paragraph].join("\n\n");
    await direct(createSlackDeliverer(poster), text);
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((post) => post.thread_ts === undefined && post.channel === "D0PERSON")).toBe(
      true,
    );
    expect(posts.map((post) => post.text).join("\n\n")).toBe(text);
  });

  it("throws when the direct message cannot be opened or the post fails, so it is retried", async () => {
    const missingScope = Object.assign(new Error("missing_scope"), {
      data: { error: "missing_scope" },
    });
    const notOpened = directPoster({ open: () => Promise.reject(missingScope) });
    await expect(direct(createSlackDeliverer(notOpened.poster), "hi")).rejects.toThrow(
      "missing_scope",
    );
    expect(notOpened.posts).toEqual([]);
    const notPosted = directPoster({ post: () => Promise.reject(new Error("rate_limited")) });
    await expect(direct(createSlackDeliverer(notPosted.poster), "hi")).rejects.toThrow(
      "rate_limited",
    );
  });

  it("refuses an empty message rather than report it sent", async () => {
    const { poster, opened } = directPoster({});
    await expect(direct(createSlackDeliverer(poster), "  ")).rejects.toThrow("empty");
    expect(opened).toEqual([]);
  });

  it("throws while Slack is not configured", async () => {
    const deliverer = createSlackDeliverer(() => {
      throw new Error("Slack is not configured");
    });
    await expect(direct(deliverer, "hi")).rejects.toThrow("not configured");
  });
});

describe("time zones (slice 3.4)", () => {
  function zonePoster(answer: () => Promise<string | undefined>) {
    const asked: string[] = [];
    const poster: SlackPoster = {
      postMessage: () => Promise.resolve(),
      addReaction: () => Promise.resolve(),
      removeReaction: () => Promise.resolve(),
      openDirect: () => Promise.resolve("D1"),
      userTimeZone: (userId) => {
        asked.push(userId);
        return answer();
      },
    };
    return { poster, asked };
  }

  const zoneOf = (deliverer: ReturnType<typeof createSlackDeliverer>, userId = "U7") => {
    if (deliverer.timeZone === undefined) throw new Error("no timeZone");
    return deliverer.timeZone({ workspaceId: "T1", userId });
  };

  it("reads the person's time zone from Slack, and keeps it for an hour", async () => {
    let clock = 0;
    const { poster, asked } = zonePoster(() => Promise.resolve("Europe/London"));
    const deliverer = createSlackDeliverer(poster, { now: () => clock });
    expect(await zoneOf(deliverer)).toBe("Europe/London");
    clock = 59 * 60 * 1000;
    expect(await zoneOf(deliverer)).toBe("Europe/London");
    expect(asked).toEqual(["U7"]);
    clock = 61 * 60 * 1000;
    await zoneOf(deliverer);
    expect(asked).toEqual(["U7", "U7"]);
    await zoneOf(deliverer, "U8");
    expect(asked).toEqual(["U7", "U7", "U8"]);
  });

  it("answers undefined when Slack has none, one that is not a time zone, or no such person", async () => {
    expect(
      await zoneOf(createSlackDeliverer(zonePoster(() => Promise.resolve(undefined)).poster)),
    ).toBe(undefined);
    expect(
      await zoneOf(createSlackDeliverer(zonePoster(() => Promise.resolve("Mars/Olympus")).poster)),
    ).toBe(undefined);
    const notFound = Object.assign(new Error("user_not_found"), {
      data: { error: "user_not_found" },
    });
    expect(
      await zoneOf(createSlackDeliverer(zonePoster(() => Promise.reject(notFound)).poster)),
    ).toBe(undefined);
  });

  it("throws on any other failure, and asks again next time", async () => {
    let fail = true;
    const { poster, asked } = zonePoster(() =>
      fail ? Promise.reject(new Error("ratelimited")) : Promise.resolve("America/New_York"),
    );
    const deliverer = createSlackDeliverer(poster);
    await expect(zoneOf(deliverer)).rejects.toThrow("ratelimited");
    fail = false;
    expect(await zoneOf(deliverer)).toBe("America/New_York");
    expect(asked).toHaveLength(2);
  });
});

describe("withMentions (slice 3.1)", () => {
  it("turns only the listed ids into mentions", () => {
    expect(withMentions("Owner of search: {@U1}. Not {@U2}.", ["U1"])).toBe(
      "Owner of search: <@U1>. Not {@U2}.",
    );
    expect(withMentions("{@U1}", undefined)).toBe("{@U1}");
  });
});
