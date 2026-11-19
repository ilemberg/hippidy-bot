import { describe, expect, it } from "vitest";
import { memoryLogger } from "../testing.ts";
import { REPOSITORY_URL, readAgentConfig } from "./config.ts";

const apiKey = "sk-ant-test";

describe("readAgentConfig", () => {
  it("reads the GitHub token that mounts the repo", () => {
    const { log, lines } = memoryLogger();
    const config = readAgentConfig(
      { ANTHROPIC_API_KEY: apiKey, AGENT_GITHUB_TOKEN: "github_pat_11ABC_def" },
      log,
    );
    expect(config?.repository).toEqual({ url: REPOSITORY_URL, token: "github_pat_11ABC_def" });
    expect(config?.vaultName).toBe("hippidy-bot");
    expect(lines.map((line) => line.msg)).not.toContain("config.agent_github_token_missing");
  });

  it("keeps the agent configured without the token, but with no repo to mount", () => {
    const { log, lines } = memoryLogger();
    const config = readAgentConfig({ ANTHROPIC_API_KEY: apiKey }, log);
    expect(config).toBeDefined();
    expect(config?.repository).toBeUndefined();
    // The product agent mounts the public repo without a token (decisions 147, 167).
    expect(config?.repositoryUrl).toBe(REPOSITORY_URL);
    expect(config?.productAgentName).toBe("hippidy-bot-product");
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "config.agent_github_token_missing", reason: "not set" }),
    );
  });

  it("rejects something that is not a fine-grained token, without logging it", () => {
    const { log, lines } = memoryLogger();
    const config = readAgentConfig(
      { ANTHROPIC_API_KEY: apiKey, AGENT_GITHUB_TOKEN: "ghp_classicsecret" },
      log,
    );
    expect(config?.repository).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain("classicsecret");
  });

  it("caps a session at $5 unless told otherwise (decision 107)", () => {
    const { log } = memoryLogger();
    expect(readAgentConfig({ ANTHROPIC_API_KEY: apiKey }, log)?.sessionBudgetCents).toBe(500);
  });
});
