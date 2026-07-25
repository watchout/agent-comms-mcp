#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import {
  isMain,
  isObject,
  parseArgs,
} from "./lib.mjs";
import {
  CANONICAL_CONTROL_HANDOFF_SCHEMA,
  canonicalControlHandoffMissingFields,
} from "./normalize-control-handoff.mjs";

const SCHEMA = "shirube-control-handoff-ref-resolution/v1";
const SOURCE_SCHEMA = "shirube-comment-backed-control-handoff-source/v1";
const MARKER = /<!--\s*shirube-v3:control-handoff(?::[^\s>]+)?\s*-->/g;

const FINDINGS = {
  "CHANDOFF-REF-001": ["unsupported_ref_shape", "control_handoff_comment_ref must be a supported exact GitHub issue-comment ref."],
  "CHANDOFF-REF-002": ["github_fetch_failure", "Unable to fetch the GitHub issue comment."],
  "CHANDOFF-REF-003": ["comment_not_found", "The GitHub issue comment was not found."],
  "CHANDOFF-REF-004": ["source_identity_mismatch", "The fetched comment identity does not match the requested GitHub comment."],
  "CHANDOFF-REF-005": ["source_marker_missing", "The comment does not contain the shirube-v3:control-handoff source marker."],
  "CHANDOFF-REF-006": ["handoff_block_missing", "No fenced canonical control_handoff YAML block was found."],
  "CHANDOFF-REF-007": ["multiple_conflicting_handoff_blocks", "Multiple conflicting canonical control_handoff blocks were found."],
  "CHANDOFF-REF-008": ["handoff_yaml_parse_failure", "The canonical control_handoff YAML could not be parsed."],
  "CHANDOFF-REF-009": ["wrong_schema_version", `control_handoff schema_version must be ${CANONICAL_CONTROL_HANDOFF_SCHEMA}.`],
  "CHANDOFF-REF-010": ["missing_canonical_fields", "The canonical control_handoff is missing required v3 fields."],
  "CHANDOFF-REF-011": ["target_repo_mismatch", "The canonical control_handoff repository does not match the runtime target repository."],
};

export async function buildControlHandoffRefReport(options = {}) {
  const sourceRef = stringOption(options["control-handoff-comment-ref"] ?? options["control-handoff-ref"]);
  const actualRepo = stringOption(options["actual-repo"]);
  const actualHead = stringOption(options["actual-head"]);
  const resultDir = stringOption(options["result-dir"]) ?? ".shirube-rapid-lite";
  const tokenEnv = stringOption(options["github-token-env"]) ?? "GITHUB_TOKEN";
  const fixturePath = stringOption(options["comment-fixture"]);
  mkdirSync(resultDir, { recursive: true });

  const parsedRef = parseControlHandoffCommentRef(sourceRef);
  if (!parsedRef) {
    return report({
      verdict: "BLOCKED",
      resultDir,
      blockers: [finding("CHANDOFF-REF-001", { source_ref: sourceRef })],
    });
  }

  const loaded = await loadComment({ parsedRef, tokenEnv, fixturePath });
  if (loaded.error) {
    const itemId = loaded.statusCode === 404 ? "CHANDOFF-REF-003" : "CHANDOFF-REF-002";
    return report({
      verdict: itemId === "CHANDOFF-REF-002" ? "FAILURE" : "BLOCKED",
      resultDir,
      ref: parsedRef,
      blockers: [finding(itemId, { status_code: loaded.statusCode, detail: loaded.message })],
    });
  }

  const comment = loaded.comment;
  const identity = commentIdentityMismatch(parsedRef, comment);
  if (identity) {
    return report({
      verdict: "BLOCKED",
      resultDir,
      ref: parsedRef,
      comment,
      blockers: [finding("CHANDOFF-REF-004", identity)],
    });
  }

  const extraction = extractCanonicalControlHandoff(commentBodyText(comment));
  if (extraction.error) {
    return report({
      verdict: "BLOCKED",
      resultDir,
      ref: parsedRef,
      comment,
      blockers: [finding(extraction.itemId, extraction.extra)],
    });
  }

  const handoff = extraction.handoff;
  const missing = canonicalControlHandoffMissingFields(handoff);
  if (missing.length > 0) {
    return report({
      verdict: "BLOCKED",
      resultDir,
      ref: parsedRef,
      comment,
      handoff,
      blockers: [finding("CHANDOFF-REF-010", { missing_fields: missing })],
    });
  }
  if (actualRepo && normalizeRepo(handoff.repository?.name) !== normalizeRepo(actualRepo)) {
    return report({
      verdict: "BLOCKED",
      resultDir,
      ref: parsedRef,
      comment,
      handoff,
      blockers: [finding("CHANDOFF-REF-011", { expected: actualRepo, observed: handoff.repository?.name ?? null })],
    });
  }

  const materializedPath = path.join(resultDir, "external-control-handoff.yaml");
  const sourcePath = path.join(resultDir, "external-control-handoff-source.json");
  const yamlBuffer = Buffer.from(extraction.yaml, "utf8");
  const digest = createHash("sha256").update(yamlBuffer).digest("hex");
  writeFileSync(materializedPath, yamlBuffer);
  writeFileSync(sourcePath, `${JSON.stringify({
    schema_version: SOURCE_SCHEMA,
    generated_by: "scripts/shirube/resolve-control-handoff-ref.mjs",
    resolver_schema: SCHEMA,
    source_type: "github_issue_comment",
    requested_ref: sourceRef,
    source_comment_url: comment.html_url,
    source_repository: parsedRef.repo,
    issue_number: issueNumberFromComment(comment),
    comment_id: String(comment.id),
    sha256_utf8_bytes: digest,
    utf8_bytes: yamlBuffer.byteLength,
    materialized_path: materializedPath,
    target_repo: handoff.repository.name,
    runtime_exact_head: actualHead,
    exact_head_source: actualHead ? "github_pr_event_or_explicit_runtime_context" : null,
    target_branch_mutated: false,
    owner_approval_synthesized: false,
  }, null, 2)}\n`);

  return report({
    verdict: "PASS",
    resultDir,
    ref: parsedRef,
    comment,
    handoff,
    materializedPath,
    sourcePath,
    digest,
    byteLength: yamlBuffer.byteLength,
    actualHead,
    warnings: extraction.warnings,
  });
}

export function parseControlHandoffCommentRef(value) {
  if (typeof value !== "string") return null;
  const ref = value.trim();
  let match = ref.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)#issuecomment-(\d+)$/);
  if (match) return commentRef({ repo: match[1], issueNumber: match[3], commentId: match[4], sourceRef: ref });
  match = ref.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/);
  if (match) return commentRef({ repo: match[1], commentId: match[2], sourceRef: ref });
  match = ref.match(/^github-comment:\/\/([^/]+\/[^/]+)\/(\d+)$/);
  if (match) return commentRef({ repo: match[1], commentId: match[2], sourceRef: ref });
  return null;
}

export function extractCanonicalControlHandoff(body) {
  if (![...body.matchAll(MARKER)].length) return { error: true, itemId: "CHANDOFF-REF-005" };
  const structuredBlocks = [...body.matchAll(/```(?:ya?ml)[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
  const blocks = [];
  for (const match of structuredBlocks) {
    const yaml = match[1];
    let parsed;
    try {
      parsed = parseYaml(yaml);
    } catch (error) {
      if (/schema_version\s*:/m.test(yaml)) {
        return { error: true, itemId: "CHANDOFF-REF-008", extra: { detail: errorMessage(error) } };
      }
      continue;
    }
    if (parsed?.schema_version === CANONICAL_CONTROL_HANDOFF_SCHEMA) blocks.push({ yaml, handoff: parsed });
  }
  if (blocks.length === 0) {
    const hasWrongSchema = structuredBlocks.some((match) => /schema_version\s*:/m.test(match[1]));
    return { error: true, itemId: hasWrongSchema ? "CHANDOFF-REF-009" : "CHANDOFF-REF-006" };
  }
  const unique = new Set(blocks.map((entry) => stableStringify(entry.handoff)));
  if (unique.size > 1) return { error: true, itemId: "CHANDOFF-REF-007" };
  return {
    ...blocks[0],
    warnings: blocks.length > 1
      ? [warning("CHANDOFF-REF-W001", "duplicate_identical_handoff_blocks", "Duplicate identical canonical handoff blocks were found; the first exact byte sequence was materialized.")]
      : [],
  };
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
  return fetchJson({ apiPath: `/repos/${owner}/${repo}/issues/comments/${parsedRef.commentId}`, token });
}

function fetchJson({ apiPath, token }) {
  return new Promise((resolve) => {
    const request = https.request({
      hostname: "api.github.com",
      path: apiPath,
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "shirube-control-handoff-ref-resolver",
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

function commentIdentityMismatch(parsedRef, comment) {
  const observedRepo = repoFromApiUrl(comment?.issue_url) ?? repoFromHtmlUrl(comment?.html_url);
  const observedIssue = issueNumberFromComment(comment);
  if (String(comment?.id ?? "") !== parsedRef.commentId) {
    return { expected_comment_id: parsedRef.commentId, observed_comment_id: comment?.id ?? null };
  }
  if (normalizeRepo(observedRepo) !== normalizeRepo(parsedRef.repo)) {
    return { expected_repo: parsedRef.repo, observed_repo: observedRepo };
  }
  if (parsedRef.issueNumber && String(observedIssue ?? "") !== parsedRef.issueNumber) {
    return { expected_issue_number: parsedRef.issueNumber, observed_issue_number: observedIssue };
  }
  return null;
}

function report({ verdict, resultDir, ref = null, comment = null, handoff = null, materializedPath = null, sourcePath = null, digest = null, byteLength = null, actualHead = null, blockers = [], warnings = [] }) {
  return {
    schema: SCHEMA,
    verdict,
    would_block: ["BLOCKED", "FAILURE"].includes(verdict),
    source_comment_url: comment?.html_url ?? ref?.sourceRef ?? null,
    source_repository: ref?.repo ?? null,
    comment_id: comment?.id ? String(comment.id) : ref?.commentId ?? null,
    materialized_path: materializedPath,
    source_metadata_path: sourcePath,
    target_repo: handoff?.repository?.name ?? null,
    cell_id: handoff?.cell?.id ?? null,
    allowed_paths: Array.isArray(handoff?.allowed_paths) ? handoff.allowed_paths : [],
    forbidden_paths: Array.isArray(handoff?.forbidden_paths) ? handoff.forbidden_paths : [],
    sha256_utf8_bytes: digest,
    utf8_bytes: byteLength,
    runtime_exact_head: actualHead,
    exact_head_source: actualHead ? "github_pr_event_or_explicit_runtime_context" : null,
    result_dir: resultDir,
    target_branch_mutated: false,
    owner_approval_synthesized: false,
    blockers,
    warnings,
    required_next_actions: [...blockers, ...warnings].map((item) => ({ item_id: item.item_id, action: item.message })),
  };
}

function finding(itemId, extra = {}) {
  const [code, message] = FINDINGS[itemId];
  return { item_id: itemId, code, message, ...extra };
}

function warning(itemId, code, message) {
  return { item_id: itemId, code, message };
}

function commentRef({ repo, issueNumber = null, commentId, sourceRef }) {
  return { repo, issueNumber: issueNumber ? String(issueNumber) : null, commentId: String(commentId), sourceRef };
}

function parseYaml(text) {
  const json = execFileSync("ruby", [
    "-ryaml",
    "-rjson",
    "-rdate",
    "-e",
    "body = YAML.safe_load(STDIN.read, permitted_classes: [Date, Time], aliases: true); puts JSON.generate(body)",
  ], { input: text, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(json);
}

function repoFromApiUrl(value) {
  return String(value ?? "").match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/\d+$/)?.[1] ?? null;
}

function repoFromHtmlUrl(value) {
  return String(value ?? "").match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+#issuecomment-\d+$/)?.[1] ?? null;
}

function issueNumberFromComment(comment) {
  return String(comment?.issue_url ?? "").match(/\/issues\/(\d+)$/)?.[1] ??
    String(comment?.html_url ?? "").match(/\/(?:issues|pull)\/(\d+)#issuecomment-/)?.[1] ?? null;
}

function commentBodyText(comment) {
  const body = String(comment?.body ?? "");
  return !body.includes("\n") && body.includes("\\n") ? body.replace(/\\n/g, "\n") : body;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function normalizeRepo(value) {
  return String(value ?? "").trim().toLowerCase();
}

function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const result = await buildControlHandoffRefReport(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (options.format !== "json" || result.verdict === "FAILURE") process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main();
}
