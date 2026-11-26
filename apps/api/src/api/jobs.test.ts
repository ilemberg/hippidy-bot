import { jobDetailSchema, jobListSchema, type Observation } from "@hippidy/contracts";
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
      { outcome: "silent", summary: "Slack is not configured", cost: 0 },
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
