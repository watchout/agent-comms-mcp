#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";

export const REVIEW_PLAN_SCHEMA = "shirube-review-plan/v1";

const DEFAULT_CHECKLIST_PROFILE = "standard";
const PROTECTED_SURFACE_REVIEW_MAP = [
  {
    surfaces: ["security", "secrets", "auth"],
    review_type: "security_review",
    responsible_role: "security_owner",
    reason_code: "SECURITY_SURFACE_TOUCHED",
  },
  {
    surfaces: ["privacy", "personal_data", "pii"],
    review_type: "privacy_review",
    responsible_role: "privacy_owner",
    reason_code: "PRIVACY_SURFACE_TOUCHED",
  },
  {
    surfaces: ["legal", "compliance", "contract"],
    review_type: "legal_review",
    responsible_role: "legal_owner",
    reason_code: "LEGAL_SURFACE_TOUCHED",
  },
];

const TECHNICAL_SURFACES = [
  "runtime",
  "policy",
  "permissions",
  "database",
  "db",
  "workflow",
  "external",
  "api",
];

export function buildReviewPlan(input = {}) {
  const handoff = input.handoff ?? {};
  const cell = isObject(handoff.cell) ? handoff.cell : {};
  const repoPolicy = input.repoPolicy ?? {};
  const changedFiles = input.changedFiles ?? [];
  const riskClass = normalizeRisk(firstPresent(cell.risk_class, cell.risk_tier, handoff.risk_class, handoff.risk_tier, repoPolicy.risk_class)) ?? "UNKNOWN";
  const cellType = normalizeText(firstPresent(cell.cell_type, handoff.cell_type, "unknown"));
  const declaredSurfaces = surfaceValues([
    handoff.protected_surfaces,
    cell.protected_surfaces,
    handoff.declared_surfaces,
    cell.declared_surfaces,
  ]);
  const changedSurfaceSummary = changedSurfaceSummaryFrom(changedFiles);
  const protectedSurfaces = uniqueStrings([...declaredSurfaces, ...changedSurfaceSummary]);
  const reasonCodes = [];

  const baseAuditRequired = baseAuditRequiredFrom({ handoff, repoPolicy });
  if (baseAuditRequired) reasonCodes.push("FULL_OPERATIONAL_STANDARD_AUDIT");
  const checklistProfile = checklistProfileFor({ riskClass, cellType, protectedSurfaces, changedSurfaceSummary });
  if (baseAuditRequired && protectedSurfaces.length === 0 && docsLikeCell(cellType)) {
    reasonCodes.push("NO_ADDITIONAL_PROTECTED_REVIEW");
  }

  const additionalReviews = additionalReviewsFor({
    riskClass,
    cellType,
    protectedSurfaces,
    changedSurfaceSummary,
    reasonCodes,
  });

  const ownerAllowedAfter = [];
  if (baseAuditRequired) ownerAllowedAfter.push("base_audit_complete");
  if (additionalReviews.some((review) => review.required)) ownerAllowedAfter.push("all_additional_reviews_complete");

  return {
    schema_version: REVIEW_PLAN_SCHEMA,
    base_audit: {
      required: baseAuditRequired,
      type: "independent_structured_audit",
      checklist_profile: checklistProfile,
    },
    additional_reviews: additionalReviews,
    owner_decision: {
      required: ownerDecisionRequiredFrom({ handoff, repoPolicy }),
      allowed_after: ownerAllowedAfter,
    },
    decision_basis: {
      risk_class: riskClass,
      cell_type: cellType,
      protected_surfaces: protectedSurfaces,
      changed_surface_summary: changedSurfaceSummary,
      reason_codes: uniqueStrings(reasonCodes),
    },
  };
}

export function readChangedFiles(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .sort((a, b) => a.localeCompare(b));
}

export function reviewPlanRequiresRuntimeGate(input = {}) {
  const plan = input.reviewPlan ?? buildReviewPlan(input);
  return plan.base_audit?.required === true ||
    asArray(plan.additional_reviews).some((review) => review?.required === true);
}

function baseAuditRequiredFrom({ handoff, repoPolicy }) {
  if (repoPolicy?.review_plan?.base_audit?.required === false) return false;
  if (handoff?.review_plan?.base_audit?.required === false) return false;
  return true;
}

function ownerDecisionRequiredFrom({ handoff, repoPolicy }) {
  if (repoPolicy?.review_plan?.owner_decision?.required === false) return false;
  if (handoff?.review_plan?.owner_decision?.required === false) return false;
  return true;
}

function checklistProfileFor({ riskClass, cellType, protectedSurfaces, changedSurfaceSummary }) {
  const surfaces = new Set([...protectedSurfaces, ...changedSurfaceSummary].map(normalizeSurface));
  if (["R3", "R4"].includes(riskClass) || hasProtectedReviewSurface(surfaces)) return "protected";
  if (runtimePolicyCell(cellType) || hasAny(surfaces, TECHNICAL_SURFACES)) return "runtime_policy_standard";
  if (docsLikeCell(cellType)) return "docs_light";
  return DEFAULT_CHECKLIST_PROFILE;
}

function additionalReviewsFor({ riskClass, cellType, protectedSurfaces, changedSurfaceSummary, reasonCodes }) {
  const surfaces = new Set([...protectedSurfaces, ...changedSurfaceSummary].map(normalizeSurface));
  const reviews = [];

  if (runtimePolicyCell(cellType) || hasAny(surfaces, TECHNICAL_SURFACES)) {
    addReview(reviews, {
      review_type: "technical_owner_review",
      responsible_role: "technical_owner",
      reason_codes: [
        runtimePolicyCell(cellType) ? "R2_RUNTIME_FOUNDATION" : "TECHNICAL_SURFACE_TOUCHED",
        hasAny(surfaces, ["policy", "permissions"]) ? "POLICY_SURFACE_TOUCHED" : null,
      ],
    });
  }

  if (["R3", "R4"].includes(riskClass) || hasCtoReviewSurface(surfaces)) {
    addReview(reviews, {
      review_type: "cto_review",
      responsible_role: "cto",
      reason_codes: [`${riskClass}_PROTECTED_GOVERNANCE`, "PROTECTED_SURFACE_TOUCHED"],
    });
  }

  for (const entry of PROTECTED_SURFACE_REVIEW_MAP) {
    if (hasAny(surfaces, entry.surfaces)) {
      addReview(reviews, {
        review_type: entry.review_type,
        responsible_role: entry.responsible_role,
        reason_codes: [entry.reason_code],
      });
    }
  }

  for (const review of reviews) {
    for (const code of review.reason_codes) reasonCodes.push(code);
  }
  return reviews;
}

function addReview(reviews, review) {
  const existing = reviews.find((entry) => entry.review_type === review.review_type);
  const reasonCodes = uniqueStrings(review.reason_codes);
  if (existing) {
    existing.reason_codes = uniqueStrings([...existing.reason_codes, ...reasonCodes]);
    return;
  }
  reviews.push({
    review_type: review.review_type,
    responsible_role: review.responsible_role,
    required: true,
    reason_codes: reasonCodes,
  });
}

function changedSurfaceSummaryFrom(files) {
  const surfaces = [];
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    if (/^docs\//.test(normalized)) {
      surfaces.push("docs");
      continue;
    }
    if (/^test\/fixtures\//.test(normalized)) continue;
    if (/^(src|app|api|lib)\//.test(normalized)) surfaces.push("runtime");
    if (/^(db|migrations)\//.test(normalized)) surfaces.push("database");
    if (/^\.github\/workflows\//.test(normalized)) surfaces.push("workflow");
    if (/package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$/.test(normalized)) surfaces.push("package");
    if (/auth|permission|policy/i.test(normalized)) surfaces.push("policy");
    if (/security|secret/i.test(normalized)) surfaces.push("security");
    if (/privacy|legal/i.test(normalized)) surfaces.push(normalized.match(/privacy/i) ? "privacy" : "legal");
  }
  return uniqueStrings(surfaces.map(normalizeSurface).filter((surface) => surface !== "docs"));
}

function surfaceValues(values) {
  return uniqueStrings(asArray(values).flatMap(surfaceValue).map(normalizeSurface).filter(Boolean));
}

function surfaceValue(value) {
  if (Array.isArray(value)) return value.flatMap(surfaceValue);
  if (isObject(value)) {
    if (Array.isArray(value.declared)) return value.declared;
    if (Array.isArray(value.touched)) return value.touched;
    return Object.entries(value).flatMap(([key, entry]) => entry === true ? [key] : surfaceValue(entry));
  }
  if (typeof value === "string") return [value];
  return [];
}

function docsLikeCell(cellType) {
  return /docs?(_|-)?(only|contract)|docs_contract|documentation/i.test(cellType);
}

function runtimePolicyCell(cellType) {
  return /runtime|policy|foundation|integration|workflow|permission|auth|db|database/i.test(cellType);
}

function hasProtectedSurface(surfaces) {
  return hasAny(surfaces, [
    "runtime",
    "policy",
    "permissions",
    "security",
    "privacy",
    "legal",
    "auth",
    "database",
    "db",
    "workflow",
    "external",
    "production",
    "deploy",
  ]);
}

function hasProtectedReviewSurface(surfaces) {
  return hasAny(surfaces, [
    "security",
    "privacy",
    "legal",
    "auth",
    "external",
    "production",
    "deploy",
    "branch_protection",
    "ruleset",
    "rulesets",
  ]);
}

function hasCtoReviewSurface(surfaces) {
  return hasAny(surfaces, [
    "protected",
    "external",
    "production",
    "deploy",
    "branch_protection",
    "ruleset",
    "rulesets",
  ]);
}

function hasAny(set, values) {
  return values.some((value) => set.has(normalizeSurface(value)));
}

function normalizeSurface(value) {
  const text = normalizeText(value);
  if (text === "db") return "database";
  if (text === "workflows") return "workflow";
  if (text === "runtime_code") return "runtime";
  return text;
}

function normalizeRisk(value) {
  const text = String(value ?? "").trim().toUpperCase();
  return ["R0", "R1", "R2", "R3", "R4"].includes(text) ? text : null;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
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

function readInput(options) {
  const handoffPath = stringOption(options.handoff);
  const repoPolicyPath = stringOption(options["repo-policy"]);
  return {
    handoffPath,
    repoPolicyPath,
    outPath: stringOption(options.out),
    changedFilesPath: stringOption(options["changed-files"]),
    handoff: handoffPath && existsSync(handoffPath) ? readStructuredFile(handoffPath) : null,
    repoPolicy: repoPolicyPath && existsSync(repoPolicyPath) ? readStructuredFile(repoPolicyPath) : null,
    changedFiles: readChangedFiles(stringOption(options["changed-files"])),
  };
}

function stringOption(value) {
  return typeof value === "string" ? value : null;
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.format !== "json") {
    process.stdout.write(`${JSON.stringify({
      schema: "shirube-review-plan-generate/v1",
      verdict: "FAILURE",
      required_next_actions: [{ code: "unsupported_format", message: "--format json is required." }],
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const input = readInput(options);
    if (!input.handoff) {
      throw new Error(`Missing or unreadable handoff: ${input.handoffPath ?? "<none>"}`);
    }
    const reviewPlan = buildReviewPlan(input);
    if (input.outPath) writeFileSync(input.outPath, `${JSON.stringify(reviewPlan, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      schema: "shirube-review-plan-generate/v1",
      verdict: "PASS",
      out: input.outPath ?? null,
      review_plan: reviewPlan,
    }, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schema: "shirube-review-plan-generate/v1",
      verdict: "FAILURE",
      required_next_actions: [
        {
          code: "review_plan_generation_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) main();
