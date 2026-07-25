#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";

const SCHEMA = "shirube-execution-context-check/v1";
const DEFAULT_CONTEXT = ".shirube/execution-context.yaml";
const BLOCKED_NEXT_PHASES = ["ADOPTION_INTAKE", "PREMISE_REQUIRED", "HANDOFF_REQUIRED", "EXECUTION_READY", "IMPLEMENTED", "MERGED", "RELEASED"];
const ACTIVE_ROLES = ["lead", "dev"];

const FINDINGS = {
  "CTX-001": ["missing_execution_context", "Execution context lock is missing.", "context"],
  "CTX-002": ["actual_repo_mismatch", "Actual repository must match the execution context primary repository.", "actual_repo"],
  "CTX-003": ["primary_repo_missing", "Execution context primary.repo is required.", "primary.repo"],
  "CTX-004": ["work_order_repo_mismatch", "primary.work_order must belong to the primary repository.", "primary.work_order"],
  "CTX-005": ["support_repo_used_as_implementation_target", "A support repo must not be used as the implementation target.", "repo_relations"],
  "CTX-006": ["control_repo_used_as_implementation_target", "A control source repo must not be used as the implementation target.", "repo_relations"],
  "CTX-007": ["framework_repo_used_as_product_repo", "A framework support repo must not be declared as the product primary repo.", "repo_relations"],
  "CTX-008": ["current_pr_repo_mismatch", "primary.pr must belong to the primary repository.", "primary.pr"],
  "CTX-009": ["implementation_claim_outside_primary_repo", "Implementation claims are only valid in the primary repository context.", "actual_repo"],
  "CTX-010": ["merge_ready_claim_without_owner_exact_head", "Merge-ready claims require structured owner exact-head evidence.", "owner_decision"],
  "CTX-011": ["support_repo_permission_exceeded", "Support/control/framework repo permissions were exceeded.", "repo_relations.allowed"],
  "CTX-012": ["session_identity_uncertain", "Actual repo, branch, and head SHA are required for execution context checking.", "actual"],
  "CTX-013": ["missing_active_role", "active_role is required.", "active_role"],
  "CTX-014": ["unknown_active_role", "active_role must be lead or dev.", "active_role"],
  "CTX-015": ["lead_attempts_product_implementation", "lead role must not implement product changes.", "active_role"],
  "CTX-016": ["dev_claims_audit_or_owner_authority", "dev role must not claim audit, owner, merge, release, or protected authority.", "active_role"],
};

export function buildExecutionContextReport(input) {
  const blockers = [];
  const evidence = [];
  const context = isObject(input.context) ? input.context : null;
  const contextPath = input.contextPath ?? "";
  const prBody = input.prBody ?? "";
  const changedFiles = input.changedFiles ?? [];
  const actualRepo = normalizeRepo(input.actualRepo);
  const actualBranch = stringValue(input.actualBranch);
  const actualHead = stringValue(input.actualHead);

  if (contextPath) evidence.push({ code: "execution_context", source: "file", detail: contextPath });
  if (input.prBodyPath) evidence.push({ code: "pr_body", source: "file", detail: input.prBodyPath });
  if (input.changedFilesPath) evidence.push({ code: "changed_files", source: "file", detail: input.changedFilesPath });
  if (input.actualRepo) evidence.push({ code: "actual_repo", source: "input", detail: input.actualRepo });
  if (input.actualBranch) evidence.push({ code: "actual_branch", source: "input", detail: input.actualBranch });
  if (input.actualHead) evidence.push({ code: "actual_head", source: "input", detail: input.actualHead });

  if (!context) {
    blockers.push(finding("CTX-001", { path: contextPath || DEFAULT_CONTEXT }));
    return report({ context, contextPath, actualRepo: input.actualRepo ?? null, activeRole: null, blockers, evidence });
  }

  const primary = isObject(context.primary) ? context.primary : {};
  const activeRole = stringValue(context.active_role);
  const primaryRepo = normalizeRepo(primary.repo);
  const workOrderRepo = repoFromRef(primary.work_order);
  const currentPrRepo = repoFromRef(primary.pr);
  const relations = asRelationRecords(context.repo_relations);
  const actualRelation = actualRepo ? relations.find((relation) => relation.repo === actualRepo) : null;
  const primaryRelation = primaryRepo ? relations.find((relation) => relation.repo === primaryRepo && !isPrimaryRelation(relation.relation)) : null;
  const implementationClaim = hasImplementationClaim({ context, prBody, changedFiles });
  const mergeReadyClaim = hasMergeReadyClaim({ context, prBody });
  const authorityClaim = hasAuditOrOwnerAuthorityClaim({ context, prBody });

  if (!actualRepo || !actualBranch || !actualHead) blockers.push(finding("CTX-012"));
  if (!primaryRepo) blockers.push(finding("CTX-003"));
  if (!activeRole) {
    blockers.push(finding("CTX-013"));
  } else if (!ACTIVE_ROLES.includes(activeRole)) {
    blockers.push(finding("CTX-014"));
  }

  if (actualRepo && primaryRepo && actualRepo !== primaryRepo) {
    blockers.push(finding("CTX-002", { message: `${input.actualRepo} does not match primary repo ${primary.repo}.` }));
  }
  if (workOrderRepo && primaryRepo && workOrderRepo !== primaryRepo) {
    blockers.push(finding("CTX-004", { message: `${primary.work_order} does not belong to ${primary.repo}.` }));
  }
  if (currentPrRepo && primaryRepo && currentPrRepo !== primaryRepo) {
    blockers.push(finding("CTX-008", { message: `${primary.pr} does not belong to ${primary.repo}.` }));
  }

  if (primaryRelation?.relation === "support") blockers.push(finding("CTX-005", { path: `repo_relations.${primary.repo}` }));
  if (primaryRelation?.relation === "control_source") blockers.push(finding("CTX-006", { path: `repo_relations.${primary.repo}` }));
  if (primaryRelation?.relation === "framework_support") blockers.push(finding("CTX-007", { path: `repo_relations.${primary.repo}` }));

  if (implementationClaim && actualRepo && primaryRepo && actualRepo !== primaryRepo) {
    blockers.push(finding("CTX-009"));
  }
  if (mergeReadyClaim && !hasOwnerExactHeadDecision({ context, prBody, actualHead })) {
    blockers.push(finding("CTX-010"));
  }
  if (actualRelation && !isPrimaryRelation(actualRelation.relation) && supportPermissionExceeded({ relation: actualRelation, implementationClaim, mergeReadyClaim, authorityClaim })) {
    blockers.push(finding("CTX-011", { path: `repo_relations.${input.actualRepo}` }));
  }
  if (activeRole === "lead" && implementationClaim) blockers.push(finding("CTX-015"));
  if (activeRole === "dev" && authorityClaim) blockers.push(finding("CTX-016"));

  return report({
    context,
    contextPath,
    actualRepo: input.actualRepo ?? null,
    activeRole,
    blockers: uniqueFindings(blockers),
    evidence,
  });
}

function report({ context, contextPath, actualRepo, activeRole, blockers, evidence }) {
  const verdict = blockers.length > 0 ? "BLOCKED" : "PASS";
  const primaryRepo = stringValue(context?.primary?.repo) ?? null;
  return {
    schema: SCHEMA,
    verdict,
    would_block: verdict === "BLOCKED",
    owner_must_not_merge: verdict === "BLOCKED",
    current_phase: verdict === "PASS" ? "CONTEXT_READY" : "CONTEXT_BLOCKED",
    allowed_next_phases: verdict === "PASS" ? ["ADOPTION_INTAKE", "EXISTING_STATE_SCAN", "PREMISE_REQUIRED", "HANDOFF_REQUIRED", "EXECUTION_READY"] : [],
    forbidden_next_phases: verdict === "BLOCKED" ? BLOCKED_NEXT_PHASES : [],
    context_ref: contextPath || null,
    primary_repo: primaryRepo,
    actual_repo: actualRepo,
    active_role: activeRole,
    repo_relations: asRelationRecords(context?.repo_relations).map((relation) => ({
      repo: relation.originalRepo,
      relation: relation.relation,
    })),
    blockers,
    warnings: [],
    evidence: uniqueEvidence(evidence),
    required_next_actions: requiredNextActions(blockers),
  };
}

function failureReport({ code, message, contextPath = "" }) {
  return {
    schema: SCHEMA,
    verdict: "FAILURE",
    report_failed: true,
    would_block: true,
    owner_must_not_merge: true,
    current_phase: "CONTEXT_BLOCKED",
    allowed_next_phases: [],
    forbidden_next_phases: BLOCKED_NEXT_PHASES,
    context_ref: contextPath || null,
    primary_repo: null,
    actual_repo: null,
    active_role: null,
    repo_relations: [],
    blockers: [
      {
        item_id: "CTX-FAILURE",
        code,
        message,
        path: contextPath || "context",
      },
    ],
    warnings: [],
    evidence: [],
    required_next_actions: [
      {
        item_id: "CTX-FAILURE",
        action: message,
      },
    ],
  };
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

function requiredNextActions(blockers) {
  return blockers.map((blocker) => ({
    item_id: blocker.item_id,
    action: actionFor(blocker.item_id),
  }));
}

function actionFor(itemId) {
  const actions = {
    "CTX-001": "Add a shirube-execution-context/v1 artifact and reference it before trusting later gates.",
    "CTX-002": "Reset the session to the primary repository or update the context lock before continuing.",
    "CTX-003": "Record primary.repo in the execution context.",
    "CTX-004": "Use a work order in the primary repo or create an explicit control-source mirror outside primary.work_order.",
    "CTX-005": "Do not treat a support repo as the implementation target.",
    "CTX-006": "Do not treat a control source repo as the implementation target.",
    "CTX-007": "Do not treat the framework support repo as the product primary repo.",
    "CTX-008": "Set primary.pr to a PR in the primary repository.",
    "CTX-009": "Move implementation work back to the primary repo before claiming implementation evidence.",
    "CTX-010": "Record owner exact-head decision evidence before claiming merge readiness.",
    "CTX-011": "Reduce support/control/framework activity to allowed read/cite/feedback operations.",
    "CTX-012": "Provide --actual-repo, --actual-branch, and --actual-head, or run in a GitHub PR context.",
    "CTX-013": "Set active_role to lead or dev.",
    "CTX-014": "Use the lightweight active_role vocabulary: lead or dev.",
    "CTX-015": "Switch to dev role or remove product implementation changes from this context.",
    "CTX-016": "Move audit, owner, merge, release, and protected authority decisions to the proper owner/checker actor.",
  };
  return actions[itemId] ?? "Resolve execution context finding.";
}

function readInput(options) {
  const contextPath = typeof options.context === "string"
    ? options.context
    : existsSync(DEFAULT_CONTEXT)
      ? DEFAULT_CONTEXT
      : null;
  const prBodyPath = typeof options["pr-body"] === "string" ? options["pr-body"] : null;
  const changedFilesPath = typeof options["changed-files"] === "string" ? options["changed-files"] : null;
  const actual = actualFromOptions(options);

  if (!contextPath || !existsSync(contextPath)) {
    return {
      input: {
        context: null,
        contextPath: contextPath ?? "",
        prBody: readOptionalText(prBodyPath),
        prBodyPath,
        changedFiles: readChangedFiles(changedFilesPath),
        changedFilesPath,
        ...actual,
      },
    };
  }

  try {
    return {
      input: {
        context: readStructuredFile(contextPath),
        contextPath,
        prBody: readOptionalText(prBodyPath),
        prBodyPath,
        changedFiles: readChangedFiles(changedFilesPath),
        changedFilesPath,
        ...actual,
      },
    };
  } catch (error) {
    return {
      error: failureReport({
        code: "context_parse_error",
        message: error instanceof Error ? error.message : String(error),
        contextPath,
      }),
    };
  }
}

function actualFromOptions(options) {
  const fromEvent = actualFromGithubEvent();
  return {
    actualRepo: stringValue(options["actual-repo"]) ?? process.env.GITHUB_REPOSITORY ?? fromEvent.actualRepo ?? null,
    actualBranch: stringValue(options["actual-branch"]) ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? fromEvent.actualBranch ?? null,
    actualHead: stringValue(options["actual-head"]) ?? fromEvent.actualHead ?? process.env.GITHUB_SHA ?? null,
  };
}

function actualFromGithubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return {};
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const repo = event.repository?.full_name;
    const branch = event.pull_request?.head?.ref ?? event.ref_name;
    const head = event.pull_request?.head?.sha ?? event.after;
    return { actualRepo: repo, actualBranch: branch, actualHead: head };
  } catch {
    return {};
  }
}

function readOptionalText(filePath) {
  if (!filePath || !existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

function readChangedFiles(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .sort((a, b) => a.localeCompare(b));
}

function asRelationRecords(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((entry) => ({
      repo: normalizeRepo(entry.repo),
      originalRepo: stringValue(entry.repo) ?? null,
      relation: String(entry.relation ?? "").trim(),
      allowed: asStringArray(entry.allowed),
      forbidden: asStringArray(entry.forbidden),
    }))
    .filter((entry) => entry.repo && entry.relation);
}

function hasImplementationClaim({ context, prBody, changedFiles }) {
  const explicit = [
    context?.current_activity,
    context?.activity,
    context?.claimed_action,
    context?.claim,
    context?.intent,
  ].some((value) => /implement|product_change|runtime_change|code_change/i.test(String(value ?? "")));
  if (explicit) return true;

  const claims = [
    ...asStringArray(context?.claims),
    ...asStringArray(context?.requested_actions),
    ...asStringArray(context?.planned_actions),
  ].join("\n");
  if (/implement|product_change|runtime_change|code_change/i.test(claims)) return true;

  if (/^\s*(Implementation|Implemented|Runtime change|Product change)\s*:/im.test(prBody)) return true;
  return changedFiles.some(isProductImplementationPath);
}

function hasMergeReadyClaim({ context, prBody }) {
  const claims = [
    ...asStringArray(context?.claims),
    ...asStringArray(context?.requested_actions),
    ...asStringArray(context?.planned_actions),
  ].join("\n");
  return /merge[- ]ready|ready to merge|owner merge path|merge authorization/i.test(`${claims}\n${prBody}`);
}

function hasAuditOrOwnerAuthorityClaim({ context, prBody }) {
  const claims = [
    ...asStringArray(context?.claims),
    ...asStringArray(context?.requested_actions),
    ...asStringArray(context?.planned_actions),
  ].join("\n");
  const text = `${claims}\n${prBody}`;
  return /(^|\n)\s*(Audit|Gate Review|Owner final decision|Decision)\s*:\s*(PASS|APPROVED|APPROVED_EXACT_HEAD)/i.test(text) ||
    /claim_audit_pass|approve_merge|owner_authority|release_authority|protected_authority/i.test(text) ||
    /<!--\s*shirube:owner-final-decision\/v1\s*-->/i.test(text);
}

function hasOwnerExactHeadDecision({ context, prBody, actualHead }) {
  const ownerDecision = isObject(context.owner_decision) ? context.owner_decision : {};
  if (decisionIsApproved(ownerDecision.verdict ?? ownerDecision.decision) && headMatches(ownerDecision.exact_head_sha ?? ownerDecision.head_sha ?? ownerDecision.target_head, actualHead)) {
    return true;
  }

  if (!/<!--\s*shirube:owner-final-decision\/v1\s*-->/i.test(prBody)) return false;
  if (!/(Decision|verdict)\s*:\s*APPROVED_EXACT_HEAD/i.test(prBody)) return false;
  const exactHead = prBody.match(/Exact head\s*:\s*([a-f0-9]{7,40})/i)?.[1] ??
    prBody.match(/exact_head_sha\s*:\s*([a-f0-9]{7,40})/i)?.[1];
  return headMatches(exactHead, actualHead);
}

function supportPermissionExceeded({ relation, implementationClaim, mergeReadyClaim, authorityClaim }) {
  if (implementationClaim && (relation.forbidden.includes("implementation_target") || !isPrimaryRelation(relation.relation))) return true;
  if (mergeReadyClaim && (relation.forbidden.includes("merge_ready_claim") || !isPrimaryRelation(relation.relation))) return true;
  if (authorityClaim && (relation.forbidden.includes("merge_decision") || relation.forbidden.includes("approve_merge") || !isPrimaryRelation(relation.relation))) return true;
  return false;
}

function isPrimaryRelation(value) {
  return value === "primary" || value === "primary_with_control_issue" || value === "same_repo_control_source";
}

function isProductImplementationPath(filePath) {
  return /^(src|lib|bin|cli|core|server\.ts|server\.js|app|api|db|migrations|prisma|deploy)\b/.test(filePath) ||
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|php|cs)$/.test(filePath) && !/^test\//.test(filePath) && !/^scripts\/shirube\//.test(filePath);
}

function repoFromRef(value) {
  const text = stringValue(value);
  if (!text) return null;
  const githubUrl = text.match(/github\.com\/([^/\s]+\/[^/#\s]+)/i)?.[1];
  if (githubUrl) return normalizeRepo(githubUrl);
  const shorthand = text.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#\d+/)?.[1];
  if (shorthand) return normalizeRepo(shorthand);
  const repoOnly = text.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/)?.[1];
  return repoOnly ? normalizeRepo(repoOnly) : null;
}

function normalizeRepo(value) {
  const text = stringValue(value);
  return text ? text.toLowerCase() : null;
}

function decisionIsApproved(value) {
  return String(value ?? "").toUpperCase() === "APPROVED_EXACT_HEAD";
}

function headMatches(value, actualHead) {
  const head = stringValue(value);
  if (!head) return false;
  if (!actualHead) return true;
  return head === actualHead;
}

function stringValue(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value === "string") return [value];
  return [];
}

function uniqueFindings(findings) {
  const seen = new Set();
  const result = [];
  for (const item of findings) {
    const key = `${item.item_id}:${item.path}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function uniqueEvidence(evidence) {
  const seen = new Set();
  const result = [];
  for (const item of evidence) {
    const key = `${item.code}:${item.source}:${item.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.format !== "json") {
    process.stdout.write(`${JSON.stringify(failureReport({
      code: "unsupported_format",
      message: "--format json is required.",
    }), null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const { input, error } = readInput(options);
  const report = error ?? buildExecutionContextReport(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.verdict === "FAILURE" ? 1 : 0;
}

if (isMain(import.meta.url)) {
  main();
}
