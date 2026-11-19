import { describe, expect, it } from "vitest";
import { formatDuration, progressDue, progressText } from "./progress.ts";

describe("progressDue (decision 103)", () => {
  it("is quiet for the first 15 minutes", () => {
    expect(progressDue(0)).toBeUndefined();
    expect(progressDue(14.9)).toBeUndefined();
  });

  it("follows 15 minutes, 1, 2, 4 and 8 hours, then every 4 hours", () => {
    const at = [15, 59, 60, 120, 240, 480, 719, 720, 960].map((minutes) => progressDue(minutes));
    expect(at).toEqual([
      { number: 1, atMinutes: 15 },
      { number: 1, atMinutes: 15 },
      { number: 2, atMinutes: 60 },
      { number: 3, atMinutes: 120 },
      { number: 4, atMinutes: 240 },
      { number: 5, atMinutes: 480 },
      { number: 5, atMinutes: 480 },
      { number: 6, atMinutes: 720 },
      { number: 7, atMinutes: 960 },
    ]);
  });
});

describe("progressText (decision 106)", () => {
  it("quotes the agent's latest own words first", () => {
    expect(
      progressText(60, {
        words: "Now running\nthe tests.",
        step: { name: "bash", command: "pnpm test" },
      }),
    ).toBe("Still working on this (1 hour so far). Latest: Now running the tests.");
  });

  it("falls back to the latest step, then to the time alone", () => {
    expect(
      progressText(15, { words: undefined, step: { name: "bash", command: "pnpm `x`" } }),
    ).toBe("Still working on this (15 minutes so far). Latest step: `pnpm 'x'`");
    expect(
      progressText(120, {
        words: undefined,
        step: { name: "pull_request_read", command: undefined },
      }),
    ).toBe("Still working on this (2 hours so far). Latest step: pull_request_read");
    expect(progressText(480, { words: undefined, step: undefined })).toBe(
      "Still working on this (8 hours so far).",
    );
  });

  it("keeps a long quote short", () => {
    const text = progressText(15, { words: "a".repeat(1000), step: undefined });
    expect(text.length).toBeLessThan(400);
    expect(text.endsWith("…")).toBe(true);
  });

  it("says durations plainly", () => {
    expect([15, 60, 120, 720].map(formatDuration)).toEqual([
      "15 minutes",
      "1 hour",
      "2 hours",
      "12 hours",
    ]);
  });
});
