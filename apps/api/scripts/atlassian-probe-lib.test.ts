import { describe, expect, it } from "vitest";
import {
  WANTED_TOOLS,
  coverage,
  findString,
  parseSites,
  redact,
  spaceIdForKey,
  toolText,
} from "./atlassian-probe-lib.ts";

describe("coverage", () => {
  it("splits each group into served and not served", () => {
    const result = coverage(["atlassianUserInfo", "getConfluenceSpaces", "somethingElse"]);
    expect(result.find((entry) => entry.group === "identity")).toEqual({
      group: "identity",
      present: ["atlassianUserInfo"],
      missing: ["getAccessibleAtlassianResources"],
    });
    const confluence = result.find((entry) => entry.group === "confluence");
    expect(confluence?.present).toEqual(["getConfluenceSpaces"]);
    expect(confluence?.missing).toHaveLength(WANTED_TOOLS.confluence.length - 1);
  });
});

describe("toolText", () => {
  it("joins the text blocks and reads the error flag", () => {
    expect(
      toolText({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "x" },
          { type: "text", text: "b" },
        ],
        isError: true,
      }),
    ).toEqual({ text: "a\n\nb", isError: true });
  });

  it("gives empty text for anything else", () => {
    expect(toolText(undefined)).toEqual({ text: "", isError: false });
  });
});

describe("parseSites", () => {
  it("reads id, url and scopes", () => {
    const text = JSON.stringify([
      { id: "c1", url: "https://a.atlassian.net", scopes: ["read:jira-work", 3], name: "a" },
      { url: "no id" },
    ]);
    expect(parseSites(text)).toEqual([
      { id: "c1", url: "https://a.atlassian.net", scopes: ["read:jira-work"] },
    ]);
  });

  it("gives an empty list for text that is not a JSON array", () => {
    expect(parseSites("Unauthorized")).toEqual([]);
    expect(parseSites("{}")).toEqual([]);
  });
});

describe("spaceIdForKey", () => {
  it("finds the id in Confluence's results shape, numeric or not", () => {
    const text = JSON.stringify({
      results: [
        { id: 1, key: "OTHER" },
        { id: 98306, key: "HB" },
      ],
    });
    expect(spaceIdForKey(text, "HB")).toBe("98306");
    expect(spaceIdForKey(text, "NONE")).toBeUndefined();
  });

  it("accepts a bare array and rejects text that is not JSON", () => {
    expect(spaceIdForKey(JSON.stringify([{ id: "7", key: "HB" }]), "HB")).toBe("7");
    expect(spaceIdForKey("oops", "HB")).toBeUndefined();
  });
});

describe("findString", () => {
  it("finds a key at the top or nested", () => {
    expect(findString({ key: "HB-1" }, ["key"])).toBe("HB-1");
    expect(findString({ issue: { fields: {}, key: "HB-2" } }, ["key"])).toBe("HB-2");
    expect(findString({ page: { id: 42 } }, ["id"])).toBe("42");
    expect(findString("text", ["key"])).toBeUndefined();
  });
});

describe("redact", () => {
  it("removes every copy of the secret", () => {
    expect(redact("a SECRET-123 b SECRET-123", "SECRET-123")).toBe("a [redacted] b [redacted]");
  });

  it("leaves text alone for a secret too short to be real", () => {
    expect(redact("abc", "a")).toBe("abc");
  });
});
