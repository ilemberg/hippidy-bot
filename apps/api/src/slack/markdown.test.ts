import { describe, expect, it } from "vitest";
import { markdownToSlack, splitForSlack } from "./markdown.ts";

describe("markdownToSlack", () => {
  it.each([
    ["**bold** and __bold__", "*bold* and *bold*"],
    ["*italic* text", "_italic_ text"],
    ["~~gone~~", "~gone~"],
    ["see [the docs](https://example.com/a?b=1)", "see <https://example.com/a?b=1|the docs>"],
    ["## A heading", "*A heading*"],
    ["# **Bold** heading", "*Bold heading*"],
    ["- one\n- two\n  * nested", "• one\n• two\n  • nested"],
    ["1 < 2 && 3 > 2", "1 &lt; 2 &amp;&amp; 3 &gt; 2"],
    ["a `**not bold**` b", "a `**not bold**` b"],
    ["math: 2 * 3 * 4", "math: 2 * 3 * 4"],
    ["[a __b__ link](https://x.io/a__b__c)", "<https://x.io/a__b__c|a __b__ link>"],
    ["**[bold link](https://x.io/*a*)**", "*<https://x.io/*a*|bold link>*"],
  ])("%j becomes %j", (input, expected) => {
    expect(markdownToSlack(input)).toBe(expected);
  });

  it("keeps code blocks as they are, without the language tag", () => {
    const input = "Try:\n\n```ts\nconst a = **b** < c;\n```\n\nDone **now**.";
    expect(markdownToSlack(input)).toBe("Try:\n\n```\nconst a = **b** &lt; c;\n```\n\nDone *now*.");
  });
});

describe("splitForSlack", () => {
  it("leaves a short message whole", () => {
    expect(splitForSlack("short")).toEqual(["short"]);
  });

  it("splits at paragraph breaks, each chunk within the limit", () => {
    const paragraph = "x".repeat(60);
    const text = Array.from({ length: 10 }, () => paragraph).join("\n\n");
    const chunks = splitForSlack(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(204);
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("never cuts inside a link or an escaped character", () => {
    const text = "x".repeat(95) + "<https://example.com/long|link> and &amp; " + "y".repeat(95);
    for (const chunk of splitForSlack(text, 100)) {
      expect((chunk.match(/</g) ?? []).length).toBe((chunk.match(/>/g) ?? []).length);
      expect(chunk).not.toMatch(/&[a-z]*$/);
    }
  });

  it("closes and reopens a code block cut in two", () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const chunks = splitForSlack("```\n" + code + "\n```", 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });
});
