#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const repo = stringArg(args.repo) ?? process.env.GITHUB_REPOSITORY ?? "";
const eventPath = stringArg(args.event) ?? process.env.GITHUB_EVENT_PATH ?? "";
const changedFilesPath = stringArg(args["changed-files"]);
const expectedHeadSha = stringArg(args["expected-head"]);
const requiredMergeMethod = stringArg(args["required-merge-method"]);
const changedFiles = readChangedFiles(changedFilesPath);
const event = readJsonIfPresent(eventPath);
const pr = event?.pull_request ?? null;
const prNumber = Number(pr?.number ?? event?.number ?? process.env.GITHUB_PR_NUMBER ?? 0);
const body = String(pr?.body ?? "");
const labels = new Set((pr?.labels ?? []).map((label) => String(label.name ?? "")));
const headSha = String(pr?.head?.sha ?? process.env.GITHUB_SHA ?? "");
const errors = [];
const warnings = [];
const supportedMergeMethods = new Set(["merge", "squash", "rebase"]);
const mergeMethodLabelPrefix = "merge-method:";
const isRapidLiteAdoptionPr = /(?:^|\n)\s*CELL-ID\s*:\s*CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001(?:\s|$)/iu.test(body);

const adoptionForbiddenRuntimePatterns = [
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

const requiredArtifacts = [
  ".shirube/repo-spec.yaml",
  ".shirube/execution-context.yaml",
  ".shirube/adoption-intake.yaml",
  ".shirube/existing-state-scan.yaml",
  ".shirube/control-handoffs/CH-001.yaml",
  ".shirube/lifecycle-state.yaml",
  ".shirube/enforcement-policy.yaml",
  ".shirube/control-state-completeness.yaml",
  ".shirube/source-mirrors/control-issue.yaml",
  "docs/shirube/README.md",
  ".github/workflows/shirube-rapid-lite-gates-report.yml",
  ".github/pull_request_template.md",
];

const obsoleteArtifacts = [
  ".shirube/cells/CELL-MCP-SHIRUBE-FULL-ADOPTION-001.yaml",
  ".shirube/evidence/EVIDENCE-MCP-SHIRUBE-FULL-ADOPTION-001.yaml",
  ".shirube/impls/IMPL-MCP-SHIRUBE-FULL-ADOPTION-001.md",
  ".shirube/specs/SPEC-MCP-SHIRUBE-FULL-ADOPTION-001.md",
  ".shirube/rapid-lite/CONTROL-HANDOFF-MCP-805.yaml",
];

requireEqual("target repo", repo, "watchout/agent-comms-mcp");
for (const artifact of requiredArtifacts) requireExisting(artifact);
for (const artifact of obsoleteArtifacts) requireAbsent(artifact);

requireText(".shirube/repo-spec.yaml", [
  "schema_version: shirube-repo-spec/v1",
  'repo: "watchout/agent-comms-mcp"',
  'primary_control_source: "watchout/agent-comms-mcp#802"',
  "mirror_is_truth: false",
  "llm_final_authority: false",
  "owner_confirmation_required: true",
  ".github/workflows/shirube-rapid-lite-gates-report.yml",
]);

requireText(".shirube/execution-context.yaml", [
  "schema_version: shirube-execution-context/v1",
  "mode: rapid_lite_overlay_adoption",
  "repo: watchout/agent-comms-mcp",
  "relation: primary",
  "relation: framework_support",
  "relation: same_repo_control_source",
  "llm_final_authority_forbidden: true",
]);

requireText(".shirube/control-handoffs/CH-001.yaml", [
  "schema_version: shirube-control-handoff/rapid-lite/v1",
  "mode: rapid-lite",
  "profile: hotel-lite",
  "framework_ref: watchout/ai-dev-framework@",
  "CELL-ID: CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001",
  "required_before_merge: true",
  "committed_pending_policy_only: true",
  ".github/workflows/shirube-rapid-lite-gates-report.yml",
]);
requireRegex(".shirube/control-handoffs/CH-001.yaml", /framework_ref: watchout\/ai-dev-framework@[a-f0-9]{40}\b/u, "framework_ref must be pinned to a 40-character ADF SHA.");

requireText(".shirube/enforcement-policy.yaml", [
  "schema_version: shirube-enforcement-policy/v1",
  "mode: report_only",
  "owner_observed: true",
  "enabled: false",
  "unchanged: true",
  "required check activation",
  "runtime/API/DB/package/deploy behavior",
]);

requireText(".shirube/lifecycle-state.yaml", [
  "schema_version: shirube-lifecycle-state/rapid-lite/v1",
  "mode: rapid-lite",
  "profile: hotel-lite",
  "current_phase: HANDOFF_READY",
  "owner_must_not_merge_until_exact_head_decision: true",
]);

requireText(".github/workflows/shirube-rapid-lite-gates-report.yml", [
  "name: Shirube Rapid/Lite Gates Report",
  "uses: \"watchout/ai-dev-framework/.github/workflows/shirube-rapid-lite-reusable.yml@",
  "report_only: true",
  "validation_evidence_ref: \"\"",
  "owner_decision_ref: \"\"",
]);
requireRegex(".github/workflows/shirube-rapid-lite-gates-report.yml", /uses: "watchout\/ai-dev-framework\/\.github\/workflows\/shirube-rapid-lite-reusable\.yml@[a-f0-9]{40}"/u, "Rapid/Lite workflow caller must use a pinned ADF SHA.");
requirePullRequestTypes(".github/workflows/shirube-rapid-lite-gates-report.yml", [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "edited",
  "labeled",
  "unlabeled",
]);
requirePullRequestTypes(".github/workflows/pr-checks.yml", [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "converted_to_draft",
  "labeled",
  "unlabeled",
  "edited",
]);
requireText(".github/workflows/pr-checks.yml", [
  "Auto-merge (explicit owner-selected squash)",
  "contains(github.event.pull_request.labels.*.name, 'merge-method:squash')",
  "Revalidate live authority and squash checked head",
  '--expected-head "$CHECKED_HEAD"',
  '-f sha="$CHECKED_HEAD"',
  "-f merge_method=squash",
  "--required-merge-method squash",
]);

if (pr) {
  if (expectedHeadSha && headSha !== expectedHeadSha) {
    errors.push(`Live PR head ${headSha || "<empty>"} does not match checked head ${expectedHeadSha}.`);
  }
  requirePrBodyText([
    "CELL-ID:",
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
    if (!labels.has("shirube-current-overlay")) {
      errors.push("Non-draft PRs require label shirube-current-overlay.");
    }
    const ownerDecision = await requireOwnerDecisionArtifact();
    requireMergeMethodSelection(ownerDecision);
  }
}

if (isRapidLiteAdoptionPr) {
  for (const file of changedFiles) {
    if (matchesAny(file, adoptionForbiddenRuntimePatterns)) {
      errors.push(`${file} is a runtime/product protected file; this adoption PR must not change it.`);
    }
  }
}

if (pr && changedFiles.some((file) => file.startsWith(".github/workflows/"))) {
  if (!body.includes("CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001")) {
    errors.push("Workflow changes require CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001 in the PR body.");
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

console.log("Shirube current-overlay gate passed.");

async function requireOwnerDecisionArtifact() {
  const comments = await loadIssueComments();
  const decisions = comments
    .map((comment, commentIndex) => parseOwnerDecisionComment(comment, commentIndex))
    .filter(Boolean);
  const exactDecisions = decisions.filter((decision) => {
    return decision.schema_version === "shirube-owner-decision/v1"
      && decision.target_repo === repo
      && String(decision.target_pr) === String(prNumber)
      && decision.exact_head_sha === headSha
      && decision.verdict === "APPROVED_EXACT_HEAD"
      && decision.actor === decision.commentAuthor
      && decision.decision_ref === decision.commentUrl
      && ["OWNER", "MEMBER", "COLLABORATOR"].includes(decision.authorAssociation);
  });

  if (exactDecisions.length === 0) {
    errors.push(
      [
        "Non-draft PRs require a machine-verifiable shirube_owner_decision comment for the current exact head.",
        `Expected schema_version=shirube-owner-decision/v1, target_repo=${repo}, target_pr=${prNumber}, exact_head_sha=${headSha}, verdict=APPROVED_EXACT_HEAD, merge_method=merge|squash|rebase, actor equal to the comment author, and decision_ref equal to the comment URL.`,
      ].join(" "),
    );
    return null;
  }

  const decisionsByRef = new Map(exactDecisions.map((decision) => [decision.decision_ref, decision]));
  const supersededRefs = new Set();
  for (const decision of exactDecisions) {
    if (!decision.supersedes_decision_ref) continue;
    const superseded = decisionsByRef.get(decision.supersedes_decision_ref);
    if (!superseded || superseded.commentIndex >= decision.commentIndex) {
      errors.push(
        `Owner decision ${decision.decision_ref} has invalid supersedes_decision_ref=${decision.supersedes_decision_ref}; it must reference a prior valid decision for the same exact head.`,
      );
      continue;
    }
    supersededRefs.add(superseded.decision_ref);
  }

  const currentDecisions = exactDecisions.filter((decision) => !supersededRefs.has(decision.decision_ref));
  if (currentDecisions.length !== 1) {
    errors.push(
      `Exact head ${headSha} requires exactly one authoritative owner decision after explicit supersession; found ${currentDecisions.length}: ${currentDecisions.map((decision) => decision.decision_ref).join(", ") || "<none>"}.`,
    );
    return null;
  }
  return currentDecisions[0];
}

function requireMergeMethodSelection(ownerDecision) {
  const mergeMethodLabels = [...labels]
    .filter((label) => label.startsWith(mergeMethodLabelPrefix));

  if (mergeMethodLabels.length !== 1) {
    errors.push(
      `Non-draft PRs require exactly one merge-method label; found ${mergeMethodLabels.length}: ${mergeMethodLabels.join(", ") || "<none>"}.`,
    );
    return;
  }

  const selectedMethod = mergeMethodLabels[0].slice(mergeMethodLabelPrefix.length);
  if (!supportedMergeMethods.has(selectedMethod)) {
    errors.push(
      `Unsupported merge method label ${mergeMethodLabels[0]}; supported methods are merge, squash, and rebase.`,
    );
    return;
  }
  if (requiredMergeMethod && selectedMethod !== requiredMergeMethod) {
    errors.push(
      `Execution requires merge_method=${requiredMergeMethod}, but the live label selects ${selectedMethod}.`,
    );
  }

  if (!ownerDecision) return;
  if (!supportedMergeMethods.has(ownerDecision.merge_method)) {
    errors.push(
      `Owner decision must select merge_method=merge, squash, or rebase; got ${ownerDecision.merge_method || "<empty>"}.`,
    );
    return;
  }
  if (ownerDecision.merge_method !== selectedMethod) {
    errors.push(
      `Owner decision merge_method=${ownerDecision.merge_method} does not match label ${mergeMethodLabels[0]}.`,
    );
  }
  if (requiredMergeMethod && ownerDecision.merge_method !== requiredMergeMethod) {
    errors.push(
      `Execution requires merge_method=${requiredMergeMethod}, but the authoritative owner decision selects ${ownerDecision.merge_method}.`,
    );
  }
}

async function loadIssueComments() {
  const commentsPath = stringArg(args.comments) ?? process.env.SHIRUBE_PR_COMMENTS_PATH ?? "";
  if (commentsPath) {
    const parsed = readJsonIfPresent(commentsPath);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.comments)) return parsed.comments;
    errors.push(`Owner decision comments file is not an array or { comments: [] }: ${commentsPath}`);
    return [];
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  if (!token || !repo || !prNumber) {
    errors.push("Non-draft PRs require GITHUB_TOKEN/GH_TOKEN and PR number to verify owner decision comments.");
    return [];
  }

  const comments = [];
  let url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`;
  while (url) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const responseText = await response.text();
      errors.push(`Failed to load PR comments for owner decision verification: HTTP ${response.status} ${responseText}`);
      return [];
    }
    const page = await response.json();
    if (!Array.isArray(page)) {
      errors.push("GitHub issue comments response was not an array.");
      return [];
    }
    comments.push(...page);
    url = nextLink(response.headers.get("link"));
  }
  return comments;
}

function parseOwnerDecisionComment(comment, commentIndex) {
  const text = String(comment?.body ?? "");
  if (!text.includes("shirube_owner_decision:")) return null;

  const fields = {};
  const lines = text.split(/\r?\n/u);
  const blockStart = lines.findIndex((line) => /^\s*shirube_owner_decision:\s*$/u.test(line));
  if (blockStart < 0) return null;
  const blockIndent = lines[blockStart].match(/^\s*/u)?.[0].length ?? 0;

  for (const line of lines.slice(blockStart + 1)) {
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/u)?.[0].length ?? 0;
    if (indent <= blockIndent) break;
    const match = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/u);
    if (!match) continue;
    const [, key, rawValue] = match;
    fields[key] = cleanScalar(rawValue);
  }

  return {
    schema_version: fields.schema_version,
    target_repo: fields.target_repo,
    target_pr: fields.target_pr,
    exact_head_sha: fields.exact_head_sha,
    verdict: fields.verdict,
    merge_method: fields.merge_method,
    supersedes_decision_ref: fields.supersedes_decision_ref,
    actor: fields.actor,
    decision_ref: fields.decision_ref,
    commentAuthor: String(comment?.user?.login ?? ""),
    authorAssociation: String(comment?.author_association ?? ""),
    commentUrl: String(comment?.html_url ?? ""),
    commentIndex,
  };
}

function cleanScalar(value) {
  return String(value ?? "")
    .trim()
    .replace(/^["'`]|["'`]$/gu, "");
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/u);
    if (match) return match[1];
  }
  return null;
}

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
    errors.push(`Required Shirube current-overlay artifact is missing: ${filePath}`);
  }
}

function requireAbsent(filePath) {
  if (existsSync(filePath)) {
    errors.push(`Obsolete Shirube full-adoption artifact must be removed: ${filePath}`);
  }
}

function requireText(filePath, needles) {
  const text = readText(filePath);
  if (!text) {
    errors.push(`Required file is missing or empty: ${filePath}`);
    return;
  }
  for (const needle of needles) {
    if (!text.includes(needle)) errors.push(`${filePath} must include ${needle}.`);
  }
}

function requireRegex(filePath, pattern, message) {
  const text = readText(filePath);
  if (!text) {
    errors.push(`Required file is missing or empty: ${filePath}`);
    return;
  }
  if (!pattern.test(text)) errors.push(`${filePath}: ${message}`);
}

function requirePrBodyText(needles) {
  for (const needle of needles) {
    if (!body.includes(needle)) errors.push(`PR body must include ${needle}.`);
  }
}

function requirePullRequestTypes(filePath, requiredTypes) {
  const text = readText(filePath);
  if (!text) {
    errors.push(`Required workflow is missing or empty: ${filePath}`);
    return;
  }
  for (const activityType of requiredTypes) {
    const pattern = new RegExp(`^\\s*-\\s*${escapeRegExp(activityType)}\\s*$`, "mu");
    if (!pattern.test(text)) {
      errors.push(`${filePath} pull_request.types must include ${activityType}.`);
    }
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => pattern.test(filePath));
}
