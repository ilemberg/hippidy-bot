import type { DeliveryTarget } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import { createSlackDeliverer, type SlackPoster } from "./deliver.ts";

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

  it("swaps 🫡 for ✅ on every answered message", async () => {
    const { poster, calls } = fakePoster();
    await createSlackDeliverer(poster).deliver(
      { kind: "status", target, messageIds: ["1.1", "1.2"], status: "answered" },
      "c",
    );
    expect(calls).toEqual([
      "add 1.1 white_check_mark",
      "remove 1.1 saluting_face",
      "add 1.2 white_check_mark",
      "remove 1.2 saluting_face",
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

  it("fails while Slack is not configured", async () => {
    const deliverer = createSlackDeliverer(() => {
      throw new Error("Slack is not configured");
    });
    await expect(deliverer.deliver({ kind: "reply", target, text: "hi" }, "c")).rejects.toThrow(
      "not configured",
    );
  });
});
