import type { AreaDetail } from "@hippidy/contracts";
import { describe, expect, it } from "vitest";
import {
  areaEditFromForm,
  areaHistoryItems,
  areaHref,
  areaNameFromPath,
  areaNotice,
  areaNoticeText,
  createFromForm,
  handleAreaAction,
  inShort,
  linesOf,
  loadArea,
  loadAreas,
  ownerOptions,
  ownerText,
} from "./areas.ts";
import { SESSION_COOKIE } from "./cookies.ts";
import type { HomeDeps } from "./home.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { area, areaDetail, config } from "./testing.ts";
import { signSession, type Person } from "./tokens.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const now = new Date("2026-11-25T12:00:00.000Z");
const people = [
  { actorId: "U1", name: "Ada" },
  { actorId: "U2", name: "Grace" },
];
const fallbackOwner = { actorId: "U9", name: "Owner" };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fake API: `answer` gets each call; every call is recorded. */
function fakeApi(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    const call = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetch, calls };
}

/** The API's reads: the area list, the people, and `detail` for any one area. */
function reads(call: Call, detail: AreaDetail = areaDetail): Response {
  if (call.url.endsWith("/v1/people")) return Response.json({ people });
  if (call.url.endsWith("/v1/areas")) return Response.json({ areas: [area], fallbackOwner });
  return Response.json(detail);
}

function deps(fetch: Fetch): HomeDeps & { lines: Record<string, unknown>[] } {
  const { log, lines } = memoryLogger();
  return { config, fetch, log, now: () => now, lines };
}

const noCalls: Fetch = () => Promise.reject(new Error("no call expected"));
const signedIn = () => signSession(person, config.sessionSecret, now);
const notFound = () =>
  Response.json({ error: { code: "not_found", message: "No such area" } }, { status: 404 });

describe("an area's address", () => {
  it("encodes the name as one segment, and reads it back however it arrives", () => {
    expect(areaHref("api search")).toBe("/areas/api%20search");
    expect(areaNameFromPath("api%20search")).toBe("api search");
    expect(areaNameFromPath("api search")).toBe("api search");
    expect(areaNameFromPath("Search")).toBe("search");
  });

  it("is nothing when it cannot be a name", () => {
    for (const text of ["", "-search", "a".repeat(61), "%E0%A4%A", "sé", "a%25b"]) {
      expect(areaNameFromPath(text)).toBeUndefined();
    }
  });
});

describe("loadAreas", () => {
  const input = async (done?: string, error?: string) => ({
    sessionCookie: await signedIn(),
    done,
    error,
  });

  it("reads every area and the people known, as the person, with a notice this app sent", async () => {
    const api = fakeApi((call) => reads(call));
    expect(await loadAreas(await input(undefined, "name_taken"), deps(api.fetch))).toEqual({
      kind: "signed_in",
      person,
      list: { kind: "ok", value: { areas: [area], fallbackOwner } },
      people: { kind: "ok", value: people },
      notice: { kind: "error", error: "name_taken" },
      readAt: now.toISOString(),
    });
    expect(api.calls.map((call) => call.url).sort()).toEqual([
      "https://api.example.test/v1/areas",
      "https://api.example.test/v1/people",
    ]);
    expect(await loadAreas(await input("hacked", "<b>"), deps(api.fetch))).toMatchObject({
      notice: undefined,
    });
  });

  it("says when the API did not answer", async () => {
    const down = fakeApi(() => new Response(null, { status: 503 }));
    expect(await loadAreas(await input(), deps(down.fetch))).toMatchObject({
      kind: "signed_in",
      list: { kind: "failed", reason: "status_503" },
      people: { kind: "failed", reason: "status_503" },
    });
  });

  it("asks a signed-out visitor to sign in, and calls nothing", async () => {
    expect(
      await loadAreas(
        { sessionCookie: undefined, done: undefined, error: "signed_out" },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out", notice: { kind: "error", error: "signed_out" } });
    expect(
      await loadAreas(
        { sessionCookie: "forged", done: undefined, error: undefined },
        { ...deps(noCalls), config: undefined },
      ),
    ).toEqual({ kind: "unconfigured" });
  });
});

describe("loadArea", () => {
  const input = async (name: string, done?: string, error?: string) => ({
    sessionCookie: await signedIn(),
    name,
    done,
    error,
  });

  it("reads the area by its name, with the people known and who decides for the unowned", async () => {
    const api = fakeApi((call) => reads(call));
    expect(await loadArea(await input("Search", "edited"), deps(api.fetch))).toEqual({
      kind: "ok",
      person,
      detail: areaDetail,
      people: { kind: "ok", value: people },
      fallbackOwner,
      notice: { kind: "done", done: "edited" },
      readAt: now.toISOString(),
    });
    expect(api.calls.map((call) => call.url).sort()).toEqual([
      "https://api.example.test/v1/areas",
      "https://api.example.test/v1/areas/search",
      "https://api.example.test/v1/people",
    ]);
  });

  it("shows the area when only the list or the people could not be read", async () => {
    const api = fakeApi((call) =>
      call.url.endsWith("/search")
        ? Response.json(areaDetail)
        : new Response(null, { status: 500 }),
    );
    expect(await loadArea(await input("search"), deps(api.fetch))).toMatchObject({
      kind: "ok",
      people: { kind: "failed", reason: "status_500" },
      fallbackOwner: null,
    });
  });

  it("says there is no such area, asking the API only for a name", async () => {
    const api = fakeApi((call) => (call.url.endsWith("/billing") ? notFound() : reads(call)));
    expect(await loadArea(await input("billing"), deps(api.fetch))).toEqual({
      kind: "not_found",
      person,
      name: "billing",
    });
    expect(await loadArea(await input("-x"), deps(noCalls))).toEqual({
      kind: "not_found",
      person,
      name: undefined,
    });
  });

  it("says when the API did not answer, and asks a signed-out visitor to sign in", async () => {
    const down = fakeApi(() => new Response(null, { status: 502 }));
    expect(await loadArea(await input("search"), deps(down.fetch))).toEqual({
      kind: "failed",
      person,
      reason: "status_502",
    });
    expect(
      await loadArea(
        { sessionCookie: undefined, name: "search", done: "created", error: undefined },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out", notice: { kind: "done", done: "created" } });
  });
});

const post = (
  path: string,
  options: { cookie?: string; headers?: Record<string, string>; form?: Record<string, string> },
) =>
  new Request(new URL(path, config.webBaseUrl), {
    method: "POST",
    headers: {
      origin: config.webBaseUrl,
      ...(options.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${options.cookie}` }),
      ...options.headers,
    },
    body: new URLSearchParams(options.form ?? {}),
  });

const location = (res: Response) => res.headers.get("location");
const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");

describe("handleAreaAction: create", () => {
  const create = async (form: Record<string, string>, fetch: Fetch, cookie?: string) =>
    handleAreaAction(
      post("/new-area", { cookie: cookie ?? (await signedIn()), form }),
      "create",
      undefined,
      deps(fetch),
    );

  it("creates as the person: one path or word per line, and never who acts", async () => {
    const api = fakeApi(() => Response.json({ status: "created", area }, { status: 201 }));
    const res = await create(
      {
        name: " Search ",
        description: "  Finding decisions\r\n",
        owner: "U1",
        paths: "apps/api/src/store/decisions.ts\r\n\r\n  apps/web/src/lib/** \n",
        words: "Full-Text\n\n ranking \nfull-text",
        actor: "U999",
        actorId: "U999",
      },
      api.fetch,
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${config.webBaseUrl}/areas/search?done=created`);
    expect(api.calls).toEqual([
      {
        url: "https://api.example.test/v1/areas",
        method: "POST",
        body: {
          name: "search",
          description: "Finding decisions",
          ownerActorId: "U1",
          paths: ["apps/api/src/store/decisions.ts", "apps/web/src/lib/**"],
          words: ["full-text", "ranking"],
        },
      },
    ]);
  });

  it("leaves out an empty description, owner, paths and words", async () => {
    const api = fakeApi(() =>
      Response.json({ status: "created", area: { ...area, name: "billing" } }, { status: 201 }),
    );
    const res = await create(
      { name: "billing", description: " ", owner: "", paths: "\n \n", words: "" },
      api.fetch,
    );
    expect(location(res)).toBe(`${config.webBaseUrl}/areas/billing?done=created`);
    expect(api.calls[0]?.body).toEqual({ name: "billing" });
  });

  it("goes back to the list when the name is taken or the API did not answer", async () => {
    for (const [answer, expected] of [
      [Response.json({ status: "name_taken" }), "error=name_taken"],
      [new Response(null, { status: 500 }), "error=failed"],
      [Response.json({ status: "edited", area }), "error=failed"],
    ] as const) {
      const api = fakeApi(() => answer);
      const res = await create({ name: "search" }, api.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/areas?${expected}`);
    }
  });

  it("calls nothing for a form the API would refuse", async () => {
    for (const form of [
      {},
      { name: "" },
      { name: "-search" },
      { name: "a".repeat(61) },
      { name: "search", paths: "../secrets" },
      { name: "search", paths: "/etc/passwd" },
      { name: "search", words: "x" },
      { name: "search", owner: "not an id" },
      { name: "search", description: "d".repeat(301) },
    ]) {
      const res = await create(form, noCalls);
      expect(location(res)).toBe(`${config.webBaseUrl}/areas?error=invalid`);
    }
  });

  it("refuses a form on another site, or one that says nothing of where it came from", async () => {
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "" },
    ]) {
      const d = deps(noCalls);
      const res = await handleAreaAction(
        post("/new-area", { cookie: await signedIn(), headers, form: { name: "search" } }),
        "create",
        undefined,
        d,
      );
      expect(res.status).toBe(403);
      expect(d.lines).toContainEqual(
        expect.objectContaining({ msg: "area.action_refused", reason: "cross_origin" }),
      );
    }
  });

  it("refuses without a valid session or configuration, calling nothing", async () => {
    for (const cookie of [undefined, "forged"]) {
      const res = await handleAreaAction(
        post("/new-area", { ...(cookie === undefined ? {} : { cookie }), form: { name: "x1" } }),
        "create",
        undefined,
        deps(noCalls),
      );
      expect(location(res)).toBe(`${config.webBaseUrl}/areas?error=signed_out`);
    }
    const res = await handleAreaAction(
      post("/new-area", { cookie: await signedIn(), headers: { "sec-fetch-site": "same-origin" } }),
      "create",
      undefined,
      { ...deps(noCalls), config: undefined },
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${config.webBaseUrl}/areas?error=unavailable`);
  });
});

describe("handleAreaAction: edit", () => {
  /** The area's form as the page fills it, with `changes` on top. */
  const formOf = (changes: Record<string, string>) => ({
    version: String(area.version),
    name: area.name,
    description: area.description ?? "",
    owner: area.owner?.actorId ?? "",
    paths: area.paths.join("\r\n"),
    words: area.words.join("\r\n"),
    ...changes,
  });

  /** The API: the area by name, and `result` for the edit. */
  const api = (result: Response) =>
    fakeApi((call) => (call.method === "GET" ? reads(call) : result));

  const edit = async (form: Record<string, string>, fetch: Fetch, name = "search") =>
    handleAreaAction(
      post(`/areas/${name}/edit`, { cookie: await signedIn(), form }),
      "edit",
      name,
      deps(fetch),
    );

  it("sends only what changed, with the version shown, and goes to the area's page", async () => {
    const fake = api(Response.json({ status: "edited", area: { ...area, owner: null } }));
    const res = await edit(
      formOf({ owner: "", words: "Full-Text\nranking\nrecall\n", actorId: "U999" }),
      fake.fetch,
    );
    expect(location(res)).toBe(`${config.webBaseUrl}/areas/search?done=edited`);
    expect(fake.calls).toEqual([
      { url: "https://api.example.test/v1/areas/search", method: "GET", body: undefined },
      {
        url: `https://api.example.test/v1/areas/${area.id}`,
        method: "PATCH",
        body: { version: 2, ownerActorId: null, words: ["full-text", "ranking", "recall"] },
      },
    ]);
  });

  it("clears an emptied description, and goes to the new name after a rename", async () => {
    const fake = api(Response.json({ status: "edited", area: { ...area, name: "find rank" } }));
    const res = await edit(
      formOf({ name: "Find Rank", description: "", paths: "", owner: "U2" }),
      fake.fetch,
    );
    expect(location(res)).toBe(`${config.webBaseUrl}/areas/find%20rank?done=edited`);
    expect(writes(fake.calls)[0]?.body).toEqual({
      version: 2,
      name: "find rank",
      description: null,
      ownerActorId: "U2",
      paths: [],
    });
  });

  it("calls nothing when nothing changed, or the form is invalid", async () => {
    for (const [form, expected] of [
      [formOf({}), "error=unchanged"],
      [formOf({ name: "", words: "FULL-TEXT\nranking\nRanking" }), "error=unchanged"],
      [formOf({ version: "" }), "error=invalid"],
      [formOf({ version: "0" }), "error=invalid"],
      [formOf({ paths: "a/../b" }), "error=invalid"],
      [formOf({ name: "-x" }), "error=invalid"],
    ] as const) {
      const fake = api(Response.json({ status: "edited", area }));
      const res = await edit(form, fake.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/areas/search?${expected}`);
      expect(writes(fake.calls)).toEqual([]);
    }
  });

  it("goes back with why when the API refuses or does not answer", async () => {
    const cases: [Response, Response | undefined, string][] = [
      [Response.json(areaDetail), Response.json({ status: "changed", area }), "error=changed"],
      [Response.json(areaDetail), Response.json({ status: "name_taken" }), "error=name_taken"],
      [Response.json(areaDetail), Response.json({ status: "not_found" }), "error=not_found"],
      [Response.json(areaDetail), Response.json({ status: "unchanged", area }), "error=unchanged"],
      [Response.json(areaDetail), new Response(null, { status: 500 }), "error=failed"],
      [notFound(), undefined, "error=not_found"],
      [new Response(null, { status: 502 }), undefined, "error=failed"],
    ];
    for (const [lookup, result, expected] of cases) {
      const fake = fakeApi((call) => (call.method === "GET" ? lookup : (result ?? lookup)));
      const res = await edit(formOf({ owner: "" }), fake.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/areas/search?${expected}`);
      if (result === undefined) expect(fake.calls).toHaveLength(1);
    }
  });

  it("goes back to an area whose name holds a space", async () => {
    const res = await handleAreaAction(
      post("/areas/api%20x/edit", { form: {} }),
      "edit",
      "api%20x",
      deps(noCalls),
    );
    expect(location(res)).toBe(`${config.webBaseUrl}/areas/api%20x?error=signed_out`);
  });

  it("answers 404 for a name that cannot be an area's, and refuses another site", async () => {
    const res = await edit(formOf({}), noCalls, "-x");
    expect(res.status).toBe(404);
    const d = deps(noCalls);
    const refused = await handleAreaAction(
      post("/areas/search/edit", {
        cookie: await signedIn(),
        headers: { origin: "https://evil.example" },
        form: formOf({ owner: "" }),
      }),
      "edit",
      "search",
      d,
    );
    expect(refused.status).toBe(403);
    expect(d.lines).toContainEqual(
      expect.objectContaining({ msg: "area.action_refused", reason: "cross_origin" }),
    );
  });
});

describe("the form's fields", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };

  it("reads one item per line, trimmed, each once, without empty lines", () => {
    expect(linesOf(" a \n\nb\n a\n  \n")).toEqual(["a", "b"]);
    expect(linesOf(undefined)).toEqual([]);
  });

  it("leaves out a field the form did not send", () => {
    expect(areaEditFromForm(form({ version: "2", description: "New" }), area)).toEqual({
      kind: "edit",
      edit: { version: 2, description: "New" },
    });
    expect(areaEditFromForm(form({ version: "2" }), area)).toEqual({ kind: "unchanged" });
  });

  it("creates from the fields, or says the form is invalid", () => {
    expect(createFromForm(form({ name: "Search", words: "a" }))).toEqual({ kind: "invalid" });
    expect(createFromForm(form({ name: "Search" }))).toEqual({
      kind: "create",
      area: { name: "search" },
    });
  });
});

describe("how an area is worded", () => {
  it("names the owner, or who decides while it has none", () => {
    expect(ownerText({ actorId: "U1", name: "Ada" }, fallbackOwner)).toBe("Ada");
    expect(ownerText(null, fallbackOwner)).toBe("no owner (decided by Owner)");
    expect(ownerText(null, { actorId: "U9", name: null })).toBe("no owner (decided by U9)");
    expect(ownerText(null, null)).toBe("no owner");
  });

  it("lists in short", () => {
    expect(inShort(["a", "b"])).toBe("a, b");
    expect(inShort(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });

  it("offers no owner, the owner now, you, and the people known, each once", () => {
    expect(
      ownerOptions({ kind: "ok", value: people }, { actorId: "U7", name: null }, person),
    ).toEqual([
      { value: "", label: "No owner" },
      { value: "U7", label: "U7" },
      { value: "U0123456789", label: "Ilya" },
      { value: "U1", label: "Ada" },
      { value: "U2", label: "Grace" },
    ]);
    expect(
      ownerOptions({ kind: "failed", reason: "status_500" }, people[0] ?? null, {
        ...person,
        actorId: "U1",
      }),
    ).toEqual([
      { value: "", label: "No owner" },
      { value: "U1", label: "Ada" },
    ]);
  });

  it("lists its history, oldest first, with owner changes as who became whom", () => {
    const items = areaHistoryItems({
      ...areaDetail,
      history: [
        ...areaDetail.history,
        {
          kind: "edited",
          actor: { actorId: "U1", name: null },
          at: "2026-11-25T11:00:00.000Z",
          before: {
            name: "search",
            description: "Finding decisions and messages",
            owner: { actorId: "U1", name: "Ada" },
            paths: ["apps/api/src/store/decisions.ts"],
            words: ["full-text", "ranking"],
          },
          after: {
            name: "find",
            description: null,
            owner: { actorId: "U2", name: "Grace" },
            paths: [],
            words: ["full-text", "ranking"],
          },
        },
      ],
    });
    expect(items).toEqual([
      { key: "0:created", text: "Created by Grace", at: "2026-11-25T09:00:00.000Z", changes: [] },
      {
        key: "1:edited",
        text: "Edited by Grace",
        at: "2026-11-25T10:00:00.000Z",
        changes: [{ field: "Owner", before: "no owner", after: "Ada" }],
      },
      {
        key: "2:edited",
        text: "Edited by U1",
        at: "2026-11-25T11:00:00.000Z",
        changes: [
          { field: "Name", before: "search", after: "find" },
          { field: "Description", before: "Finding decisions and messages", after: "(none)" },
          { field: "Owner", before: "Ada", after: "Grace" },
          { field: "Paths", before: "apps/api/src/store/decisions.ts", after: "(none)" },
        ],
      },
    ]);
  });

  it("reads only the notices this app sends, and words each", () => {
    expect(areaNotice("created", undefined)).toEqual({ kind: "done", done: "created" });
    expect(areaNotice(undefined, "changed")).toEqual({ kind: "error", error: "changed" });
    expect(areaNotice("nope", "nope")).toBeUndefined();
    expect(areaNoticeText({ kind: "error", error: "changed" })).toMatch(/^Someone changed/);
    expect(areaNoticeText({ kind: "error", error: "name_taken" })).toBe(
      "Not saved: another area already has that name.",
    );
  });
});
