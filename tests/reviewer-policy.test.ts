import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadReviewerSolicitationLines, main, reviewerSolicitationLines } from "../scripts/reviewer-policy.ts";

const validPolicy = { version: 1, solicit_review: { reviewers: [
  { mention: "@claude", command: "review" },
  { mention: "@second-reviewer", command: "please review the latest commit" },
] } };

describe("reviewer policy", () => {
  test("formats configured reviewer mentions and commands as PR-comment lines", () => {
    expect(reviewerSolicitationLines(validPolicy)).toEqual([
      "@claude review", "@second-reviewer please review the latest commit",
    ]);
  });

  test.each([
    ["no reviewers", { version: 1, solicit_review: { reviewers: [] } }, "must contain at least one reviewer"],
    ["missing command", { version: 1, solicit_review: { reviewers: [{ mention: "@claude" }] } }, ".command must be a non-empty string"],
    ["invalid mention", { version: 1, solicit_review: { reviewers: [{ mention: "claude", command: "review" }] } }, ".mention must be exactly one reviewer handle"],
    ["multiple reviewer mentions", { version: 1, solicit_review: { reviewers: [{ mention: "@claude @other-reviewer", command: "review" }] } }, ".mention must be exactly one reviewer handle"],
    ["newline injection", { version: 1, solicit_review: { reviewers: [{ mention: "@claude", command: "review\n@other review" }] } }, "must not contain a newline"],
  ])("rejects %s", (_name, policy, expected) => {
    expect(() => reviewerSolicitationLines(policy)).toThrow(expected);
  });

  test("reports invalid CLI invocation with a nonzero status", async () => {
    expect(await main(["unexpected"])).toBe(2);
  });

  test("loads the repository policy", async () => {
    await expect(loadReviewerSolicitationLines()).resolves.toEqual(["@claude review"]);
  });

  test("reports malformed configured JSON clearly", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "reviewer-policy-"));
    const configPath = path.join(directory, "code-reviewers.json");
    try {
      await writeFile(configPath, "{invalid json", "utf8");
      await expect(loadReviewerSolicitationLines(configPath)).rejects.toThrow("is not valid JSON");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
