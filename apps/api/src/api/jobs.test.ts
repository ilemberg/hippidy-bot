import {
  jobActionResultSchema,
  jobDetailSchema,
  jobListSchema,
  type Observation,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { FakeExtractor } from "../agent/extractor.ts";
import { configureApp } from "../compose.ts";
import type { Env } from "../config.ts";
import { recordObservation, setListening } from "../store/listening.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import type { ConversationDeps } from "./conversations.ts";
import { runJobs, type JobDeps } from "./jobs.ts";
import { PERSON_SECRET, PERSON_WORKSPACE, RecordingDeliverer, signPersonToken } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

// Slice 4.1 (decision 215): capture and briefs run as standing jobs, each wake logged with its
// outcome and cost, a silent one included; a paused job does not wake; a job at its cap pauses
// itself.

let db: Awaited<ReturnType<typeof createTestDb>>;
const { log } = memoryLogger();
const ws = PERSON_WORKSPACE;
const place = { source: "slack" as const, workspaceId: ws };

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

async function wakes(name: string) {
  return db.query(
    `select w.outcome, w.summary, w.cost_micros::float8 as cost from job_wakes w
     join jobs j on j.id = w.job_id where j.name = $1 order by w.started_at`,
    [name],
  );
}

describe("the scheduler", () => {
  it("makes the built-in jobs, wakes each once when due, and logs silent wakes with why", async () => {
    const deps: JobDeps = { db, place, fallback: { actorId: "UOWNER" } };
    expect(await runJobs(deps, log)).toEqual({ woke: 2, said: 0, failed: 0, skipped: 0 });
    expect(await wakes("capture")).toEqual([
      { outcome: "silent", summary: "the agent is not configured", cost: 0 },
    ]);
    expect(await wakes("briefs")).toEqual([
      { outcome: "silent", summary: "Slack direct messages are not set up", cost: 0 },
    ]);
    const [owner] = await db.query(`select owner_actor_id from jobs where name = 'capture'`);
    expect(owner?.owner_actor_id).toBe("UOWNER");
    // Within the minute: not due again.
    expect((await runJobs(deps, log)).woke).toBe(0);
    // Overlapping runs once it is due again: each job wakes once.
    await db.query(`update jobs set last_wake_at = now() - interval '2 minutes'`);
    const both = await Promise.all([runJobs(deps, log), runJobs(deps, log)]);
    expect(both.map((r) => r.woke).sort()).toEqual([0, 2]);
  });

  it("does not wake a paused job", async () => {
    await runJobs({ db, place }, log);
    await db.query(`update jobs set state = 'paused', last_wake_at = null where name = 'capture'`);
    await db.query(`update jobs set last_wake_at = null where name = 'briefs'`);
    expect((await runJobs({ db, place }, log)).woke).toBe(1);
    expect(await wakes("capture")).toHaveLength(1);
  });

  it("pauses a job at its cap, says so once, and wakes it again when the month turns", async () => {
    await runJobs({ db, place }, log);
    await db.query(`update jobs set cap_cents = 1, last_wake_at = null where name = 'capture'`);
    await db.query(
      `update job_wakes set cost_micros = 20000
       where job_id = (select id from jobs where name = 'capture')`,
    );
    await runJobs({ db, place }, log);
    const [capped] = await db.query(`select state from jobs where name = 'capture'`);
    expect(capped?.state).toBe("capped");
    expect((await wakes("capture")).at(-1)).toMatchObject({
      outcome: "skipped",
      summary: "reached its cap of $0.01 this month; paused until next month",
    });
    await db.query(`update jobs set last_wake_at = null where name = 'capture'`);
    await runJobs({ db, place }, log);
    expect(await wakes("capture")).toHaveLength(2);
    // A new month: it wakes again.
    await db.query(
      `update jobs set capped_month = date '2000-01-01', last_wake_at = null where name = 'capture'`,
    );
    await db.query(`delete from job_wakes`);
    await runJobs({ db, place }, log);
    const [active] = await db.query(`select state from jobs where name = 'capture'`);
    expect(active?.state).toBe("active");
  });

  it("logs what capture said and what it cost", async () => {
    const now = new Date();
    const channel = { ...place, channelId: "C1" };
    await setListening(db, { ...channel, listening: true, actor: { id: "U1" } });
    for (const [messageId, actor] of [
      ["100.1", "U1"],
      ["100.2", "U2"],
    ] as const) {
      const observation: Observation = {
        kind: "posted",
        ...channel,
        messageId,
        threadId: "100.1",
        actor: { id: actor, displayName: actor },
        text: "we agreed: full-text search",
        sentAt: new Date(now.getTime() - 40 * 60_000).toISOString(),
      };
      await recordObservation(db, observation);
    }
    const extractor = new FakeExtractor();
    extractor.answer({
      kind: "ok",
      usage: { inputTokens: 2000, outputTokens: 100 },
      decisions: [
        {
          statement: "Search uses full-text.",
          reason: null,
          area: null,
          decidedBy: "U2",
          messageId: "100.2",
          replaces: null,
        },
      ],
    });
    await runJobs({ db, place, capture: { db, extractor, dailyBudgetCents: 100 } }, log);
    expect(await wakes("capture")).toEqual([
      { outcome: "said", summary: "1 proposal from 1 thread", cost: 250 },
    ]);
  });

  it("never fails when a job throws, and logs the failure", async () => {
    const broken = {
      db,
      extractor: new FakeExtractor(),
      dailyBudgetCents: 100,
    };
    // A database that fails capture's own queries: the wake fails, the run goes on.
    await db.query(`alter table observed_threads rename to observed_threads_gone`);
    const result = await runJobs({ db, place, capture: broken }, log);
    await db.query(`alter table observed_threads_gone rename to observed_threads`);
    expect(result.woke).toBe(2);
    const [capture] = await wakes("capture");
    expect(capture?.outcome).toBe("failed");
  });
});

describe("what the review of 4.1 found", () => {
  it("still runs capture, unlogged, when there is no workspace", async () => {
    const channel = { ...place, channelId: "C1" };
    await setListening(db, { ...channel, listening: true, actor: { id: "U1" } });
    for (const [messageId, actor] of [
      ["100.1", "U1"],
      ["100.2", "U2"],
    ] as const) {
      await recordObservation(db, {
        kind: "posted",
        ...channel,
        messageId,
        threadId: "100.1",
        actor: { id: actor, displayName: actor },
        text: "x",
        sentAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      });
    }
    const extractor = new FakeExtractor();
    const result = await runJobs(
      { db, place: undefined, capture: { db, extractor, dailyBudgetCents: 100 } },
      log,
    );
    expect(result.woke).toBe(0);
    expect(extractor.calls).toHaveLength(1);
  });

  it("wakes a job each minute, however long reconcile's earlier steps took", async () => {
    await runJobs({ db, place }, log);
    // Taken late in the last minute, early in this one: still due.
    await db.query(
      `update jobs set last_wake_at = date_trunc('minute', now()) - interval '1 minute' + interval '50 seconds'`,
    );
    expect((await runJobs({ db, place }, log)).woke).toBe(2);
  });

  it("tells a wake that never finished from a silent one", async () => {
    await runJobs({ db, place }, log);
    await db.query(
      `insert into job_wakes (job_id, started_at)
       select id, now() - interval '20 minutes' from jobs where name = 'capture'`,
    );
    await db.query(`update jobs set last_wake_at = null`);
    await runJobs({ db, place }, log);
    const [unfinished] = await db.query(
      `select outcome, error from job_wakes where started_at < now() - interval '15 minutes'`,
    );
    expect(unfinished).toEqual({ outcome: "failed", error: "did not finish" });
  });

  it("logs briefs as said through the scheduler, and a briefs run that fails as failed", async () => {
    const sent: string[] = [];
    const deliverer = {
      deliver: () => Promise.resolve(),
      direct: (m: { userId: string }) => {
        sent.push(m.userId);
        return Promise.resolve();
      },
      timeZone: () => Promise.resolve("UTC"),
    };
    await db.query(
      `insert into waits (source, workspace_id, waiter_actor_id, waiting_on_actor_id, what,
         recorded_by_actor_id)
       values ('slack', $1, 'U1', 'U2', 'a review', 'U1')`,
      [ws],
    );
    const monday = new Date("2026-11-23T09:30:00.000Z");
    const deps: JobDeps = {
      db,
      place,
      now: () => monday,
      briefs: { deliverer, webBaseUrl: undefined, now: () => monday },
    };
    await runJobs(deps, log);
    expect(sent).toEqual(["U2"]);
    expect(await wakes("briefs")).toEqual([{ outcome: "said", summary: "sent 1 brief", cost: 0 }]);
    await db.query(`alter table briefs rename to briefs_gone`);
    await db.query(`update jobs set last_wake_at = null`);
    await runJobs(deps, log);
    await db.query(`alter table briefs_gone rename to briefs`);
    expect((await wakes("briefs")).at(-1)?.outcome).toBe("failed");
  });

  it("never wakes a job a person paused, whatever the month", async () => {
    await runJobs({ db, place }, log);
    await db.query(
      `update jobs set state = 'paused', capped_month = date '2000-01-01', last_wake_at = null
       where name = 'capture'`,
    );
    await runJobs({ db, place }, log);
    const [row] = await db.query(`select state from jobs where name = 'capture'`);
    expect(row?.state).toBe("paused");
  });
});

const serviceToken = "t".repeat(48);
const env: Env = {
  API_SERVICE_TOKEN: serviceToken,
  WEB_API_SECRET: PERSON_SECRET,
  SLACK_WORKSPACE_ID: PERSON_WORKSPACE,
};

describe("the jobs routes", () => {
  it("lists the jobs with their spend, and one with its wakes", async () => {
    await runJobs({ db, place }, log);
    const conversations: ConversationDeps = {
      db,
      runtime: new FakeAgentRuntime(),
      deliverers: { slack: new RecordingDeliverer() },
      sleep: () => Promise.resolve(),
    };
    const app = configureApp(new Hono<ApiEnv>(), {
      env,
      log: memoryLogger().log,
      services: {
        conversations,
        status: { db, configured: { agent: true, slack: true, github: true } },
      },
    });
    const headers = {
      authorization: `Bearer ${await signPersonToken({ subject: "U1", name: "Grace" })}`,
    };
    const list = jobListSchema.parse(await (await app.request("/v1/jobs", { headers })).json());
    expect(
      list.jobs.map((j) => [j.name, j.kind, j.state, j.capCents, j.spentMicrosThisMonth]),
    ).toEqual([
      ["briefs", "briefs", "active", 100, 0],
      ["capture", "capture", "active", 3000, 0],
    ]);
    const detail = jobDetailSchema.parse(
      await (await app.request("/v1/jobs/Capture", { headers })).json(),
    );
    expect(detail.wakes).toEqual([
      expect.objectContaining({ outcome: "silent", summary: "the agent is not configured" }),
    ]);
    expect((await app.request("/v1/jobs/nothing", { headers })).status).toBe(404);
  });
});

describe("changing a job (slice 4.2)", () => {
  async function setup() {
    await runJobs({ db, place }, log);
    const conversations: ConversationDeps = {
      db,
      runtime: new FakeAgentRuntime(),
      deliverers: { slack: new RecordingDeliverer() },
      sleep: () => Promise.resolve(),
    };
    const app = configureApp(new Hono<ApiEnv>(), {
      env,
      log: memoryLogger().log,
      services: {
        conversations,
        status: { db, configured: { agent: true, slack: true, github: true } },
      },
    });
    const as = async (actorId: string) => ({
      authorization: `Bearer ${await signPersonToken({ subject: actorId, name: "Ada" })}`,
      "content-type": "application/json",
    });
    const [row] = await db.query(`select id from jobs where name = 'capture'`);
    const id = String(row?.id);
    const edit = async (body: object, by = "U1") =>
      jobActionResultSchema.parse(
        await (
          await app.request(`/v1/jobs/${id}`, {
            method: "PATCH",
            headers: await as(by),
            body: JSON.stringify(body),
          })
        ).json(),
      );
    return { app, as, edit, id };
  }

  it("pauses, raises the cap and changes the interval, each kept, on the version seen", async () => {
    const { app, as, edit } = await setup();
    expect(await edit({ version: 1, state: "paused", capCents: 4000 })).toMatchObject({
      status: "edited",
      job: { state: "paused", capCents: 4000, version: 2 },
    });
    expect((await edit({ version: 1, everyMinutes: 5 })).status).toBe("changed");
    expect((await edit({ version: 2, state: "paused" })).status).toBe("unchanged");
    expect(await edit({ version: 2, everyMinutes: 5, goal: "  " })).toMatchObject({
      status: "edited",
      job: { everyMinutes: 5, goal: null },
    });
    // Paused: it does not wake.
    await db.query(`update jobs set last_wake_at = null`);
    await runJobs({ db, place }, log);
    expect(await wakes("capture")).toHaveLength(1);
    const detail = jobDetailSchema.parse(
      await (await app.request("/v1/jobs/capture", { headers: await as("U2") })).json(),
    );
    expect(detail.history.map((h) => [h.actor.actorId, h.before.state, h.after.state])).toEqual([
      ["U1", "active", "paused"],
      ["U1", "paused", "paused"],
    ]);
    // The service token never changes a job.
    const service = await app.request(`/v1/jobs/${detail.job.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 3, state: "active" }),
    });
    expect(service.status).toBe(400);
  });

  it("wakes a capped job again only once its cap is above this month's spend", async () => {
    const { edit } = await setup();
    await db.query(
      `update jobs set state = 'capped', capped_month = current_date where name = 'capture'`,
    );
    await db.query(
      `update job_wakes set cost_micros = 50000000
       where job_id = (select id from jobs where name = 'capture')`,
    );
    // $50 spent: resuming at the $30 cap is refused; raising the cap to $60 resumes it.
    expect((await edit({ version: 1, state: "active" })).status).toBe("still_capped");
    expect(await edit({ version: 1, capCents: 6000 })).toMatchObject({
      status: "edited",
      job: { state: "active", capCents: 6000 },
    });
  });
});
