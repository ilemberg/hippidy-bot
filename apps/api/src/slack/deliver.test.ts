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
      calls.push(`post ${input.channel} ${input.thread_ts} ${input.text}`);
      return Promise.resolve();
    },
    addReaction: (input) => fail(`add ${input.timestamp} ${input.name}`),
    removeReaction: (input) => fail(`remove ${input.timestamp} ${input.name}`),
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

describe("withMentions (slice 3.1)", () => {
  it("turns only the listed ids into mentions", () => {
    expect(withMentions("Owner of search: {@U1}. Not {@U2}.", ["U1"])).toBe(
      "Owner of search: <@U1>. Not {@U2}.",
    );
    expect(withMentions("{@U1}", undefined)).toBe("{@U1}");
  });
});
