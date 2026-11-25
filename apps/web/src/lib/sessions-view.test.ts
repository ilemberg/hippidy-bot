import { describe, expect, it } from "vitest";
import { ago, costText, formatMoney, threadLink } from "./sessions-view.ts";

describe("the monitoring page's wording", () => {
  it("writes money and cost against the budget", () => {
    expect(formatMoney(42, "USD")).toBe("$0.42");
    expect(formatMoney(1234, "EUR")).toBe("12.34 EUR");
    expect(costText({ spentMinor: 42, budgetMinor: 500, currency: "USD" })).toBe("$0.42 of $5.00");
    expect(costText({ spentMinor: 0, budgetMinor: null, currency: null })).toBe("$0.00");
    expect(costText({ spentMinor: null, budgetMinor: 500, currency: "USD" })).toBe("No cost yet");
  });

  it("links a Slack thread, and nothing else", () => {
    expect(
      threadLink({ source: "slack", workspaceId: "T1", channelId: "C1", threadId: "1700.000200" }),
    ).toBe("https://slack.com/archives/C1/p1700000200");
    expect(
      threadLink({ source: "slack", workspaceId: "T1", channelId: "C/../x", threadId: "1.2" }),
    ).toBe("https://slack.com/archives/C%2F..%2Fx/p12");
    expect(
      threadLink({ source: "ui", workspaceId: "T1", channelId: "C1", threadId: "1.2" }),
    ).toBeUndefined();
  });

  it("says how long ago", () => {
    const now = new Date("2026-11-25T12:00:00.000Z");
    expect(ago("2026-11-25T11:59:30.000Z", now)).toBe("just now");
    expect(ago("2026-11-25T11:55:00.000Z", now)).toBe("5 min ago");
    expect(ago("2026-11-25T09:00:00.000Z", now)).toBe("3 h ago");
    expect(ago("2026-11-24T11:00:00.000Z", now)).toBe("1 day ago");
    expect(ago("2026-11-20T12:00:00.000Z", now)).toBe("5 days ago");
  });
});
