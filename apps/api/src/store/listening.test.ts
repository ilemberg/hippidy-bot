import type { Observation } from "@hippidy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteExpiredObservations,
  listListening,
  recordObservation,
  setListening,
} from "./listening.ts";
import { createTestDb } from "./testing.ts";

// Slice 2.5: listening in a channel, and what it keeps (G8).

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

const channel = { source: "slack" as const, workspaceId: "T1", channelId: "C1" };

function listen(listening: boolean, actor = "U1") {
  return setListening(db, { ...channel, listening, actor: { id: actor, displayName: "Ada" } });
}

function posted(messageId: string, overrides: Partial<Observation> = {}): Observation {
  return {
    kind: "posted",
    ...channel,
    messageId,
    threadId: "100.1",
    actor: { id: "U2", displayName: "Grace" },
    text: `message ${messageId}`,
    sentAt: "2026-11-25T10:00:00.000Z",
    ...overrides,
  } as Observation;
}

async function kept() {
  return db.query(
    `select message_id, thread_id, actor_id, actor_name, text from observed_messages
     order by message_id`,
  );
}

describe("setListening", () => {
  it("switches on and off, records who and when, and changes nothing when asked twice", async () => {
    expect(await listen(true)).toMatchObject({
      changed: true,
      channel: { listening: true, changedBy: { actorId: "U1", name: "Ada" } },
    });
    expect((await listen(true, "U2")).changed).toBe(false);
    const off = await listen(false, "U3");
    expect(off).toMatchObject({ changed: true, channel: { listening: false } });
    expect(off.channel.changedBy.actorId).toBe("U3");
    expect(await listListening(db)).toHaveLength(1);
  });

  it("records nothing for switching off a channel never listened to", async () => {
    expect((await listen(false)).changed).toBe(false);
    expect(await listListening(db)).toEqual([]);
  });
});

describe("recordObservation", () => {
  it("drops a message of a channel not listened to before writing anything", async () => {
    expect(await recordObservation(db, posted("1.1"))).toBe("not_listening");
    await listen(true);
    await listen(false);
    expect(await recordObservation(db, posted("1.2"))).toBe("not_listening");
    expect(await kept()).toEqual([]);
    expect(await db.query(`select id from observed_threads`)).toEqual([]);
  });

  it("keeps a listened message once, as text, and follows its edit and deletion", async () => {
    await listen(true);
    expect(await recordObservation(db, posted("1.1", { text: "a\u0000b" }))).toBe("kept");
    expect(await recordObservation(db, posted("1.1"))).toBe("already_kept");
    expect(await kept()).toEqual([
      { message_id: "1.1", thread_id: "100.1", actor_id: "U2", actor_name: "Grace", text: "ab" },
    ]);
    expect(
      await recordObservation(db, {
        kind: "edited",
        ...channel,
        messageId: "1.1",
        text: "edited",
        editedAt: "2026-11-25T10:05:00.000Z",
      }),
    ).toBe("updated");
    expect((await kept())[0]?.text).toBe("edited");
    expect(await recordObservation(db, { kind: "deleted", ...channel, messageId: "1.1" })).toBe(
      "deleted",
    );
    expect(await recordObservation(db, { kind: "deleted", ...channel, messageId: "1.1" })).toBe(
      "not_found",
    );
    expect(await kept()).toEqual([]);
  });

  it("moves the thread's last message forward and clears its failures", async () => {
    await listen(true);
    await recordObservation(db, posted("1.2", { sentAt: "2026-11-25T10:02:00.000Z" }));
    await db.query(`update observed_threads set capture_failures = 3`);
    // An older message arriving late does not move it back.
    await recordObservation(db, posted("1.1", { sentAt: "2026-11-25T10:01:00.000Z" }));
    expect(
      await db.query(`select last_message_at, capture_failures from observed_threads`),
    ).toEqual([{ last_message_at: new Date("2026-11-25T10:02:00.000Z"), capture_failures: 0 }]);
  });
});

describe("thread bookkeeping (from the review)", () => {
  it("counts a thread's messages, and makes it due again after an edit", async () => {
    await listen(true);
    await recordObservation(db, posted("1.1"));
    await recordObservation(db, posted("1.2"));
    await recordObservation(db, posted("1.2"));
    await recordObservation(db, { kind: "deleted", ...channel, messageId: "1.1" });
    await db.query(`update observed_threads set captured_through = last_message_at`);
    await recordObservation(db, {
      kind: "edited",
      ...channel,
      messageId: "1.2",
      text: "changed",
      editedAt: "2026-11-25T11:00:00.000Z",
    });
    expect(
      await db.query(
        `select message_count, captured_through < last_message_at as due from observed_threads`,
      ),
    ).toEqual([{ message_count: 1, due: true }]);
  });

  it("serializes two first listen commands, so only one posts a note", async () => {
    const results = await Promise.all([listen(true, "U1"), listen(true, "U2")]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
  });
});

describe("deleteExpiredObservations", () => {
  it("deletes messages and threads 30 days after they were sent", async () => {
    await listen(true);
    await recordObservation(db, posted("1.1", { sentAt: "2026-10-01T00:00:00.000Z" }));
    await recordObservation(
      db,
      posted("2.1", { threadId: "200.1", sentAt: "2026-11-20T00:00:00.000Z" }),
    );
    expect(await deleteExpiredObservations(db, new Date("2026-11-25T00:00:00.000Z"))).toEqual({
      messages: 1,
      threads: 1,
    });
    expect((await kept()).map((r) => r.message_id)).toEqual(["2.1"]);
  });
});
