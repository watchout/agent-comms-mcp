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

const SCHEMA = "shirube-additional-review-ref-resolution/v1";
const REVIEW_SCHEMA = "shirube-additional-review/v1";
const SOURCE_SCHEMA = "shirube-comment-backed-additional-review-source/v1";

const FINDINGS = {
  "ADDREV-REF-001": ["unsupported_ref_shape", "Additional review ref must be a local path or supported GitHub comment ref."],
  "ADDREV-REF-002": ["github_fetch_failure", "Unable to fetch GitHub issue comment."],
  "ADDREV-REF-003": ["comment_not_found", "GitHub issue comment was not found."],
  "ADDREV-REF-004": ["comment_repo_mismatch", "Comment repository must match the current target repository."],
  "ADDREV-REF-005": ["comment_pr_mismatch", "Comment issue/PR number must match the current PR."],
  "ADDREV-REF-006": ["review_block_missing", "No fenced structured additional review block was found."],
  "ADDREV-REF-007": ["multiple_conflicting_review_blocks", "Multiple conflicting structured additional review blocks were found."],
  "ADDREV-REF-008": ["review_parse_failure", "Structured additional review block could not be parsed."],
  "ADDREV-REF-009": ["wrong_schema_version", "Additional review schema_version must be shirube-additional-review/v1."],
  "ADDREV-REF-010": ["target_repo_mismatch", "Additional review target_repo must match the current repository."],
  "ADDREV-REF-011": ["target_pr_mismatch", "Additional review target_pr must match the current PR."],
  "ADDREV-REF-012": ["missing_exact_head", "Additional review must include exact_head_sha or pr_head_sha."],
  "ADDREV-REF-013": ["head_mismatch", "Additional review exact head must match the current PR head."],
  "ADDREV-REF-014": ["maker_checker_violation", "Additional review reviewer_actor must differ from implementation_actor when both are present."],
  "ADDREV-REF-015": ["owner_approval_in_review", "Additional review evidence must not include owner final approval."],
  "ADDREV-REF-016": ["local_path_missing", "Local additional review file does not exist."],
  "ADDREV-REF-017": ["missing_review_type", "Additional review must include review_type."],
  "ADDREV-REF-018": ["unsupported_review_verdict", "Additional review verdict must be PASS, PASS_WITH_WARN, APPROVED, or CONDITIONAL_GO."],
};

export async function buildAdditionalReviewRefReport(options = {}) {
  const additionalReviewRef = stringOption(options["additional-review-ref"]);
  const additionalReviewCommentRef = stringOption(options["additional-review-comment-ref"]);
  const actualRepo = stringOption(options["actual-repo"]);
  const actualPr = numberString(options["actual-pr"]);
  const actualHead = stringOption(options["actual-head"]);
  const resultDir = stringOption(options["result-dir"]) ?? ".shirube-rapid-lite";
  const githubTokenEnv = stringOption(options["github-token-env"]) ?? "GITHUB_TOKEN";
  const commentFixture = stringOption(options["comment-fixture"]);

  mkdirSync(resultDir, { recursive: true });

  const selectedRef = additionalReviewCommentRef ?? additionalReviewRef;
  if (!selectedRef) {
    return report({
      verdict: "PASS",
      resultDir,
      warnings: [finding("ADDREV-REF-W001", "no_additional_review_ref", "No additional review ref was provided.")],
    });
  }

  if (!additionalReviewCommentRef && additionalReviewRef && !containsCommentBackedRef(additionalReviewRef)) {
    const paths = splitRefs(additionalReviewRef);
    const missing = paths.filter((entry) => !existsSync(entry));
    if (missing.length > 0) {
      return report({
        verdict: "BLOCKED",
        resultDir,
        blockers: missing.map((entry) => finding("ADDREV-REF-016", undefined, undefined, { path: entry })),
      });
    }
    return report({
      verdict: "PASS",
      resultDir,
      materializedPaths: paths,
      reviews: paths.map(parseLocalReview).filter(Boolean),
    });
  }

  const commentRefs = splitRefs(selectedRef);
  const allReviews = [];
  const sourceEntries = [];
  const warnings = [];
  for (const rawRef of commentRefs) {
    const parsedRef = parseCommentRef(rawRef);
    if (!parsedRef) {
      return report({ verdict: "BLOCKED", resultDir, blockers: [finding("ADDREV-REF-001", undefined, undefined, { source_ref: rawRef })] });
    }

    if (actualRepo && parsedRef.repo && normalizeRepo(parsedRef.repo) !== normalizeRepo(actualRepo)) {
      return report({ verdict: "BLOCKED", resultDir, ref: parsedRef, blockers: [finding("ADDREV-REF-004", undefined, undefined, { expected: actualRepo, observed: parsedRef.repo })] });
    }
    if (actualPr && parsedRef.issueNumber && String(parsedRef.issueNumber) !== actualPr) {
      return report({ verdict: "BLOCKED", resultDir, ref: parsedRef, blockers: [finding("ADDREV-REF-005", undefined, undefined, { expected: actualPr, observed: parsedRef.issueNumber })] });
    }

    const commentResult = await loadComment({ parsedRef, tokenEnv: githubTokenEnv, fixturePath: commentFixture });
    if (commentResult.error) {
      const itemId = commentResult.statusCode === 404 ? "ADDREV-REF-003" : "ADDREV-REF-002";
      const verdict = itemId === "ADDREV-REF-002" ? "FAILURE" : "BLOCKED";
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
      return report({ verdict: "BLOCKED", resultDir, ref: parsedRef, comment, blockers: [finding("ADDREV-REF-005", undefined, undefined, { expected: actualPr, observed: commentIssueNumber ?? null })] });
    }

    const extraction = extractAdditionalReviews(commentBodyText(comment));
    if (extraction.error) {
      return report({ verdict: "BLOCKED", resultDir, ref: parsedRef, comment, blockers: [finding(extraction.itemId, undefined, extraction.message)] });
    }
    warnings.push(...extraction.warnings);

    for (const entry of extraction.entries) {
      const blockers = validateReview({ review: entry.review, actualRepo, actualPr, actualHead });
      if (blockers.length > 0) {
        return report({ verdict: "BLOCKED", resultDir, ref: parsedRef, comment, reviews: [entry.review], blockers });
      }
      allReviews.push({ ...entry, parsedRef, comment });
      sourceEntries.push(sourceEntry({ parsedRef, comment, review: entry.review, actualRepo, actualPr, actualHead }));
    }
  }

  const materializedDir = path.join(resultDir, "additional-reviews");
  mkdirSync(materializedDir, { recursive: true });
  const materializedPaths = allReviews.map((entry, index) => {
    const reviewType = safeName(firstPresent(entry.review.review_type, entry.review.type) ?? `review-${index + 1}`);
    const extension = entry.kind === "json" ? "json" : "yaml";
    const filePath = path.join(materializedDir, `${String(index + 1).padStart(2, "0")}-${reviewType}.${extension}`);
    const body = entry.kind === "json"
      ? `${JSON.stringify(entry.review, null, 2)}\n`
      : ensureTrailingNewline(entry.body);
    writeFileSync(filePath, body);
    return filePath;
  });

  const sourcePath = path.join(resultDir, "additional-review-source.json");
  writeFileSync(sourcePath, `${JSON.stringify(sourceMetadata({
    sourceEntries,
    materializedPaths,
    actualRepo,
    actualPr,
    actualHead,
  }), null, 2)}\n`);

  return report({
    verdict: "PASS",
    resultDir,
    reviews: allReviews.map((entry) => entry.review),
    materializedPaths,
    sourcePath,
    warnings,
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

export function extractAdditionalReviews(body) {
  const blocks = [];
  const pattern = /```(ya?ml|json)\s*\n([\s\S]*?)```/gi;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const kind = match[1].toLowerCase().startsWith("json") ? "json" : "yaml";
    const raw = match[2].trim();
    if (!hasReviewSchema(raw)) continue;
    try {
      blocks.push({ kind, body: raw, review: kind === "json" ? JSON.parse(raw) : parseYaml(raw) });
    } catch (error) {
      return { error: true, itemId: "ADDREV-REF-008", message: errorMessage(error) };
    }
  }

  if (blocks.length === 0) {
    const structuredBlocks = [...body.matchAll(/```(?:ya?ml|json)\s*\n([\s\S]*?)```/gi)].map((entry) => entry[1]);
    if (structuredBlocks.some((block) => /["']?schema_version["']?\s*:/m.test(block))) {
      return { error: true, itemId: "ADDREV-REF-009" };
    }
    return { error: true, itemId: "ADDREV-REF-006" };
  }

  const byType = new Map();
  const entries = [];
  const warnings = [];
  for (const block of blocks) {
    const reviewType = normalizeText(firstPresent(block.review?.review_type, block.review?.type));
    const key = reviewType || `__missing_${entries.length}`;
    const normalized = stableStringify(block.review);
    if (byType.has(key)) {
      const previous = byType.get(key);
      if (previous.normalized !== normalized) return { error: true, itemId: "ADDREV-REF-007" };
      warnings.push(finding("ADDREV-REF-W002", "duplicate_identical_review_blocks", "Duplicate identical additional review blocks were found; first block was used."));
      continue;
    }
    byType.set(key, { normalized });
    entries.push(block);
  }

  return { entries, warnings };
}

function validateReview({ review, actualRepo, actualPr, actualHead }) {
  const blockers = [];
  if (!isObject(review) || review.schema_version !== REVIEW_SCHEMA) {
    blockers.push(finding("ADDREV-REF-009"));
    return blockers;
  }

  const reviewType = firstPresent(review.review_type, review.type);
  const targetRepo = firstPresent(review.target_repo, review.repo, review.target?.repo);
  const targetPr = numberString(firstPresent(review.target_pr, review.pr, review.pull_request, review.target?.pr));
  const reviewHead = firstPresent(review.exact_head_sha, review.pr_head_sha, review.head_sha, review.target_head);
  const reviewerActor = firstPresent(review.reviewer_actor, review.review_actor, review.actor);
  const implementationActor = firstPresent(review.implementation_actor, review.implementer_actor);
  const verdict = String(firstPresent(review.verdict, review.decision, review.status) ?? "").toUpperCase();

  if (isPlaceholder(reviewType)) {
    blockers.push(finding("ADDREV-REF-017"));
  }
  if (actualRepo && normalizeRepo(targetRepo) !== normalizeRepo(actualRepo)) {
    blockers.push(finding("ADDREV-REF-010", undefined, undefined, { expected: actualRepo, observed: targetRepo ?? null }));
  }
  if (actualPr && targetPr !== actualPr) {
    blockers.push(finding("ADDREV-REF-011", undefined, undefined, { expected: actualPr, observed: targetPr ?? null }));
  }
  if (isPlaceholder(reviewHead)) {
    blockers.push(finding("ADDREV-REF-012"));
  } else if (actualHead && String(reviewHead) !== actualHead) {
    blockers.push(finding("ADDREV-REF-013", undefined, undefined, { expected: actualHead, observed: reviewHead }));
  }
  if (!["PASS", "PASS_WITH_WARN", "APPROVED", "CONDITIONAL_GO"].includes(verdict)) {
    blockers.push(finding("ADDREV-REF-018", undefined, undefined, { observed: verdict || null }));
  }
  if (!isPlaceholder(reviewerActor) && !isPlaceholder(implementationActor) && String(reviewerActor) === String(implementationActor)) {
    blockers.push(finding("ADDREV-REF-014", undefined, undefined, { reviewer_actor: reviewerActor, implementation_actor: implementationActor }));
  }
  if (containsOwnerApproval(review)) {
    blockers.push(finding("ADDREV-REF-015"));
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
        "User-Agent": "shirube-additional-review-ref-resolver",
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

function report({ verdict, resultDir, ref = null, comment = null, reviews = [], materializedPaths = [], sourcePath = null, blockers = [], warnings = [] }) {
  const primaryReview = reviews.find(Boolean) ?? null;
  return {
    schema: SCHEMA,
    verdict,
    would_block: verdict === "BLOCKED" || verdict === "FAILURE",
    materialized_path: materializedPaths.length === 1 ? materializedPaths[0] : materializedPaths.join(",") || null,
    materialized_paths: materializedPaths,
    source_metadata_path: sourcePath,
    source_comment_url: comment?.html_url ?? ref?.sourceCommentUrl ?? null,
    comment_id: comment?.id ? String(comment.id) : ref?.commentId ?? null,
    comment_author: comment?.user?.login ?? null,
    review_types: uniqueStrings(reviews.map((review) => firstPresent(review?.review_type, review?.type)).filter(Boolean)),
    reviewer_actor: firstPresent(primaryReview?.reviewer_actor, primaryReview?.review_actor, primaryReview?.actor) ?? null,
    target_repo: firstPresent(primaryReview?.target_repo, primaryReview?.repo, primaryReview?.target?.repo) ?? null,
    target_pr: numberString(firstPresent(primaryReview?.target_pr, primaryReview?.pr, primaryReview?.pull_request, primaryReview?.target?.pr)),
    exact_head_sha: firstPresent(primaryReview?.exact_head_sha, primaryReview?.pr_head_sha, primaryReview?.head_sha, primaryReview?.target_head) ?? null,
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

function sourceEntry({ parsedRef, comment, review, actualRepo, actualPr, actualHead }) {
  return {
    source_comment_url: comment?.html_url ?? parsedRef.sourceCommentUrl,
    comment_id: comment?.id ? String(comment.id) : parsedRef.commentId,
    comment_author: comment?.user?.login ?? null,
    review_type: firstPresent(review.review_type, review.type) ?? null,
    reviewer_actor: firstPresent(review.reviewer_actor, review.review_actor, review.actor) ?? null,
    target_repo: firstPresent(review.target_repo, review.repo, actualRepo),
    target_pr: numberString(firstPresent(review.target_pr, review.pr, actualPr)),
    exact_head_sha: firstPresent(review.exact_head_sha, review.pr_head_sha, actualHead),
  };
}

function sourceMetadata({ sourceEntries, materializedPaths, actualRepo, actualPr, actualHead }) {
  return {
    schema_version: SOURCE_SCHEMA,
    generated_by: "scripts/shirube/resolve-additional-review-ref.mjs",
    resolver_schema: SCHEMA,
    source_type: "github_pr_comment",
    sources: sourceEntries,
    target_repo: actualRepo ?? sourceEntries[0]?.target_repo ?? null,
    target_pr: numberString(actualPr ?? sourceEntries[0]?.target_pr),
    exact_head_sha: actualHead ?? sourceEntries[0]?.exact_head_sha ?? null,
    materialized_paths: materializedPaths,
    trusted_base_workflow: true,
    target_branch_mutated: false,
    owner_approval_synthesized: false,
    fetched_at: new Date().toISOString(),
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

function containsCommentBackedRef(value) {
  return splitRefs(value).some((entry) => Boolean(parseCommentRef(entry)));
}

function splitRefs(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseLocalReview(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    return filePath.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch {
    return null;
  }
}

function hasReviewSchema(value) {
  return /["']?schema_version["']?\s*:\s*["']?shirube-additional-review\/v1["']?/m.test(value);
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

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeName(value) {
  return normalizeText(value) || "additional-review";
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

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
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
  const result = await buildAdditionalReviewRefReport(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (format !== "json" || result.verdict === "FAILURE") process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main();
}
