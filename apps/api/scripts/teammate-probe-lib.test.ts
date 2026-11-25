import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  HTTP_TARGETS,
  detailValue,
  judge,
  parseProbeOutput,
  sandboxScript,
  type ProbeLine,
} from "./teammate-probe-lib.ts";

describe("sandboxScript", () => {
  it("is valid bash and names the push branch", () => {
    const script = sandboxScript("teammate-probe/123");
    expect(script).toContain("HEAD:refs/heads/teammate-probe/123");
    // bash -n parses without running anything.
    expect(() => execFileSync("bash", ["-n"], { input: script })).not.toThrow();
  });

  it("tries every public host", () => {
    const script = sandboxScript("b");
    for (const url of HTTP_TARGETS) expect(script).toContain(`'${url}'`);
  });
});

describe("parseProbeOutput", () => {
  it("reads one entry per check, including the http checks whose names have a space", () => {
    const results = parseProbeOutput(
      [
        "some noise",
        "PROBE mount ok path=/workspace/repo head=abc branch=main",
        "PROBE push fail exit=128 remote: Permission denied",
        "PROBE http https://example.com/ fail code=000 curl_exit=56",
        "PROBE done ok ",
      ].join("\n"),
    );
    expect(results.get("mount")).toEqual({
      outcome: "ok",
      detail: "path=/workspace/repo head=abc branch=main",
    });
    expect(results.get("push")?.outcome).toBe("fail");
    expect(results.get("http https://example.com/")).toEqual({
      outcome: "fail",
      detail: "code=000 curl_exit=56",
    });
    expect(results.get("done")).toEqual({ outcome: "ok", detail: "" });
  });
});

describe("detailValue", () => {
  it("finds a key's value", () => {
    expect(detailValue("path=/x head=abc branch=main", "head")).toBe("abc");
    expect(detailValue("path=/x", "head")).toBeUndefined();
  });
});

function results(entries: Record<string, "ok" | "fail">, details: Record<string, string> = {}) {
  return new Map<string, ProbeLine>(
    Object.entries(entries).map(([name, outcome]) => [
      name,
      { outcome, detail: details[name] ?? "" },
    ]),
  );
}

describe("judge", () => {
  const planned = {
    mount: "ok",
    "fetch-main": "ok",
    "fetch-pull-refs": "fail",
    "clone-other-repo": "fail",
    push: "fail",
    npm: "fail",
    done: "ok",
  } as const;

  it("finds nothing wrong when the session is as planned", () => {
    const verdict = judge(results(planned, { mount: "head=abc" }), "abc");
    expect(verdict).toMatchObject({
      cannotPublish: true,
      readsOtherRefs: false,
      reachableHosts: [],
      problems: [],
    });
    expect(verdict.g18).toContain("only briefs written after one");
  });

  it("flags an accepted push, reachable hosts and a mount that is not main", () => {
    const verdict = judge(
      results({ ...planned, push: "ok", "http https://example.com/": "ok" }, { mount: "head=def" }),
      "abc",
    );
    expect(verdict.cannotPublish).toBe(false);
    expect(verdict.reachableHosts).toEqual(["example.com"]);
    expect(verdict.problems).toEqual([
      "The mounted HEAD (def) is not main (abc).",
      "A push from the session was accepted: rule 1 does not hold.",
      "The environment let through: example.com.",
    ]);
  });

  it("says the start rule must count git reads when other refs can be fetched", () => {
    const verdict = judge(results({ ...planned, "fetch-pull-refs": "ok" }));
    expect(verdict.readsOtherRefs).toBe(true);
    expect(verdict.g18).toContain("Count every git fetch");
  });

  it("notes a script that did not finish", () => {
    const { done: _done, ...unfinished } = planned;
    expect(judge(results(unfinished)).problems).toContain("The script did not run to its end.");
  });
});
