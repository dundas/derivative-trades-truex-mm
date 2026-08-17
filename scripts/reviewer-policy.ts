#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG_PATH = path.join(import.meta.dir, "..", ".ai", "code-reviewers.json");

function fail(message: string): never {
  throw new Error(`Invalid reviewer policy: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function singleLine(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string.`);
  const result = value.trim();
  if (/\r|\n/.test(result)) fail(`${field} must not contain a newline.`);
  return result;
}

/** Returns the exact PR-comment solicitation lines configured in the policy. */
export function reviewerSolicitationLines(value: unknown): string[] {
  if (!isRecord(value)) fail("root must be an object.");
  if (!Number.isInteger(value.version) || (value.version as number) < 1) fail("version must be a positive integer.");
  if (!isRecord(value.solicit_review)) fail("solicit_review must be an object.");
  const reviewers = value.solicit_review.reviewers;
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    fail("solicit_review.reviewers must contain at least one reviewer.");
  }
  return reviewers.map((reviewer, index) => {
    if (!isRecord(reviewer)) fail(`solicit_review.reviewers[${index}] must be an object.`);
    const mention = singleLine(reviewer.mention, `solicit_review.reviewers[${index}].mention`);
    if (!/^@[A-Za-z0-9][A-Za-z0-9_-]*$/.test(mention)) {
      fail(`solicit_review.reviewers[${index}].mention must be exactly one reviewer handle.`);
    }
    const command = singleLine(reviewer.command, `solicit_review.reviewers[${index}].command`);
    return `${mention} ${command}`;
  });
}

export async function loadReviewerSolicitationLines(configPath = DEFAULT_CONFIG_PATH): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read reviewer policy at ${configPath}: ${reason}`);
  }
  try {
    return reviewerSolicitationLines(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid reviewer policy: ${configPath} is not valid JSON.`);
    throw error;
  }
}

export async function main(args: string[]): Promise<number> {
  if (args.length) {
    console.error("Usage: bun scripts/reviewer-policy.ts");
    return 2;
  }
  try {
    for (const line of await loadReviewerSolicitationLines()) console.log(line);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
