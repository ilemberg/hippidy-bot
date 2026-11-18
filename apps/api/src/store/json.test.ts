import { describe, expect, it } from "vitest";
import { storable, toJsonText } from "./json.ts";

describe("toJsonText", () => {
  it("is plain JSON for plain values", () => {
    const value = { a: [1, "two", null, { three: true }], emoji: "😀", quote: 'say "hi"' };
    expect(JSON.parse(toJsonText(value))).toEqual(value);
  });

  it("removes null characters from values and from keys, at any depth", () => {
    const text = toJsonText({ "k\u0000ey": ["a\u0000b", { deep: "\u0000" }] });
    expect(text).not.toContain("\\u0000");
    expect(JSON.parse(text)).toEqual({ key: ["ab", { deep: "" }] });
  });

  it("replaces half a surrogate pair, and keeps a whole one", () => {
    expect(JSON.parse(toJsonText(["\ud83d", "\ude00 tail", "😀"]))).toEqual([
      "\ufffd",
      "\ufffd tail",
      "😀",
    ]);
  });

  it("keeps text that only looks like an escape", () => {
    expect(JSON.parse(toJsonText({ path: String.raw`C:\u0000\n` }))).toEqual({
      path: String.raw`C:\u0000\n`,
    });
  });

  it("is JSON null for what JSON cannot hold at all", () => {
    expect(toJsonText(undefined)).toBe("null");
    expect(toJsonText(() => 1)).toBe("null");
  });
});

describe("storable", () => {
  it("leaves ordinary text alone", () => {
    expect(storable("plain ✅ text\n")).toBe("plain ✅ text\n");
  });
});
