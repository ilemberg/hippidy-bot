import { describe, expect, it } from "vitest";
import { tokensMatch } from "./auth.ts";

describe("tokensMatch", () => {
  it("matches identical tokens", () => {
    expect(tokensMatch("x".repeat(40), "x".repeat(40))).toBe(true);
  });

  it("rejects different tokens of the same length", () => {
    expect(tokensMatch("x".repeat(40), "y".repeat(40))).toBe(false);
  });

  it("rejects tokens of different lengths without throwing", () => {
    expect(tokensMatch("x", "x".repeat(40))).toBe(false);
  });
});
