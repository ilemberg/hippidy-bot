import { describe, expect, it } from "vitest";
import { readAgentFile, readEnvironmentFile } from "./agent-files.ts";

// The real files in the repo must always parse, so a bad edit fails CI, not the sync.
describe("agent and environment files", () => {
  it("reads agents/hippidy.md", () => {
    const agent = readAgentFile("agents/hippidy.md");
    expect(agent).toMatchObject({ name: "hippidy-bot", model: "claude-opus-5-5", tools: [] });
    expect(agent.system).toContain("You are hippidy-bot");
    expect(agent.system).not.toContain("---");
  });

  it("reads environments/hippidy.yaml", () => {
    expect(readEnvironmentFile("environments/hippidy.yaml")).toMatchObject({
      name: "hippidy-bot",
      config: { type: "cloud", networking: { type: "limited", allow_package_managers: false } },
    });
  });
});
