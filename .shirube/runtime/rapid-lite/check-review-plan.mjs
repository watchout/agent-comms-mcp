#!/usr/bin/env node
import { existsSync } from "node:fs";
import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";
import {
  REVIEW_PLAN_SCHEMA,
  buildReviewPlan,
  readChangedFiles,
} from "./build-review-plan.mjs";
import {
  buildNextActionSequencing,
  additionalReviewCompletionFrom as sequencingAdditionalReviewCompletionFrom,
} from "./next-action-sequencing.mjs";

const SCHEMA = "shirube-review-plan-check/v1";

const FINDINGS = {
  "REVIEW-001": ["missing_or_invalid_review_plan", "Review plan is missing or invalid.", "review_plan"],
  "REVIEW-002": ["required_additional_review_missing", "Required additional review is missing or incomplete.", "additional_reviews"],
  "REVIEW-003": ["additional_review_head_mismatch", "Additional review exact head does not match the current head.", "additional_reviews"],
  "OWNER-SEQ-001": ["owner_decision_before_audit_complete", "Owner exact-head decision cannot be accepted before independent audit completion.", "owner_decision"],
  "REVIEW-SEQ-001": ["owner_decision_before_additional_review_complete", "Owner exact-head decision cannot be accepted before required additional reviews complete.", "owner_decision"],
};

export function buildReviewPlanCheck(input = {}) {
  const blockers = [];
  const warnings = [];
  const reviewPlan = isObject(input.reviewPlan)
    ? input.reviewPlan
    : buildReviewPlan({
        handoff: input.handoff,
        repoPolicy: input.repoPolicy,
        changedFiles: input.changedFiles,
      });

  if (!validReviewPlan(reviewPlan)) {
    blockers.push(finding("REVIEW-001"));
  }

  const additionalCompletion = additionalReviewCompletionFrom({
    reviewPlan,
    additionalReviewReports: input.additionalReviewReports,
    additionalReviewSource: input.additionalReviewSource,
    additionalReviewSourceTrusted: input.additionalReviewSourceTrusted,
    actualHead: input.actualHead,
    actualRepo: input.actualRepo,
    actualPr: input.actualPr,
  });

  for (const missing of additionalCompletion.missing_reviews) {
    blockers.push(finding("REVIEW-002", {
      path: `additional_reviews.${missing}`,
      message: `Required additional review ${missing} is missing or incomplete.`,
    }));
  }
  for (const mismatch of additionalCompletion.head_mismatches) {
    blockers.push(finding("REVIEW-003", {
      path: `additional_reviews.${mismatch.review_type}`,
      message: `${mismatch.review_type} head ${mismatch.observed} does not match expected head ${mismatch.expected}.`,
    }));
  }

  const sequencing = buildNextActionSequencing({
    handoff: input.handoff,
    repoSpec: input.repoSpec,
    reviewPlan,
    additionalReviewReports: input.additionalReviewReports,
    additionalReviewSource: input.additionalReviewSource,
    additionalReviewSourceTrusted: input.additionalReviewSourceTrusted,
    auditChecklistReport: input.auditChecklistReport,
    structuredAudit: input.structuredAudit,
    structuredAuditPath: input.structuredAuditPath,
    auditSource: input.auditSource,
    auditSourceTrusted: input.auditSourceTrusted,
    ownerDecision: input.ownerDecision,
    actualHead: input.actualHead,
    actualRepo: input.actualRepo,
    actualPr: input.actualPr,
    blockingFindings: blockers,
  });

  for (const blocker of sequencing.blockers ?? []) {
    if (blocker.item_id === "OWNER-SEQ-001") blockers.push(finding("OWNER-SEQ-001"));
    if (blocker.item_id === "REVIEW-SEQ-001") blockers.push(finding("REVIEW-SEQ-001"));
  }

  const uniqueBlockers = uniqueFindings(blockers);
  const uniqueWarnings = uniqueFindings(warnings);
  const verdict = uniqueBlockers.length > 0 ? "BLOCKED" : uniqueWarnings.length > 0 ? "PASS_WITH_WARN" : "PASS";
  return {
    schema: SCHEMA,
    verdict,
    would_block: verdict === "BLOCKED",
    owner_must_not_merge: verdict === "BLOCKED",
    current_phase: sequencing.current_phase,
    next_action: sequencing.next_action,
    operation_code: sequencing.operation_code,
    approval_class: sequencing.approval_class,
    protected_surface_refs: sequencing.protected_surface_refs,
    authority_result_code: sequencing.result_code,
    owner_approval_allowed: sequencing.owner_approval_allowed,
    merge_ready_allowed: sequencing.merge_ready_allowed,
    forbidden_next_actions: sequencing.forbidden_next_actions,
    review_plan: reviewPlan,
    additional_review_completion: additionalCompletion,
    audit_required: sequencing.audit_required,
    audit_completion: sequencing.audit_completion,
    owner_decision_status: sequencing.owner_decision_status,
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    required_next_actions: requiredNextActions(uniqueBlockers, uniqueWarnings, sequencing),
  };
}

function validReviewPlan(plan) {
  return isObject(plan) &&
    plan.schema_version === REVIEW_PLAN_SCHEMA &&
    isObject(plan.base_audit) &&
    isObject(plan.owner_decision) &&
    isObject(plan.decision_basis) &&
    Array.isArray(plan.additional_reviews);
}

export function additionalReviewCompletionFrom(input = {}) {
  return sequencingAdditionalReviewCompletionFrom(input);
}

function finding(itemId, overrides = {}) {
  const [code, message, defaultPath] = FINDINGS[itemId];
  return {
    item_id: itemId,
    code,
    message: overrides.message ?? message,
    path: overrides.path ?? defaultPath,
  };
}

function requiredNextActions(blockers, warnings, sequencing) {
  if (sequencing?.next_action?.action) {
    return [{
      action: sequencing.next_action.action,
      responsible_role: sequencing.next_action.responsible_role,
      allowed_actor_role: sequencing.next_action.allowed_actor_role,
      message: sequencing.next_action.reason,
    }];
  }
  return [...blockers, ...warnings].map((item) => ({
    item_id: item.item_id,
    action: actionFor(item.item_id),
  }));
}

function actionFor(itemId) {
  const actions = {
    "REVIEW-001": "Generate a machine-derived shirube-review-plan/v1 artifact.",
    "REVIEW-002": "Provide required additional protected review evidence.",
    "REVIEW-003": "Refresh additional review evidence for the current exact head.",
    "OWNER-SEQ-001": "Complete independent audit before accepting owner exact-head approval.",
    "REVIEW-SEQ-001": "Complete required additional reviews before accepting owner exact-head approval.",
  };
  return actions[itemId] ?? "Resolve review-plan finding.";
}

function readInput(options) {
  const refs = {
    handoffPath: stringOption(options.handoff),
    repoSpecPath: stringOption(options["repo-spec"]),
    repoPolicyPath: stringOption(options["repo-policy"]),
    reviewPlanPath: stringOption(options["review-plan"]),
    changedFilesPath: stringOption(options["changed-files"]),
    auditChecklistReportPath: stringOption(options["audit-checklist-report"]),
    structuredAuditPath: stringOption(options["structured-audit"]),
    auditSourcePath: stringOption(options["audit-source"]) ?? stringOption(options["structured-audit-source"]),
    auditSourceTrusted: options["trusted-audit-source"] === true,
    ownerDecisionPath: stringOption(options["owner-decision"]),
    additionalReviewPath: stringOption(options["additional-review"]),
    additionalReviewSourcePath: stringOption(options["additional-review-source"]),
    additionalReviewSourceTrusted: options["trusted-additional-review-source"] === true,
    actualRepo: stringOption(options["actual-repo"]),
    actualPr: stringOption(options["actual-pr"]),
    actualHead: stringOption(options["actual-head"]),
  };
  const input = {
    ...refs,
    handoff: readOptional(refs.handoffPath),
    repoSpec: readOptional(refs.repoSpecPath),
    repoPolicy: readOptional(refs.repoPolicyPath),
    reviewPlan: readOptional(refs.reviewPlanPath),
    auditChecklistReport: readOptional(refs.auditChecklistReportPath),
    structuredAudit: readOptional(refs.structuredAuditPath),
    auditSource: readOptional(refs.auditSourcePath),
    ownerDecision: readOptional(refs.ownerDecisionPath),
    additionalReviewReports: readAdditionalReviews(refs.additionalReviewPath),
    additionalReviewSource: readOptional(refs.additionalReviewSourcePath),
    additionalReviewSourceTrusted: refs.additionalReviewSourceTrusted,
    changedFiles: readChangedFiles(refs.changedFilesPath),
  };
  return input;
}

function readAdditionalReviews(value) {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((filePath) => {
    const report = readOptional(filePath);
    return isObject(report) ? { ...report, __file_path: filePath } : report;
  }).filter(Boolean);
}

function readOptional(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return readStructuredFile(filePath);
}

function normalizeRepo(value) {
  if (isPlaceholder(value)) return null;
  const text = String(value).trim();
  const match = text.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  return match ? match[1] : text;
}

function normalizePr(value) {
  if (isPlaceholder(value)) return null;
  const text = String(value).trim();
  const match = text.match(/#(\d+)|\/pull\/(\d+)|\/issues\/(\d+)|^(\d+)$/);
  return match ? (match[1] ?? match[2] ?? match[3] ?? match[4]) : text;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function firstPresent(...values) {
  return values.find((value) => !isPlaceholder(value));
}

function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return text.length === 0 || /^<.*>$/.test(text) || /^(pending|todo|tbd|null|none|n\/a)$/i.test(text);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function uniqueFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.item_id}:${finding.path}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stringOption(value) {
  return typeof value === "string" ? value : null;
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.format !== "json") {
    process.stdout.write(`${JSON.stringify({
      schema: SCHEMA,
      verdict: "FAILURE",
      required_next_actions: [{ code: "unsupported_format", message: "--format json is required." }],
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const report = buildReviewPlanCheck(readInput(options));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schema: SCHEMA,
      verdict: "FAILURE",
      would_block: true,
      owner_must_not_merge: true,
      blockers: [{
        item_id: "REVIEW-001",
        code: "review_plan_check_failed",
        message: error instanceof Error ? error.message : String(error),
        path: "review_plan",
      }],
      warnings: [],
      required_next_actions: [{ item_id: "REVIEW-001", action: "Fix review-plan check inputs." }],
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) main();
