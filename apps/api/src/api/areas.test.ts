import {
  areaActionResultSchema,
  areaDetailSchema,
  areaListSchema,
  peopleListSchema,
  type Area,
  type InboundMessage,
  type OutboundDelivery,
} from "@hippidy/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../agent/fake.ts";
import { configureApp } from "../compose.ts";
import type { Env } from "../config.ts";
import { createArea, editArea, areaHistory, listPeople } from "../store/areas.ts";
import { getChange } from "../store/changes.ts";
import { getConversation } from "../store/conversations.ts";
import { actOnProposal } from "../store/decisions.ts";
import { createTestDb } from "../store/testing.ts";
import { memoryLogger } from "../testing.ts";
import { areasInFiles, areasInText, namePullRequestAreas, ownerLines, pathsIn } from "./areas.ts";
import { syncChange } from "./changes.ts";
import {
  AREAS_LEAD,
  receiveMessage,
  syncConversation,
  type ConversationDeps,
} from "./conversations.ts";
import { PERSON_SECRET, PERSON_WORKSPACE, RecordingDeliverer, signPersonToken } from "./testing.ts";
import type { ApiEnv } from "./types.ts";

// Slice 3.1 (decisions 205 and 206): areas with owners, and the briefs, pull requests and
// decisions that touch them naming their owners in the thread.

let db: Awaited<ReturnType<typeof createTestDb>>;
let runtime: FakeAgentRuntime;
let slack: RecordingDeliverer;
let deps: ConversationDeps;
let files: string[] | undefined;
let filesAsked: number;
const { log } = memoryLogger();
const ws = PERSON_WORKSPACE;
const prUrl = "https://github.com/ilemberg/hippidy-bot/pull/70";

beforeEach(async () => {
  db = await createTestDb();
  runtime = new FakeAgentRuntime();
  slack = new RecordingDeliverer();
  files = [];
  filesAsked = 0;
  deps = {
    db,
    runtime,
    deliverers: { slack },
    sleep: () => Promise.resolve(),
    fallback: { actorId: "UOWNER" },
    checks: {
      verdict: () => Promise.resolve({ kind: "passed" }),
      changedFiles: () => {
        filesAsked++;
        return Promise.resolve(files);
      },
    },
  };
});

afterEach(async () => {
  await db.close();
});

const actor = (actorId: string, name: string | null = null) => ({
  source: "slack" as const,
  workspaceId: ws,
  actorId,
  name,
});

async function area(
  name: string,
  owner: string | null,
  extra: { paths?: string[]; words?: string[] } = {},
): Promise<Area> {
  const result = await createArea(db, actor("UMAKER", "Maker"), {
    name,
    ownerActorId: owner,
    ...extra,
  });
  if (result.area === undefined) throw new Error(result.status);
  return result.area;
}

function message(n: number, text: string, actorId = "U1", name = "Ada"): InboundMessage {
  return {
    source: "slack",
    sourceEventId: `Ev${String(n)}`,
    conversation: {
      workspaceId: ws,
      channelId: "C1",
      threadId: "100.1",
      messageId: `100.${String(n)}`,
    },
    actor: { id: actorId, displayName: name },
    text,
    sentAt: `2026-11-25T00:00:0${String(n)}.000Z`,
  };
}

async function thread() {
  const rows = await db.query(`select id from conversations`);
  return getConversation(db, String(rows[0]?.id));
}

function replies(): Extract<OutboundDelivery, { kind: "reply" }>[] {
  return slack.delivered.flatMap((d) => (d.kind === "reply" ? [d] : []));
}

const brief = {
  title: "Rank full-text results better",
  what: "Change the ranking in apps/api/src/store/decisions.ts.",
  why: "Asked for.",
  doneWhen: "CI passes.",
};

async function teammateCalls(name: string, input: unknown): Promise<string> {
  const teammate = runtime.onlySessionId();
  runtime.work(teammate);
  runtime.callCustomTools(teammate, [{ name, input }]);
  await syncConversation(deps, await thread(), log);
  runtime.finish(teammate, "Done.");
  await syncConversation(deps, await thread(), log);
  return teammate;
}

describe("the areas store", () => {
  it("creates an area, refuses its name twice, and keeps each change with its history", async () => {
    const search = await area("search", null, { words: ["Full-text", "full-text", " "] });
    expect(search).toMatchObject({ name: "search", owner: null, words: ["full-text"], version: 1 });
    expect((await createArea(db, actor("U2"), { name: "search" })).status).toBe("name_taken");

    // The owner's name comes from the record.
    await receiveMessage(deps, message(1, "hello", "U1", "Ada"), log);
    const edited = await editArea(db, actor("U2", "Grace"), search.id, {
      version: 1,
      ownerActorId: "U1",
    });
    expect(edited).toMatchObject({
      status: "edited",
      area: { owner: { actorId: "U1", name: "Ada" }, version: 2 },
    });
    expect((await editArea(db, actor("U2"), search.id, { version: 1, words: ["x"] })).status).toBe(
      "changed",
    );
    expect(
      (await editArea(db, actor("U2"), search.id, { version: 2, ownerActorId: "U1" })).status,
    ).toBe("unchanged");
    expect((await areaHistory(db, search.id)).map((e) => [e.kind, e.actor.actorId])).toEqual([
      ["created", "UMAKER"],
      ["edited", "U2"],
    ]);
  });

  it("keeps an area's decisions when it is renamed, and the name of an owner who names themselves", async () => {
    const search = await area("search", null);
    await db.query(
      `insert into decisions (statement, status, decided_by_source, decided_by_workspace_id,
         decided_by_name, decided_at, origin, area)
       values ('X.', 'active', 'slack', $1, 'Ada', now(), 'capture', 'Search')`,
      [ws],
    );
    await editArea(db, actor("U5", "Bo"), search.id, {
      version: 1,
      name: "find",
      ownerActorId: "U5",
    });
    expect(await db.query(`select area from decisions where statement = 'X.'`)).toEqual([
      { area: "find" },
    ]);
    const [row] = await db.query(`select owner_name from areas where id = $1`, [search.id]);
    expect(row?.owner_name).toBe("Bo");
  });

  it("lists the people the record knows, with their latest names", async () => {
    await receiveMessage(deps, message(1, "hi", "U1", "Ada"), log);
    await area("billing", "U3");
    expect(await listPeople(db, { source: "slack", workspaceId: ws })).toEqual(
      expect.arrayContaining([
        { actorId: "U1", name: "Ada" },
        { actorId: "U3", name: null },
      ]),
    );
  });
});

describe("matching (no model)", () => {
  const areas = [
    { name: "search", paths: ["apps/api/src/store/decisions.ts"], words: ["full-text", "recall"] },
    { name: "slack", paths: ["apps/api/src/slack/**"], words: [] },
    { name: "web app", paths: ["apps/web"], words: [] },
  ].map((a, i) => ({
    id: `00000000-0000-4000-8000-00000000000${String(i)}`,
    description: null,
    owner: null,
    version: 1,
    createdBy: { actorId: "U", name: null },
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
    ...a,
  })) satisfies Area[];

  it("finds areas by name, word or path, as whole words", () => {
    const names = (text: string) => areasInText(areas, text).map((a) => a.name);
    expect(names("Make Full-Text search faster")).toEqual(["search"]);
    expect(names("recalling things")).toEqual([]);
    expect(names("The Slack adapter")).toEqual(["slack"]);
    expect(names("edit apps/api/src/slack/deliver.ts")).toEqual(["slack"]);
    expect(names("the web app's page")).toEqual(["web app"]);
    expect(pathsIn("see ./apps/web/src/x.ts and a/b")).toEqual(["apps/web/src/x.ts", "a/b"]);
  });

  it("finds areas by changed files, a bare directory counting as everything under it", () => {
    expect(
      areasInFiles(areas, ["apps/web/src/app/page.tsx", "README.md"]).map((a) => a.name),
    ).toEqual(["web app"]);
  });

  it("names the owner, or the fallback for an area with none", () => {
    const [search, slackArea] = areas;
    if (search === undefined || slackArea === undefined) throw new Error("fixture");
    expect(
      ownerLines([{ ...search, owner: { actorId: "U1", name: "Ada" } }, slackArea], {
        actorId: "UOWNER",
      }),
    ).toEqual({
      text: "This touches **search**, owned by {@U1}.\nThis touches **slack**, which has no owner, so {@UOWNER} decides for it.",
      mentions: ["U1", "UOWNER"],
    });
  });
});

describe("routing in the thread", () => {
  it("names a brief's areas and their owners once per change, under the brief", async () => {
    await area("search", "U9", { words: ["full-text"] });
    await area("billing", null, { paths: ["apps/billing/**"] });
    await receiveMessage(deps, message(1, "rank full-text results better"), log);
    await teammateCalls("start_change", { ...brief, areas: ["billing", "unknown"] });
    const lines = replies().filter((r) => r.text.startsWith("This touches"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      text: "This touches **billing**, which has no owner, so {@UOWNER} decides for it.\nThis touches **search**, owned by {@U9}.",
      mentions: ["UOWNER", "U9"],
    });
    // Delivered after the brief.
    const kinds = slack.delivered.map((d) => d.kind);
    expect(kinds.indexOf("brief")).toBeLessThan(
      slack.delivered.findIndex((d) => d.kind === "reply" && d.text.startsWith("This touches")),
    );

    // A pull request touching a path names only an area not named yet.
    await area("slack", "U8", { paths: ["apps/api/src/slack/**"] });
    files = ["apps/api/src/store/decisions.ts", "apps/api/src/slack/deliver.ts"];
    const [row] = await db.query(`select id from changes`);
    const change = await getChange(db, String(row?.id));
    const worker = change.agentSessionId ?? "";
    runtime.work(worker);
    runtime.pullRequest(worker, prUrl);
    runtime.finish(worker, `Done: ${prUrl}`);
    await syncChange(deps, change, log);
    await namePullRequestAreas(deps, change.id, log);
    await namePullRequestAreas(deps, change.id, log);
    expect(filesAsked).toBe(1);
    expect(
      replies()
        .filter((r) => r.text.startsWith("This touches"))
        .at(-1),
    ).toMatchObject({
      text: "This touches **slack**, owned by {@U8}.",
      mentions: ["U8"],
    });
  });

  it("names a decision's area owner, who may then confirm it without writing in the thread", async () => {
    await area("search", "U9");
    await receiveMessage(deps, message(1, "we'll use full-text search"), log);
    await teammateCalls("record_decision", {
      statement: "Search uses Postgres full-text search.",
      area: "Search",
      decidedBy: { actorId: "U1" },
      askedToRecord: false,
    });
    const post = slack.delivered.find((d) => d.kind === "decision");
    expect(post).toMatchObject({ needsConfirm: true, mentions: ["U9"] });
    expect(post?.kind === "decision" ? post.text : "").toContain(
      "This touches **search**, owned by {@U9}.",
    );
    const [row] = await db.query(`select id, area from decisions where origin = 'thread'`);
    expect(row?.area).toBe("search");
    expect(
      (await actOnProposal(db, String(row?.id), actor("U9"), { kind: "confirm" })).status,
    ).toBe("confirmed");
  });

  it("tells the teammate which areas a message may touch, with their owners", async () => {
    await area("search", null, { words: ["full-text"] });
    await receiveMessage(deps, message(1, "how does full-text ranking work?"), log);
    await receiveMessage(deps, message(2, "thanks"), log);
    const sent = runtime.sessions.get(runtime.onlySessionId())?.sent ?? [];
    expect(sent[0]).toContain(`${AREAS_LEAD} search (no owner).`);
    expect(sent[1]).not.toContain(AREAS_LEAD);
  });
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
    services: {
      conversations: deps,
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

describe("the areas routes", () => {
  it("lets a person create, read and edit an area as themselves, and lists people", async () => {
    const created = await app().request("/v1/areas", {
      method: "POST",
      headers: await as("U1"),
      body: JSON.stringify({ name: " Search ", ownerActorId: "U1", paths: ["apps/api/**"] }),
    });
    expect(created.status).toBe(201);
    const { area: made } = areaActionResultSchema.parse(await created.json());
    expect(made).toMatchObject({ name: "search", createdBy: { actorId: "U1", name: "Someone" } });

    const list = areaListSchema.parse(
      await (await app().request("/v1/areas", { headers: await as("U2") })).json(),
    );
    expect(list).toMatchObject({
      areas: [{ name: "search" }],
      fallbackOwner: { actorId: "UOWNER" },
    });

    const patched = await app().request(`/v1/areas/${made?.id ?? ""}`, {
      method: "PATCH",
      headers: await as("U2"),
      body: JSON.stringify({ version: 1, ownerActorId: null }),
    });
    expect(areaActionResultSchema.parse(await patched.json())).toMatchObject({
      status: "edited",
      area: { owner: null, version: 2 },
    });
    const detail = areaDetailSchema.parse(
      await (await app().request("/v1/areas/Search", { headers: await as("U2") })).json(),
    );
    expect(detail.history.map((e) => e.actor.actorId)).toEqual(["U1", "U2"]);
    expect((await app().request("/v1/areas/none", { headers: await as("U2") })).status).toBe(404);
    expect(
      peopleListSchema.parse(
        await (await app().request("/v1/people", { headers: await as("U2") })).json(),
      ).people,
    ).toEqual(expect.arrayContaining([{ actorId: "U1", name: "Someone" }]));
  });

  it("refuses a write with the service token, and a bad body", async () => {
    const service = { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" };
    expect(
      (await app().request("/v1/areas", { method: "POST", headers: service, body: '{"name":"x"}' }))
        .status,
    ).toBe(400);
    expect(
      (
        await app().request("/v1/areas", {
          method: "POST",
          headers: await as("U1"),
          body: JSON.stringify({ name: "a", paths: ["../etc"] }),
        })
      ).status,
    ).toBe(400);
  });
});
