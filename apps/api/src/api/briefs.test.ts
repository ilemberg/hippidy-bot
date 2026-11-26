import {
  myBriefSchema,
  setBriefsResultSchema,
  type Deliverer,
  type DirectMessage,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { configureApp } from "../compose.ts";
import type { Env } from "../config.ts";
import { createArea, editArea } from "../store/areas.ts";
import { buildBrief, linksFor, setBriefs } from "../store/briefs.ts";
import { recordConflict } from "../store/conflicts.ts";
import { findOrCreateConversation } from "../store/conversations.ts";
import { createTestDb } from "../store/testing.ts";
import { recordWait } from "../store/waits.ts";
import { memoryLogger } from "../testing.ts";
import { BRIEFS_PER_RUN, isBriefTime, localTime, runBriefs, type BriefDeps } from "./briefs.ts";
import type { ConversationDeps } from "./conversations.ts";
import { PERSON_SECRET, PERSON_WORKSPACE, RecordingDeliverer, signPersonToken } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

// Slice 3.4 (decision 212): one brief a day by direct message, built from the records, sent
// once on a weekday morning in the person's time zone, and never when there is nothing new.

let db: Awaited<ReturnType<typeof createTestDb>>;
const { log } = memoryLogger();
const ws = PERSON_WORKSPACE;
const place = { source: "slack" as const, workspaceId: ws };
// Monday 2026-11-23, 14:30 UTC: 9:30 in New York, 14:30 in London.
const monday = new Date("2026-11-23T14:30:00.000Z");

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

const person = (actorId: string, name: string | null = null) => ({ ...place, actorId, name });

/** A Slack stand-in that records direct messages and knows time zones. */
class FakeDirect implements Deliverer {
  sent: DirectMessage[] = [];
  failures = 0;
  zones: Record<string, string> = {};
  deliver(): Promise<void> {
    return Promise.resolve();
  }
  direct(message: DirectMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new Error("missing_scope"));
    }
    this.sent.push(message);
    return Promise.resolve();
  }
  timeZone(p: { userId: string }): Promise<string | undefined> {
    return Promise.resolve(this.zones[p.userId]);
  }
}

async function waitOn(waiter: string, on: string, what: string) {
  return recordWait(db, {
    place,
    waiter: { actorId: waiter, name: waiter === "U1" ? "Grace" : null },
    waitingOn: { actorId: on, name: on === "U2" ? "Ada" : null },
    what,
    taskKey: null,
    conversationId: null,
    recordedBy: { actorId: waiter, name: null },
  });
}

describe("when a brief is due", () => {
  it("reads the person's own clock, and only weekday mornings", () => {
    expect(localTime(monday, "America/New_York")).toEqual({
      date: "2026-11-23",
      hour: 9,
      weekday: 1,
    });
    expect(localTime(monday, "Asia/Tokyo")).toEqual({ date: "2026-11-23", hour: 23, weekday: 1 });
    expect(localTime(monday, "Not/AZone")).toEqual(localTime(monday, null));
    expect(isBriefTime({ hour: 9, weekday: 1 })).toBe(true);
    expect(isBriefTime({ hour: 12, weekday: 1 })).toBe(false);
    expect(isBriefTime({ hour: 10, weekday: 6 })).toBe(false);
  });
});

describe("what a brief says", () => {
  it("lists what waits on the person, what is theirs to decide, and their areas' news", async () => {
    await createArea(db, person("UMAKER"), { name: "search", ownerActorId: "U2" });
    await waitOn("U1", "U2", "review the ranking");
    await waitOn("U2", "U3", "the spec");
    await recordConflict(db, {
      place,
      kind: "raised",
      summary: "Vectors or full-text?",
      conversationId: null,
      channelId: null,
      threadId: null,
      area: "search",
      decisionIds: [],
      proposalId: null,
      positions: [],
      deciders: ["U2"],
    });
    const [area] = await db.query(`select id from areas`);
    // Ada passes another area to Linus.
    const other = await createArea(db, person("UMAKER"), { name: "billing", ownerActorId: "U2" });
    await editArea(db, person("U9", "Mallory"), other.area?.id ?? "", {
      version: 1,
      ownerActorId: "U4",
    });
    expect(area).toBeDefined();

    const { brief, fresh } = await buildBrief(
      db,
      place,
      "U2",
      new Date(Date.now() - 60_000),
      new Date(),
      linksFor("https://web.example"),
    );
    expect(fresh).toBe(true);
    expect(brief.sections.map((s) => [s.kind, s.lines.map((l) => l.text)])).toEqual([
      ["waiting_on_you", ["Grace is waiting on you: review the ranking (under an hour)"]],
      ["to_decide", ["Conflict 1: Vectors or full-text?"]],
      // Areas someone else made theirs count too, from when they were created (from the review).
      [
        "your_areas",
        [
          "You now own search (set by UMAKER)",
          "You now own billing (set by UMAKER)",
          "You no longer own billing (changed by Mallory)",
        ],
      ],
      ["you_wait_on", ["U3: the spec (under an hour)"]],
    ]);
    expect(brief.sections[1]?.lines[0]?.href).toBe("https://web.example/conflicts/1");

    const nothing = await buildBrief(db, place, "U7", new Date(), new Date(), linksFor(undefined));
    expect(nothing.brief.sections).toEqual([]);
    expect(nothing.fresh).toBe(false);
  });

  it("shows five lines a section and counts the rest", async () => {
    for (let i = 0; i < 7; i++) await waitOn("U1", "U2", `thing ${String(i)}`);
    const { brief } = await buildBrief(
      db,
      place,
      "U2",
      new Date(0),
      new Date(),
      linksFor(undefined),
    );
    expect(brief.sections[0]).toMatchObject({ kind: "waiting_on_you", more: 2 });
    expect(brief.sections[0]?.lines).toHaveLength(5);
    // Past the twenty read, the count is still right.
    for (let i = 0; i < 30; i++) await waitOn("U1", "U2", `more ${String(i)}`);
    const many = await buildBrief(db, place, "U2", new Date(0), new Date(), linksFor(undefined));
    expect(many.brief.sections[0]?.more).toBe(32);
  });
});

describe("sending briefs from reconcile", () => {
  function deps(slack: FakeDirect, now = monday): BriefDeps {
    return { db, deliverer: slack, place, webBaseUrl: "https://web.example", now: () => now };
  }

  it("sends one brief a day on a weekday morning in the person's time zone, and none when empty", async () => {
    await waitOn("U1", "U2", "review the ranking");
    const slack = new FakeDirect();
    slack.zones = { U1: "America/New_York", U2: "America/New_York" };
    // Only Ada qualifies: Grace has not written to the bot, owns nothing and is waited on by
    // nobody (G13).
    expect(await runBriefs(deps(slack), log)).toEqual({ sent: 1, empty: 0, failed: 0 });
    expect(slack.sent).toEqual([expect.objectContaining({ workspaceId: ws, userId: "U2" })]);
    expect(slack.sent[0]?.text).toContain("**Waiting on you**");
    expect(slack.sent[0]?.text).toContain("](https://web.example/waits)");
    expect(slack.sent[0]?.text).toContain("Reply stop briefs to stop these.");
    // Again the same morning: nothing more.
    expect(await runBriefs(deps(slack), log)).toEqual({ sent: 0, empty: 0, failed: 0 });
    // In London it is 14:30: past noon, so nothing for someone there.
    const london = new FakeDirect();
    await db.query(`delete from briefs`);
    await db.query(`delete from brief_people`);
    london.zones = { U1: "Europe/London", U2: "Europe/London" };
    expect(await runBriefs(deps(london), log)).toEqual({ sent: 0, empty: 0, failed: 0 });
    // And nothing at the weekend.
    const saturday = new Date("2026-11-28T14:30:00.000Z");
    expect(await runBriefs(deps(slack, saturday), log)).toEqual({ sent: 0, empty: 0, failed: 0 });
  });

  it("tries a failed send three times, then gives it up for the day", async () => {
    await waitOn("U1", "U2", "review the ranking");
    const slack = new FakeDirect();
    slack.zones = { U1: "America/New_York", U2: "America/New_York" };
    slack.failures = 5;
    for (let i = 0; i < 4; i++) await runBriefs(deps(slack), log);
    const [row] = await db.query(`select status, attempts from briefs where actor_id = 'U2'`);
    expect(row).toEqual({ status: "abandoned", attempts: 3 });
    expect(slack.sent).toEqual([]);
  });

  it("sends nothing to someone who said stop briefs, until they say start briefs", async () => {
    await waitOn("U1", "U2", "review the ranking");
    const slack = new FakeDirect();
    slack.zones = { U2: "America/New_York" };
    await setBriefs(db, place, "U2", false);
    await runBriefs(deps(slack), log);
    expect(slack.sent).toEqual([]);
    await setBriefs(db, place, "U2", true);
    await runBriefs(deps(slack), log);
    expect(slack.sent.map((m) => m.userId)).toEqual(["U2"]);
  });

  it(`sends at most ${String(BRIEFS_PER_RUN)} a run, and nothing without direct messages`, async () => {
    for (let i = 0; i < BRIEFS_PER_RUN + 2; i++) await waitOn("U1", `UP${String(i)}`, "x");
    const slack = new FakeDirect();
    expect(
      (await runBriefs({ ...deps(slack), now: () => new Date("2026-11-23T09:30:00Z") }, log)).sent,
    ).toBe(BRIEFS_PER_RUN);
    const none = await runBriefs({ ...deps(slack), deliverer: new RecordingDeliverer() }, log);
    expect(none).toEqual({ sent: 0, empty: 0, failed: 0 });
  });
});

describe("what the review of 3.4 found", () => {
  function deps(slack: FakeDirect, now = monday): BriefDeps {
    return { db, deliverer: slack, place, webBaseUrl: "https://web.example", now: () => now };
  }

  it("sends a brief once when two runs overlap", async () => {
    await waitOn("U1", "U2", "review the ranking");
    const slack = new FakeDirect();
    slack.zones = { U2: "America/New_York" };
    await Promise.all([runBriefs(deps(slack), log), runBriefs(deps(slack), log)]);
    expect(slack.sent.map((m) => m.userId)).toEqual(["U2"]);
    const [row] = await db.query(`select status, attempts from briefs where actor_id = 'U2'`);
    expect(row).toEqual({ status: "sent", attempts: 1 });
  });

  it("sends nothing when only standing items are left: nothing is new", async () => {
    await waitOn("U1", "U2", "review the ranking");
    await db.query(`update waits set created_at = now() - interval '10 days'`);
    const slack = new FakeDirect();
    slack.zones = { U2: "America/New_York" };
    expect(await runBriefs(deps(slack), log)).toEqual({ sent: 0, empty: 1, failed: 0 });
    // A new item brings the standing one along.
    await waitOn("U3", "U2", "the spec");
    await db.query(`delete from briefs`);
    await runBriefs(deps(slack), log);
    expect(slack.sent[0]?.text).toContain("review the ranking");
    expect(slack.sent[0]?.text).toContain("the spec");
  });

  it("does not send on a guessed clock when the time zone could not be read", async () => {
    await waitOn("U1", "U2", "review the ranking");
    const slack = new FakeDirect();
    slack.timeZone = () => Promise.reject(new Error("ratelimited"));
    await runBriefs({ ...deps(slack), now: () => new Date("2026-11-23T09:30:00Z") }, log);
    expect(slack.sent).toEqual([]);
    const people = await db.query(`select time_zone_checked_at from brief_people`);
    expect(people).toEqual([]);
  });

  it("keeps what people and the model wrote from making links or formatting", async () => {
    await waitOn("U1", "U2", "[Approve payroll](https://evil.example/login) `x` *y*");
    const slack = new FakeDirect();
    slack.zones = { U2: "America/New_York" };
    await runBriefs({ ...deps(slack), webBaseUrl: undefined }, log);
    const text = slack.sent[0]?.text ?? "";
    expect(text).toContain("Approve payrollhttps://evil.example/login x y");
    expect(text).not.toContain("](https://evil");
  });

  it("puts conflicts with nobody to decide them in the fallback's brief", async () => {
    await recordConflict(db, {
      place,
      kind: "raised",
      summary: "Nobody owns this",
      conversationId: null,
      channelId: null,
      threadId: null,
      area: null,
      decisionIds: [],
      proposalId: null,
      positions: [],
      deciders: [],
    });
    const forOwner = await buildBrief(
      db,
      place,
      "UOWNER",
      new Date(0),
      new Date(),
      linksFor(undefined),
      {
        actorId: "UOWNER",
      },
    );
    expect(forOwner.brief.sections.map((s) => s.kind)).toEqual(["to_decide"]);
    const forOther = await buildBrief(
      db,
      place,
      "U2",
      new Date(0),
      new Date(),
      linksFor(undefined),
      {
        actorId: "UOWNER",
      },
    );
    expect(forOther.brief.sections).toEqual([]);
  });

  it("does not send to someone who said stop after the run began", async () => {
    await waitOn("U1", "U2", "review the ranking");
    const slack = new FakeDirect();
    slack.zones = { U2: "America/New_York" };
    const original = slack.timeZone.bind(slack);
    slack.timeZone = async (p) => {
      const zone = await original(p);
      await setBriefs(db, place, "U2", false);
      return zone;
    };
    await runBriefs(deps(slack), log);
    expect(slack.sent).toEqual([]);
  });
});

const serviceToken = "t".repeat(48);
const env: Env = {
  API_SERVICE_TOKEN: serviceToken,
  WEB_API_SECRET: PERSON_SECRET,
  SLACK_WORKSPACE_ID: PERSON_WORKSPACE,
};

function app() {
  const conversations: ConversationDeps = {
    db,
    runtime: new FakeAgentRuntime(),
    deliverers: { slack: new RecordingDeliverer() },
    sleep: () => Promise.resolve(),
  };
  return configureApp(new Hono<ApiEnv>(), {
    env,
    log: memoryLogger().log,
    services: {
      conversations,
      status: { db, configured: { agent: true, slack: true, github: true } },
    },
  });
}

async function as(actorId: string) {
  return {
    authorization: `Bearer ${await signPersonToken({ subject: actorId, name: "Someone" })}`,
    "content-type": "application/json",
  };
}

describe("the briefs routes", () => {
  it("previews a person's brief, switches it from the web app and from Slack", async () => {
    await waitOn("U1", "U2", "review the ranking");
    const api = app();
    const preview = myBriefSchema.parse(
      await (await api.request("/v1/briefs/me", { headers: await as("U2") })).json(),
    );
    expect(preview).toMatchObject({ on: true, timeZone: null, lastSentAt: null });
    expect(preview.brief.sections.map((s) => s.kind)).toEqual(["waiting_on_you"]);

    const off = await api.request("/v1/briefs/me", {
      method: "POST",
      headers: await as("U2"),
      body: JSON.stringify({ on: false }),
    });
    expect(setBriefsResultSchema.parse(await off.json())).toEqual({ on: false });
    const after = myBriefSchema.parse(
      await (await api.request("/v1/briefs/me", { headers: await as("U2") })).json(),
    );
    expect(after.on).toBe(false);

    // "start briefs" written to the bot: Slack passes it on with the service token.
    const slack = await api.request("/v1/briefs/people", {
      method: "POST",
      headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ source: "slack", workspaceId: ws, actor: { id: "U2" }, on: true }),
    });
    expect(setBriefsResultSchema.parse(await slack.json())).toEqual({ on: true });
    // A person cannot use the service's route to switch someone else's briefs.
    const forged = await api.request("/v1/briefs/people", {
      method: "POST",
      headers: await as("U9"),
      body: JSON.stringify({ source: "slack", workspaceId: ws, actor: { id: "U2" }, on: false }),
    });
    expect(forged.status).toBe(401);
    // And the service has no brief of its own.
    const service = await api.request("/v1/briefs/me", {
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    expect(service.status).toBe(400);
    expect(
      await findOrCreateConversation(db, { ...place, channelId: "C", threadId: "1.1" }),
    ).toBeDefined();
  });
});
