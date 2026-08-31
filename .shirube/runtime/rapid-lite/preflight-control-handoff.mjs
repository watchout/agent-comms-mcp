#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
  writeResult,
} from "./lib.mjs";
import {
  canonicalControlHandoffMissingFields,
  CANONICAL_CONTROL_HANDOFF_SCHEMA,
} from "./normalize-control-handoff.mjs";
import { extractCanonicalControlHandoff } from "./resolve-control-handoff-ref.mjs";
import { buildRapidLiteReport } from "./run-rapid-lite-report.mjs";
import {
  prepareWorkflowDirectories,
  writeNewResultFile,
} from "./run-rapid-lite-workflow.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECOGNIZED_EVIDENCE_TYPES = new Set([
  "pr_head_sha",
  "changed_files",
  "validation_commands",
  "validation_results",
  "owner_decision",
  "control_state_completeness_report",
  "audit_checklist_report",
]);
const BINDING_KEYS = [
  "handoff_ref",
  "handoff",
  "control_handoff_ref",
  "control_handoff",
  "control-handoff",
  "control_handoff_comment_ref",
  "control_handoff_comment",
];

export function prepareCompatibilityCompleteHandoff(value, options = {}) {
  const prepared = structuredClone(value);
  const cell = isObject(prepared.cell) ? prepared.cell : {};
  const cellId = firstString(cell.id, cell["CELL-ID"], cell.cell_id, prepared.cell_id, prepared.CELL_ID);
  if (cellId) {
    prepared.cell = {
      ...cell,
      id: cellId,
      "CELL-ID": cellId,
      cell_id: cellId,
    };
  }

  const handoffId = firstString(prepared.handoff_id, prepared.control_handoff_id);
  if (handoffId) {
    prepared.handoff_id = handoffId;
    prepared.control_handoff_id = handoffId;
  }

  if (options.markReadyForImplementation === true) {
    prepared.lifecycle_state = "READY_FOR_IMPLEMENTATION";
    prepared.artifact_state = "READY_FOR_IMPLEMENTATION";
    prepared.spec_review_state = "ready_for_implementation";
    prepared.handoff_ready_for_implementation = true;
  }

  if (!hasProtectedDeclaration(prepared)) {
    prepared.protected_stop = true;
  }

  const validation = isObject(prepared.validation) ? prepared.validation : {};
  const required = asStringArray(validation.required_evidence);
  const concreteRefs = required.filter(isConcreteEvidenceRef);
  const evidenceRequirements = required
    .filter((entry) => !isConcreteEvidenceRef(entry))
    .map(normalizeEvidenceType)
    .filter(Boolean);
  const inferredTypes = [];
  if (firstString(prepared.pr_head_sha, prepared.exact_subject?.head_commit, prepared.exact_subject?.head)) {
    inferredTypes.push("pr_head_sha");
  }
  if (asStringArray(prepared.allowed_paths).length > 0) inferredTypes.push("changed_files");
  if (asStringArray(validation.required_commands ?? prepared.required_checks ?? prepared.required_commands).length > 0) {
    inferredTypes.push("validation_commands");
  }
  prepared.validation = {
    ...validation,
    required_evidence: uniqueStrings([...evidenceRequirements, ...inferredTypes]),
    evidence_refs: uniqueStrings([...asStringArray(validation.evidence_refs), ...concreteRefs]),
  };
  return prepared;
}

export function publicationCompatibilityFindings(handoff) {
  const findings = [];
  if (!isObject(handoff) || handoff.schema_version !== CANONICAL_CONTROL_HANDOFF_SCHEMA) {
    findings.push(finding("PREFLIGHT-001", "canonical_schema_missing", "schema_version must be shirube-v3/control_handoff/v1."));
    return findings;
  }
  for (const field of canonicalControlHandoffMissingFields(handoff)) {
    findings.push(finding("PREFLIGHT-002", "canonical_field_missing", `${field} is required.`, field));
  }

  const cellId = firstString(handoff.cell?.id);
  if (!cellId || handoff.cell?.["CELL-ID"] !== cellId || handoff.cell?.cell_id !== cellId) {
    findings.push(finding("PREFLIGHT-003", "cell_id_compatibility_missing", "cell.id, cell.CELL-ID, and cell.cell_id must be identical.", "cell"));
  }
  if (handoff.lifecycle_state !== "READY_FOR_IMPLEMENTATION" || handoff.spec_review_state !== "ready_for_implementation") {
    findings.push(finding("PREFLIGHT-004", "handoff_not_ready_for_implementation", "lifecycle_state and spec_review_state must use the runtime-ready compatibility values.", "spec_review_state"));
  }
  if (!hasProtectedDeclaration(handoff)) {
    findings.push(finding("PREFLIGHT-005", "protected_stop_missing", "A protected stop, escalation route, or protected surface declaration is required.", "protected_stop"));
  }

  const evidence = asStringArray(handoff.validation?.required_evidence);
  if (evidence.length === 0) {
    findings.push(finding("PREFLIGHT-006", "required_evidence_types_missing", "validation.required_evidence must contain checker-recognized evidence types.", "validation.required_evidence"));
  }
  for (const entry of evidence) {
    const normalized = normalizeEvidenceType(entry);
    if (!RECOGNIZED_EVIDENCE_TYPES.has(normalized)) {
      findings.push(finding("PREFLIGHT-007", "unrecognized_required_evidence", `${entry} is not a checker-recognized evidence type.`, "validation.required_evidence"));
    }
  }
  if (!semanticHandoffKey(handoff)) {
    findings.push(finding("PREFLIGHT-008", "semantic_identity_incomplete", "repo, PR, exact head, Cell, corrective ID, and allowed paths are required for duplicate detection."));
  }
  if (distinctStrings([
    handoff.exact_subject?.head_commit,
    handoff.exact_subject?.head,
    handoff.pr_head_sha,
  ], (value) => value.toLowerCase()).length > 1) {
    findings.push(finding("PREFLIGHT-009", "exact_head_alias_mismatch", "All exact-head aliases must identify the same commit.", "exact_subject"));
  }
  if (distinctStrings([
    handoff.repository?.name,
    handoff.repo,
  ], (value) => value.toLowerCase()).length > 1) {
    findings.push(finding("PREFLIGHT-010", "repository_alias_mismatch", "All repository aliases must identify the same repository.", "repository"));
  }
  if (distinctStrings([
    firstScalarString(handoff.repository?.pull_request),
    firstScalarString(handoff.pull_request),
    firstScalarString(handoff.PR),
  ]).length > 1) {
    findings.push(finding("PREFLIGHT-011", "pull_request_alias_mismatch", "All pull-request aliases must identify the same pull request.", "repository.pull_request"));
  }
  const handoffId = firstString(handoff.handoff_id, handoff.control_handoff_id);
  if (!isMarkerSafeHandoffId(handoffId)) {
    findings.push(finding("PREFLIGHT-016", "marker_unsafe_handoff_id", "The handoff id must be safe for the canonical resolver marker.", "handoff_id"));
  }
  return dedupeFindings(findings);
}

export function publicationSubjectFindings(handoff, { actualRepo, actualPr, actualHead } = {}) {
  const findings = [];
  const repo = firstString(handoff?.repository?.name, handoff?.repo);
  const pullRequest = firstScalarString(handoff?.repository?.pull_request, handoff?.pull_request, handoff?.PR);
  const heads = distinctStrings([
    handoff?.exact_subject?.head_commit,
    handoff?.exact_subject?.head,
    handoff?.pr_head_sha,
  ], (value) => value.toLowerCase());
  if (!nonEmptyString(actualRepo)) {
    findings.push(finding("PREFLIGHT-017", "actual_repository_missing", "The authenticated runtime repository is required.", "actual_repo"));
  } else if (repo?.toLowerCase() !== actualRepo.toLowerCase()) {
    findings.push(finding("PREFLIGHT-012", "actual_repository_mismatch", "The handoff repository must match the authenticated runtime repository.", "repository.name"));
  }
  if (!firstScalarString(actualPr)) {
    findings.push(finding("PREFLIGHT-018", "actual_pull_request_missing", "The authenticated runtime pull request is required.", "actual_pr"));
  } else if (pullRequest !== firstScalarString(actualPr)) {
    findings.push(finding("PREFLIGHT-013", "actual_pull_request_mismatch", "The handoff pull request must match the authenticated runtime pull request.", "repository.pull_request"));
  }
  if (!nonEmptyString(actualHead)) {
    findings.push(finding("PREFLIGHT-019", "actual_head_missing", "The authenticated runtime head is required.", "actual_head"));
  } else if (heads.length !== 1 || heads[0] !== actualHead.toLowerCase()) {
    findings.push(finding("PREFLIGHT-014", "actual_head_mismatch", "Every handoff head alias must match the authenticated runtime head.", "exact_subject.head_commit"));
  }
  return findings;
}

export function semanticHandoffKey(handoff) {
  if (!isObject(handoff)) return null;
  const repos = distinctStrings([handoff.repository?.name, handoff.repo], (value) => value.toLowerCase());
  const pullRequests = distinctStrings([
    firstScalarString(handoff.repository?.pull_request),
    firstScalarString(handoff.pull_request),
    firstScalarString(handoff.PR),
  ]);
  const heads = distinctStrings([
    handoff.exact_subject?.head_commit,
    handoff.exact_subject?.head,
    handoff.pr_head_sha,
  ], (value) => value.toLowerCase());
  const repo = repos.length === 1 ? repos[0] : null;
  const pullRequest = pullRequests.length === 1 ? pullRequests[0] : null;
  const head = heads.length === 1 ? heads[0] : null;
  const cellId = firstString(handoff.cell?.id, handoff.cell?.["CELL-ID"], handoff.cell?.cell_id, handoff.cell_id);
  const correctiveId = firstString(handoff.corrective_id, handoff.implementation_id, handoff.IMPL_ID);
  const allowedPaths = uniqueStrings(asStringArray(handoff.allowed_paths ?? handoff.cell?.allowed_paths)).sort();
  if (!repo || !pullRequest || !head || !cellId || !correctiveId || allowedPaths.length === 0) return null;
  return JSON.stringify({
    repo: repo.toLowerCase(),
    pull_request: String(pullRequest),
    head: head.toLowerCase(),
    cell_id: cellId,
    corrective_id: correctiveId,
    allowed_paths: allowedPaths,
  });
}

export function findUnresolvedSemanticDuplicates({ candidate, comments }) {
  const candidateKey = semanticHandoffKey(candidate);
  if (!candidateKey) return [];
  const supersedes = new Set(asStringArray(candidate.supersedes));
  const duplicates = [];
  for (const comment of flattenComments(comments)) {
    const body = typeof comment?.body === "string" ? comment.body : "";
    const extracted = extractCanonicalControlHandoff(body);
    if (extracted.error || semanticHandoffKey(extracted.handoff) !== candidateKey) continue;
    const url = firstString(comment.html_url, comment.url, comment.comment_url);
    if (url && supersedes.has(url)) continue;
    duplicates.push({
      id: comment.id ?? null,
      html_url: url ?? null,
      marker: body.split(/\r?\n/, 1)[0] ?? "",
    });
  }
  return duplicates;
}

export function expectedHostedHandoffRef({ workspaceRoot, targetDir, resultDirName = ".shirube-rapid-lite" }) {
  const resultFile = path.join(path.resolve(workspaceRoot), resultDirName, "external-control-handoff.yaml");
  const relative = path.relative(path.resolve(targetDir), resultFile).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export function buildPublicationComment(handoff) {
  const handoffId = firstString(handoff?.handoff_id, handoff?.control_handoff_id);
  if (!isMarkerSafeHandoffId(handoffId)) {
    throw new Error("A marker-safe canonical handoff id is required to build the publication comment.");
  }
  return [
    `<!-- shirube-v3:control-handoff:${handoffId} -->`,
    "",
    "```yaml",
    JSON.stringify(handoff, null, 2),
    "```",
    "",
  ].join("\n");
}

export function publicationArtifactPaths(trustedResultDir) {
  return {
    preparedHandoff: path.join(trustedResultDir, "prepared-control-handoff.json"),
    publicationComment: path.join(trustedResultDir, "publication-comment.md"),
  };
}

export function publicationDecision({
  handoff,
  aggregate,
  comments,
  commentsChecked = false,
  actualRepo,
  actualPr,
  actualHead,
}) {
  const commentScanComplete = commentsChecked === true && isCompleteCommentsPayload(comments);
  const findings = [
    ...publicationCompatibilityFindings(handoff),
    ...publicationSubjectFindings(handoff, { actualRepo, actualPr, actualHead }),
  ];
  if (!commentScanComplete) {
    findings.push(finding("PREFLIGHT-015", "comment_scan_incomplete", "The semantic duplicate scan requires a complete array of stable GitHub comment records.", "comments"));
  }
  const semanticDuplicates = commentScanComplete
    ? findUnresolvedSemanticDuplicates({ candidate: handoff, comments })
    : [{ id: null, html_url: null, marker: "comments_not_checked" }];
  const aggregatePass = isObject(aggregate) &&
    aggregate.schema === "shirube-rapid-lite-report/v1" &&
    ["PASS", "PASS_WITH_WARN"].includes(aggregate.verdict) &&
    aggregate.report_failed === false &&
    aggregate.would_block === false;
  return {
    allow_publish: findings.length === 0 && semanticDuplicates.length === 0 && aggregatePass,
    compatibility_findings: findings,
    semantic_duplicates: semanticDuplicates,
    aggregate: isObject(aggregate)
        ? {
          schema: aggregate.schema ?? null,
          verdict: aggregate.verdict ?? null,
          would_block: aggregate.would_block ?? null,
          report_failed: aggregate.report_failed ?? null,
        }
      : null,
  };
}

export function runPreparedAggregate({
  handoff,
  prBody,
  changedFilesPath,
  workspaceRoot,
  targetDir,
  resultDir,
  actualRepo,
  actualPr,
  actualBranch,
  actualHead,
}) {
  const preparedDirectories = prepareWorkflowDirectories({
    workspaceRoot,
    targetDir,
    resultDir,
  });
  const target = preparedDirectories.targetDir;
  const results = preparedDirectories.resultDir;
  const preparedPath = path.join(results, "prepared-control-handoff.json");
  const publicationCommentPath = path.join(results, "publication-comment.md");
  const prBodyPath = path.join(results, "preflight-pr-body.md");
  const stableChangedFilesPath = path.join(results, "changed-files.txt");
  writeNewResultFile(preparedPath, `${JSON.stringify(handoff, null, 2)}\n`);
  writeNewResultFile(publicationCommentPath, buildPublicationComment(handoff));
  writeNewResultFile(prBodyPath, buildPreflightBody({ prBody, preparedPath, targetDir: target }));
  writeNewResultFile(stableChangedFilesPath, readFileSync(changedFilesPath, "utf8"));

  const previousCwd = process.cwd();
  try {
    process.chdir(target);
    const aggregate = buildRapidLiteReport({
      "result-dir": results,
      "changed-files": stableChangedFilesPath,
      "pr-body": prBodyPath,
      "diff-root": ".",
      "actual-repo": actualRepo,
      "actual-pr": String(actualPr),
      "actual-branch": actualBranch,
      "actual-head": actualHead,
    });
    return { aggregate, resultDir: results };
  } finally {
    process.chdir(previousCwd);
  }
}

export function buildPreflightBody({ prBody, preparedPath, targetDir }) {
  const localRefs = [
    ["execution_context_ref", ".shirube/execution-context.yaml"],
    ["adoption_plan_ref", ".shirube/adoption-intake.yaml"],
    ["lifecycle_state_ref", ".shirube/lifecycle-state.yaml"],
    ["enforcement_policy_ref", ".shirube/enforcement-policy.yaml"],
  ].filter(([, value]) => existsSync(path.join(targetDir, value)));
  return [
    "<!-- shirube:publication-preflight/v1 -->",
    `matrix_ref: ${path.join(SCRIPT_DIR, "shirube-v3-rapid-lite-gate-contract-matrix.yaml")}`,
    `rule_pack_ref: ${path.join(SCRIPT_DIR, "shirube-default-design-rules.yaml")}`,
    `handoff_ref: ${preparedPath}`,
    "",
    stripBindingLines(prBody),
    "",
    ...localRefs.map(([key, value]) => `${key}: ${value}`),
    "",
  ].join("\n");
}

function stripBindingLines(body) {
  const keys = BINDING_KEYS.map(escapeRegExp).join("|");
  const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?(?:${keys})\\s*:\\s*.*$`, "gim");
  return String(body ?? "").replace(pattern, "").trim();
}

function hasProtectedDeclaration(handoff) {
  const cell = isObject(handoff?.cell) ? handoff.cell : {};
  return handoff?.protected_stop === true ||
    cell.protected_stop === true ||
    nonEmptyString(handoff?.escalation_route) ||
    nonEmptyString(cell.escalation_route) ||
    asStringArray(handoff?.protected_surfaces).length > 0 ||
    asStringArray(cell.protected_surfaces).length > 0;
}

function isConcreteEvidenceRef(value) {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+#issuecomment-\d+$/.test(String(value ?? "").trim());
}

function normalizeEvidenceType(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function flattenComments(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => Array.isArray(entry) ? flattenComments(entry) : [entry]);
}

function isCompleteCommentsPayload(value) {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => Array.isArray(entry)
    ? isCompleteCommentsPayload(entry)
    : isObject(entry) && typeof entry.body === "string" &&
      (isPositiveCommentId(entry.id) || isStableCommentUrl(entry.html_url) || isStableCommentUrl(entry.url)));
}

function isPositiveCommentId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isStableCommentUrl(value) {
  return typeof value === "string" && (
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+#issuecomment-[1-9][0-9]*$/.test(value) ||
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/comments\/[1-9][0-9]*$/.test(value)
  );
}

function isMarkerSafeHandoffId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(nonEmptyString))];
}

function distinctStrings(values, normalize = (value) => value) {
  return uniqueStrings(values.map((value) => String(value ?? "").trim()).filter(Boolean).map(normalize));
}

function firstString(...values) {
  return values.find(nonEmptyString) ?? null;
}

function firstScalarString(...values) {
  for (const value of values) {
    if (nonEmptyString(value)) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finding(itemId, code, message, field = null) {
  return { item_id: itemId, code, message, field };
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((entry) => {
    const key = `${entry.code}:${entry.field ?? ""}:${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const required = ["handoff", "pr-body", "changed-files", "workspace-root", "target-dir", "result-dir", "actual-repo", "actual-pr", "actual-head"];
  const missing = required.filter((key) => !nonEmptyString(options[key]));
  if (missing.length > 0) throw new Error(`Missing required options: ${missing.join(", ")}`);

  const rawHandoff = readStructuredFile(options.handoff);
  const prepared = prepareCompatibilityCompleteHandoff(rawHandoff, {
    markReadyForImplementation: options["mark-ready-for-implementation"] === true || options["mark-ready-for-implementation"] === "true",
  });
  const commentsSupplied = nonEmptyString(options["comments-json"]);
  const comments = commentsSupplied ? JSON.parse(readFileSync(options["comments-json"], "utf8")) : null;
  const commentsChecked = commentsSupplied && isCompleteCommentsPayload(comments);
  const preparedRun = runPreparedAggregate({
    handoff: prepared,
    prBody: readFileSync(options["pr-body"], "utf8"),
    changedFilesPath: options["changed-files"],
    workspaceRoot: options["workspace-root"],
    targetDir: options["target-dir"],
    resultDir: options["result-dir"],
    actualRepo: options["actual-repo"],
    actualPr: options["actual-pr"],
    actualBranch: options["actual-branch"] ?? "preflight",
    actualHead: options["actual-head"],
  });
  const aggregate = preparedRun.aggregate;
  const decision = publicationDecision({
    handoff: prepared,
    aggregate,
    comments,
    commentsChecked,
    actualRepo: options["actual-repo"],
    actualPr: options["actual-pr"],
    actualHead: options["actual-head"],
  });
  const preparedBytes = `${JSON.stringify(prepared, null, 2)}\n`;
  const publicationCommentBytes = buildPublicationComment(prepared);
  const artifactPaths = publicationArtifactPaths(preparedRun.resultDir);
  const report = {
    schema_version: "shirube-control-handoff-publication-preflight/v1",
    verdict: decision.allow_publish ? "PASS" : "BLOCKED",
    would_block: !decision.allow_publish,
    allow_publish: decision.allow_publish,
    prepared_handoff_sha256: digest(preparedBytes),
    prepared_handoff_path: artifactPaths.preparedHandoff,
    publication_comment_sha256: digest(publicationCommentBytes),
    publication_comment_path: artifactPaths.publicationComment,
    expected_hosted_binding: {
      handoff_ref: expectedHostedHandoffRef({
        workspaceRoot: options["workspace-root"],
        targetDir: options["target-dir"],
      }),
    },
    ...decision,
    next_action: decision.allow_publish
      ? {
          blocking: false,
          action: "publish_once_then_api_readback",
          completion_evidence: "immutable comment URL, raw body digest, resolver PASS, and hosted aggregate would_block=false",
        }
      : {
          blocking: true,
          action: "resolve_preflight_findings_without_publishing",
          completion_evidence: "a fresh preflight report with allow_publish=true",
        },
  };
  writeResult(report);
  process.exitCode = decision.allow_publish ? 0 : 1;
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    writeResult({
      schema_version: "shirube-control-handoff-publication-preflight/v1",
      verdict: "FAILURE",
      would_block: true,
      allow_publish: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
