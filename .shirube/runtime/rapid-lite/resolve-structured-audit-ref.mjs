#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import {
  isMain,
  isObject,
  parseArgs,
} from "./lib.mjs";

const SCHEMA = "shirube-structured-audit-ref-resolution/v1";
const AUDIT_SCHEMA = "shirube-structured-audit/v1";
const SOURCE_SCHEMA = "shirube-comment-backed-audit-source/v1";

const FINDINGS = {
  "SAUDIT-REF-001": ["unsupported_ref_shape", "Structured audit ref must be a local path or supported GitHub comment ref."],
  "SAUDIT-REF-002": ["github_fetch_failure", "Unable to fetch GitHub issue comment."],
  "SAUDIT-REF-003": ["comment_not_found", "GitHub issue comment was not found."],
  "SAUDIT-REF-004": ["comment_repo_mismatch", "Comment repository must match the current target repository."],
  "SAUDIT-REF-005": ["comment_pr_mismatch", "Comment issue/PR number must match the current PR."],
  "SAUDIT-REF-006": ["audit_block_missing", "No fenced YAML structured audit block was found."],
  "SAUDIT-REF-007": ["multiple_conflicting_audit_blocks", "Multiple conflicting structured audit blocks were found."],
  "SAUDIT-REF-008": ["audit_yaml_parse_failure", "Structured audit YAML could not be parsed."],
  "SAUDIT-REF-009": ["wrong_schema_version", "Structured audit schema_version must be shirube-structured-audit/v1."],
  "SAUDIT-REF-010": ["target_repo_mismatch", "Structured audit target_repo must match the current repository."],
  "SAUDIT-REF-011": ["target_pr_mismatch", "Structured audit target_pr must match the current PR."],
  "SAUDIT-REF-012": ["missing_exact_head", "Structured audit must include exact_head_sha or pr_head_sha."],
  "SAUDIT-REF-013": ["head_mismatch", "Structured audit exact head must match the current PR head."],
  "SAUDIT-REF-014": ["maker_checker_violation", "Structured audit reviewer_actor must differ from implementation_actor when both are present."],
  "SAUDIT-REF-015": ["owner_approval_in_audit", "Structured audit evidence must not include owner final approval."],
  "SAUDIT-REF-016": ["local_path_missing", "Local structured audit file does not exist."],
};

export async function buildStructuredAuditRefReport(options = {}) {
  const structuredAuditRef = stringOption(options["structured-audit-ref"]);
  const structuredAuditCommentRef = stringOption(options["structured-audit-comment-ref"]);
  const actualRepo = stringOption(options["actual-repo"]);
  const actualPr = numberString(options["actual-pr"]);
  const actualHead = stringOption(options["actual-head"]);
  const resultDir = stringOption(options["result-dir"]) ?? ".shirube-rapid-lite";
  const githubTokenEnv = stringOption(options["github-token-env"]) ?? "GITHUB_TOKEN";
  const commentFixture = stringOption(options["comment-fixture"]);

  mkdirSync(resultDir, { recursive: true });

  const selectedRef = structuredAuditCommentRef ?? structuredAuditRef;
  if (!selectedRef) {
    return report({
      verdict: "PASS",
      resultDir,
      warnings: [finding("SAUDIT-REF-W001", "no_structured_audit_ref", "No structured audit ref was provided.")],
    });
  }

  if (!structuredAuditCommentRef && structuredAuditRef && !isCommentBackedRef(structuredAuditRef)) {
    if (!existsSync(structuredAuditRef)) {
      return report({ verdict: "BLOCKED", resultDir, blockers: [finding("SAUDIT-REF-016", undefined, undefined, { path: structuredAuditRef })] });
    }
    return report({
      verdict: "PASS",
      resultDir,
      materializedPath: structuredAuditRef,
      audit: parseLocalAudit(structuredAuditRef),
    });
  }

  const parsedRef = parseCommentRef(selectedRef);
  if (!parsedRef) {
    return report({ verdict: "BLOCKED", resultDir, blockers: [finding("SAUDIT-REF-001", undefined, undefined, { source_ref: selectedRef })] });
  }

  if (actualRepo && parsedRef.repo && normalizeRepo(parsedRef.repo) !== normalizeRepo(actualRepo)) {
    return report({ verdict: "BLOCKED", resultDir, ref: parsedRef, blockers: [finding("SAUDIT-REF-004", undefined, undefined, { expected: actualRepo, observed: parsedRef.repo })] });
  }
  if (actualPr && parsedRef.issueNumber && String(parsedRef.issueNumber) !== actualPr) {
    return report({ verdict: "BLOCKED", resultDir, ref: parsedRef, blockers: [finding("SAUDIT-REF-005", undefined, undefined, { expected: actualPr, observed: parsedRef.issueNumber })] });
  }

  const commentResult = await loadComment({ parsedRef, tokenEnv: githubTokenEnv, fixturePath: commentFixture });
  if (commentResult.error) {
    const itemId = commentResult.statusCode === 404 ? "SAUDIT-REF-003" : "SAUDIT-REF-002";
    const verdict = itemId === "SAUDIT-REF-002" ? "FAILURE" : "BLOCKED";
    return report({
      verdict,
      resultDir,
      ref: parsedRef,
      blockers: [finding(itemId, undefined, commentResult.message, { status_code: commentResult.statusCode })],
    });
  }

  const comment = commentResult.comment;
  const commentIssueNumber = parsedRef.issueNumber ?? issueNumberFromComment(comment);
  if (actualPr && String(commentIssueNumber ?? "") !== actualPr) {
    return report({ verdict: "BLOCKED", resultDir, ref: parsedRef, comment, blockers: [finding("SAUDIT-REF-005", undefined, undefined, { expected: actualPr, observed: commentIssueNumber ?? null })] });
  }

  const extraction = extractStructuredAudit(commentBodyText(comment));
  if (extraction.error) {
    return report({ verdict: "BLOCKED", resultDir, ref: parsedRef, comment, blockers: [finding(extraction.itemId, undefined, extraction.message)] });
  }

  const audit = extraction.audit;
  const blockers = validateAudit({ audit, actualRepo, actualPr, actualHead });
  if (blockers.length > 0) {
    return report({ verdict: "BLOCKED", resultDir, ref: parsedRef, comment, audit, blockers });
  }

  const materializedPath = path.join(resultDir, "structured-audit.yaml");
  const sourcePath = path.join(resultDir, "structured-audit-source.json");
  writeFileSync(materializedPath, ensureTrailingNewline(extraction.yaml));
  const source = sourceMetadata({ parsedRef, comment, audit, actualRepo, actualPr, actualHead, materializedPath });
  writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);

  return report({
    verdict: "PASS",
    resultDir,
    ref: parsedRef,
    comment,
    audit,
    materializedPath,
    sourcePath,
    warnings: extraction.warnings,
  });
}

export function parseCommentRef(value) {
  if (typeof value !== "string") return null;
  const ref = value.trim();

  let match = ref.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)#issuecomment-(\d+)$/);
  if (match) return commentRef({ repo: match[1], issueNumber: match[2], commentId: match[3] });

  match = ref.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/);
  if (match) return commentRef({ repo: match[1], commentId: match[2] });

  match = ref.match(/^github-comment:\/\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)#issuecomment-(\d+)$/);
  if (match) return commentRef({ repo: match[1], issueNumber: match[2], commentId: match[3] });

  match = ref.match(/^github-comment:\/\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/);
  if (match) return commentRef({ repo: match[1], commentId: match[2] });

  return null;
}

export function extractStructuredAudit(body) {
  const blocks = [];
  const pattern = /```(?:ya?ml)\s*\n([\s\S]*?)```/gi;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const yaml = match[1].trim();
    if (!/schema_version\s*:\s*["']?shirube-structured-audit\/v1["']?/m.test(yaml)) continue;
    try {
      blocks.push({ yaml, audit: parseYaml(yaml) });
    } catch (error) {
      return { error: true, itemId: "SAUDIT-REF-008", message: errorMessage(error) };
    }
  }

  if (blocks.length === 0) {
    const yamlBlocks = [...body.matchAll(/```(?:ya?ml)\s*\n([\s\S]*?)```/gi)].map((entry) => entry[1]);
    if (yamlBlocks.some((block) => /schema_version\s*:/m.test(block))) {
      return { error: true, itemId: "SAUDIT-REF-009" };
    }
    return { error: true, itemId: "SAUDIT-REF-006" };
  }

  const normalized = new Set(blocks.map((block) => stableStringify(block.audit)));
  if (normalized.size > 1) return { error: true, itemId: "SAUDIT-REF-007" };

  const warnings = blocks.length > 1
    ? [finding("SAUDIT-REF-W002", "duplicate_identical_audit_blocks", "Duplicate identical structured audit blocks were found; first block was used.")]
    : [];
  return { yaml: blocks[0].yaml, audit: blocks[0].audit, warnings };
}

function validateAudit({ audit, actualRepo, actualPr, actualHead }) {
  const blockers = [];
  if (!isObject(audit) || audit.schema_version !== AUDIT_SCHEMA) {
    blockers.push(finding("SAUDIT-REF-009"));
    return blockers;
  }

  const targetRepo = firstPresent(audit.target_repo, audit.repo, audit.target?.repo);
  const targetPr = numberString(firstPresent(audit.target_pr, audit.pr, audit.pull_request, audit.target?.pr));
  const auditHead = firstPresent(audit.exact_head_sha, audit.pr_head_sha, audit.head_sha, audit.target_head);
  const reviewerActor = firstPresent(audit.reviewer_actor, audit.auditor_actor);
  const implementationActor = firstPresent(audit.implementation_actor, audit.implementer_actor);

  if (actualRepo && normalizeRepo(targetRepo) !== normalizeRepo(actualRepo)) {
    blockers.push(finding("SAUDIT-REF-010", undefined, undefined, { expected: actualRepo, observed: targetRepo ?? null }));
  }
  if (actualPr && targetPr !== actualPr) {
    blockers.push(finding("SAUDIT-REF-011", undefined, undefined, { expected: actualPr, observed: targetPr ?? null }));
  }
  if (isPlaceholder(auditHead)) {
    blockers.push(finding("SAUDIT-REF-012"));
  } else if (actualHead && String(auditHead) !== actualHead) {
    blockers.push(finding("SAUDIT-REF-013", undefined, undefined, { expected: actualHead, observed: auditHead }));
  }
  if (!isPlaceholder(reviewerActor) && !isPlaceholder(implementationActor) && String(reviewerActor) === String(implementationActor)) {
    blockers.push(finding("SAUDIT-REF-014", undefined, undefined, { reviewer_actor: reviewerActor, implementation_actor: implementationActor }));
  }
  if (containsOwnerApproval(audit)) {
    blockers.push(finding("SAUDIT-REF-015"));
  }
  return blockers;
}

async function loadComment({ parsedRef, tokenEnv, fixturePath }) {
  if (fixturePath) {
    try {
      return { comment: JSON.parse(readFileSync(fixturePath, "utf8")) };
    } catch (error) {
      return { error: true, message: errorMessage(error), statusCode: null };
    }
  }

  const token = process.env[tokenEnv];
  if (!token) return { error: true, message: `${tokenEnv} is not set.`, statusCode: null };
  const [owner, repo] = parsedRef.repo.split("/");
  const apiPath = `/repos/${owner}/${repo}/issues/comments/${parsedRef.commentId}`;
  return fetchJson({ apiPath, token });
}

function fetchJson({ apiPath, token }) {
  return new Promise((resolve) => {
    const request = https.request({
      hostname: "api.github.com",
      path: apiPath,
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "shirube-structured-audit-ref-resolver",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          resolve({ error: true, message: body || response.statusMessage, statusCode: response.statusCode });
          return;
        }
        try {
          resolve({ comment: JSON.parse(body), statusCode: response.statusCode });
        } catch (error) {
          resolve({ error: true, message: errorMessage(error), statusCode: response.statusCode });
        }
      });
    });
    request.on("error", (error) => resolve({ error: true, message: errorMessage(error), statusCode: null }));
    request.end();
  });
}

function report({ verdict, resultDir, ref = null, comment = null, audit = null, materializedPath = null, sourcePath = null, blockers = [], warnings = [] }) {
  return {
    schema: SCHEMA,
    verdict,
    would_block: verdict === "BLOCKED" || verdict === "FAILURE",
    materialized_path: materializedPath,
    source_metadata_path: sourcePath,
    source_comment_url: comment?.html_url ?? ref?.sourceCommentUrl ?? null,
    comment_id: comment?.id ? String(comment.id) : ref?.commentId ?? null,
    comment_author: comment?.user?.login ?? null,
    reviewer_actor: firstPresent(audit?.reviewer_actor, audit?.auditor_actor) ?? null,
    target_repo: firstPresent(audit?.target_repo, audit?.repo, audit?.target?.repo) ?? null,
    target_pr: numberString(firstPresent(audit?.target_pr, audit?.pr, audit?.pull_request, audit?.target?.pr)),
    exact_head_sha: firstPresent(audit?.exact_head_sha, audit?.pr_head_sha, audit?.head_sha, audit?.target_head) ?? null,
    result_dir: resultDir,
    target_branch_mutated: false,
    owner_approval_synthesized: false,
    blockers,
    warnings,
    required_next_actions: [...blockers, ...warnings].map((item) => ({
      item_id: item.item_id,
      action: item.message,
    })),
  };
}

function sourceMetadata({ parsedRef, comment, audit, actualRepo, actualPr, actualHead, materializedPath }) {
  return {
    schema_version: SOURCE_SCHEMA,
    generated_by: "scripts/shirube/resolve-structured-audit-ref.mjs",
    resolver_schema: SCHEMA,
    source_type: "github_pr_comment",
    source_comment_url: comment?.html_url ?? parsedRef.sourceCommentUrl,
    comment_id: comment?.id ? String(comment.id) : parsedRef.commentId,
    comment_author: comment?.user?.login ?? null,
    fetched_at: new Date().toISOString(),
    target_repo: firstPresent(audit.target_repo, audit.repo, actualRepo),
    target_pr: numberString(firstPresent(audit.target_pr, audit.pr, actualPr)),
    exact_head_sha: firstPresent(audit.exact_head_sha, audit.pr_head_sha, actualHead),
    materialized_path: materializedPath,
    trusted_base_workflow: true,
    target_branch_mutated: false,
    owner_approval_synthesized: false,
  };
}

function commentRef({ repo, issueNumber = null, commentId }) {
  return {
    repo,
    issueNumber: numberString(issueNumber),
    commentId: String(commentId),
    sourceCommentUrl: issueNumber
      ? `https://github.com/${repo}/issues/${issueNumber}#issuecomment-${commentId}`
      : `https://github.com/${repo}/issues/comments/${commentId}`,
  };
}

function isCommentBackedRef(value) {
  return Boolean(parseCommentRef(value));
}

function parseLocalAudit(filePath) {
  try {
    return parseYaml(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseYaml(text) {
  const json = execFileSync("ruby", [
    "-ryaml",
    "-rjson",
    "-rdate",
    "-e",
    [
      "body = YAML.safe_load(STDIN.read, permitted_classes: [Date, Time], aliases: true)",
      "puts JSON.generate(body)",
    ].join("; "),
  ], { input: text, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(json);
}

function containsOwnerApproval(value, keyPath = []) {
  if (Array.isArray(value)) return value.some((entry) => containsOwnerApproval(entry, keyPath));
  if (!isObject(value)) {
    const key = keyPath.at(-1) ?? "";
    if (/^decision$/i.test(key) && /APPROVED_EXACT_HEAD|MERGE_AUTHORIZED/i.test(String(value))) return true;
    return false;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (normalized === "owner_decision" || normalized === "owner_final_decision" || normalized === "merge_authorization") return true;
    if (normalized === "approval_granted" && entry === true) return true;
    if (containsOwnerApproval(entry, [...keyPath, key])) return true;
  }
  return false;
}

function issueNumberFromComment(comment) {
  const issueUrl = comment?.issue_url;
  if (typeof issueUrl !== "string") return null;
  const match = issueUrl.match(/\/issues\/(\d+)$/);
  return match?.[1] ?? null;
}

function commentBodyText(comment) {
  const body = String(comment?.body ?? "");
  if (!body.includes("\n") && body.includes("\\n")) return body.replace(/\\n/g, "\n");
  return body;
}

function finding(itemId, codeOverride, messageOverride, extra = {}) {
  const [code, message] = FINDINGS[itemId] ?? [codeOverride, messageOverride];
  return {
    item_id: itemId,
    code: codeOverride ?? code,
    message: messageOverride ?? message,
    ...extra,
  };
}

function firstPresent(...values) {
  return values.find((value) => !isPlaceholder(value));
}

function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return text.length === 0 || /^<.*>$/.test(text) || /^(pending|todo|tbd|null|none)$/i.test(text);
}

function numberString(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = String(value).match(/\d+/);
  return match ? match[0] : null;
}

function normalizeRepo(value) {
  return String(value ?? "").trim().toLowerCase();
}

function stringOption(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const format = stringOption(options.format) ?? "json";
  const result = await buildStructuredAuditRefReport(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (format !== "json" || result.verdict === "FAILURE") process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main();
}
