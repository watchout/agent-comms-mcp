#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const repo = stringArg(args.repo) ?? process.env.GITHUB_REPOSITORY ?? "";
const eventPath = stringArg(args.event) ?? process.env.GITHUB_EVENT_PATH ?? "";
const changedFilesPath = stringArg(args["changed-files"]);
const changedFiles = readChangedFiles(changedFilesPath);
const event = readJsonIfPresent(eventPath);
const pr = event?.pull_request ?? null;
const body = String(pr?.body ?? "");
const labels = new Set((pr?.labels ?? []).map((label) => String(label.name ?? "")));
const headSha = String(pr?.head?.sha ?? process.env.GITHUB_SHA ?? "");
const errors = [];
const warnings = [];
const forbiddenRuntimePatterns = [
  /^server\.ts$/u,
  /^core\//u,
  /^cli\//u,
  /^bin\/(?!aun\.ts$)/u,
  /^entrypoints\//u,
  /^adapters\//u,
  /^db\//u,
  /^hooks\//u,
  /^config\/(?!queue-work-residue-policy\.json$)/u,
  /^package\.json$/u,
  /^bun\.lockb$/u,
  /^package-lock\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^\.env/u,
  /^secrets\//u,
  /^deploy\//u,
];

const requiredRepoSpecText = readText(".shirube/repo-spec.yaml");
requireEqual("target repo", repo, "watchout/agent-comms-mcp");
requireText(".shirube/repo-spec.yaml", requiredRepoSpecText, [
  "primary_target_repo: watchout/agent-comms-mcp",
  "framework_feedback_support_only",
  "control_source_only",
  "not_current_target_unless_explicitly_assigned",
  "mode: full_overlay_active_in_repo_files",
  "partial_pilot_allowed_for_behavior_changing_work: false",
]);

requireExisting(".shirube/enforcement-policy.yaml");
requireExisting(".shirube/lifecycle-state.yaml");
requireExisting(".shirube/specs/SPEC-MCP-SHIRUBE-FULL-ADOPTION-001.md");
requireExisting(".shirube/cells/CELL-MCP-SHIRUBE-FULL-ADOPTION-001.yaml");
requireExisting(".github/pull_request_template.md");

if (pr) {
  requirePrBodyText([
    "CELL-ID:",
    "SPEC-ID:",
    "Risk Tier:",
    "Allowed paths",
    "Protected surfaces",
    "Validation",
  ]);
  if (headSha && pr.draft === true && !body.includes(headSha)) {
    warnings.push(`Draft PR body does not yet include current exact head SHA ${headSha}; required before non-draft/merge handling.`);
  }
  if (headSha && pr.draft !== true && !body.includes(headSha)) {
    errors.push(`PR body must include the current exact head SHA ${headSha}.`);
  }
  if (pr.draft !== true) {
    if (!labels.has("owner-exact-head-approved")) {
      errors.push("Non-draft PRs require label owner-exact-head-approved.");
    }
    if (!labels.has("shirube-full-adoption")) {
      errors.push("Non-draft PRs require label shirube-full-adoption.");
    }
  }
}

for (const file of changedFiles) {
  if (matchesAny(file, forbiddenRuntimePatterns)) {
    errors.push(`${file} is a runtime/product protected file; this adoption PR must not change it.`);
  }
}

if (pr && changedFiles.some((file) => file.startsWith(".github/workflows/"))) {
  if (!body.includes("CELL-MCP-SHIRUBE-FULL-ADOPTION-001")) {
    errors.push("Workflow changes require CELL-MCP-SHIRUBE-FULL-ADOPTION-001 in the PR body.");
  }
  if (!body.includes("Risk Tier: R3")) {
    errors.push("Workflow changes require Risk Tier: R3 in the PR body.");
  }
}

if (body.match(/\bmerge[- ]ready\b/i) && !labels.has("owner-exact-head-approved")) {
  errors.push("PR body must not claim merge-ready before owner exact-head approval.");
}

for (const warning of warnings) {
  console.log(`::warning::${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.log(`::error::${error}`);
  }
  process.exit(1);
}

console.log("Shirube full-adoption gate passed.");

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readJsonIfPresent(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

function readChangedFiles(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function requireEqual(name, actual, expected) {
  if (actual !== expected) {
    errors.push(`${name} must be ${expected}; got ${actual || "<empty>"}.`);
  }
}

function requireExisting(filePath) {
  if (!existsSync(filePath)) {
    errors.push(`Required Shirube full-adoption artifact is missing: ${filePath}`);
  }
}

function requireText(filePath, text, needles) {
  if (!text) {
    errors.push(`Required file is missing or empty: ${filePath}`);
    return;
  }
  for (const needle of needles) {
    if (!text.includes(needle)) errors.push(`${filePath} must include ${needle}.`);
  }
}

function requirePrBodyText(needles) {
  for (const needle of needles) {
    if (!body.includes(needle)) errors.push(`PR body must include ${needle}.`);
  }
}

function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => pattern.test(filePath));
}
