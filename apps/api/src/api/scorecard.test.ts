import { scorecardSchema } from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureApp } from "../compose.ts";
import type { Env } from "../config.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { PERSON_SECRET, PERSON_WORKSPACE, signPersonToken } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

// Slice 4.5, part A (decision 223): `GET /v1/scorecard`, for the service and anyone signed in,
// counting only the caller's workspace. The counts themselves are tested in
// `store/scorecard.test.ts`.

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

const serviceToken = "t".repeat(48);
const env: Env = {
  API_SERVICE_TOKEN: serviceToken,
  WEB_API_SECRET: PERSON_SECRET,
  SLACK_WORKSPACE_ID: PERSON_WORKSPACE,
};

function app() {
  return configureApp(new Hono<ApiEnv>(), {
    env,
    log: memoryLogger().log,
    services: { status: { db, configured: { agent: false, slack: true, github: false } } },
  });
}

async function settledConflict(workspaceId: string): Promise<void> {
  await db.query(
    `insert into conflicts (source, workspace_id, kind, summary, status, outcome, settled_at,
       settled_by_actor_id)
     values ('slack', $1, 'raised', 'Postgres or not', 'settled', 'kept', now(), 'U1')`,
    [workspaceId],
  );
}

describe("GET /v1/scorecard", () => {
  it("gives a signed-in person and the service their workspace's counts, this week and last", async () => {
    await settledConflict(PERSON_WORKSPACE);
    await settledConflict("TOTHER");
    const api = app();
    const person = await api.request("/v1/scorecard", {
      headers: { authorization: `Bearer ${await signPersonToken()}` },
    });
    expect(person.status).toBe(200);
    const scorecard = scorecardSchema.parse(await person.json());
    expect(scorecard.counts.map((c) => c.kind)).toEqual([
      "decisions_made",
      "conflicts_settled",
      "waits_ended",
      "changes_started",
      "pull_requests_reviewed",
      "tickets_merged",
    ]);
    expect(scorecard.counts.find((c) => c.kind === "conflicts_settled")).toEqual({
      kind: "conflicts_settled",
      thisWeek: 1,
      lastWeek: 0,
    });
    // This week starts on a Monday at midnight UTC, and last week seven days before.
    const start = new Date(scorecard.thisWeekStart);
    expect([start.getUTCDay(), start.getUTCHours(), start.getUTCMinutes()]).toEqual([1, 0, 0]);
    expect(start.getTime() - new Date(scorecard.lastWeekStart).getTime()).toBe(7 * 86_400_000);

    const service = await api.request("/v1/scorecard", {
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    expect(service.status).toBe(200);
    expect(scorecardSchema.parse(await service.json()).counts).toEqual(scorecard.counts);
  });

  it("refuses a caller with no token or from another workspace", async () => {
    const api = app();
    expect((await api.request("/v1/scorecard")).status).toBe(401);
    const other = await api.request("/v1/scorecard", {
      headers: { authorization: `Bearer ${await signPersonToken({ team: "TOTHER" })}` },
    });
    expect(other.status).toBe(401);
  });
});
