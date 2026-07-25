#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";
import {
  auditCompletionFrom,
  buildNextActionSequencing,
} from "./next-action-sequencing.mjs";

const SCHEMA = "shirube-audit-checklist-check/v1";
const CHECKLIST_SCHEMA = "shirube-audit-checklist/v1";
const AUDIT_SCHEMA = "shirube-structured-audit/v1";
const RESULTS = ["PASS", "FAIL", "N/A", "UNVERIFIED"];
const CONFIDENCE = ["high", "medium", "low"];

const FINDINGS = {
  "AUDIT-LIST-001": ["missing_audit_checklist", "Audit checklist is missing or unreadable.", "audit_checklist"],
  "AUDIT-LIST-002": ["required_item_missing", "Checklist required item is missing required fields.", "audit_checklist.items"],
  "AUDIT-LIST-003": ["duplicate_item_result", "Structured audit answered an item more than once.", "audit.items"],
  "AUDIT-LIST-004": ["required_item_unanswered", "Required checklist item is missing a valid structured answer.", "audit.items"],
  "AUDIT-LIST-005": ["executable_item_pass_without_machine_evidence", "Executable PASS requires concrete machine evidence.", "audit.items.evidence_refs"],
  "AUDIT-LIST-006": ["fail_without_evidence_or_action", "FAIL requires evidence or a concrete follow-up action.", "audit.items"],
  "AUDIT-LIST-007": ["unverifiable_item_without_escalation", "UNVERIFIED requires explicit escalation.", "audit.items"],
  "AUDIT-LIST-008": ["audit_head_mismatch", "Structured audit head does not match expected head.", "audit.pr_head_sha"],
  "AUDIT-LIST-009": ["maker_checker_violation", "Audit reviewer actor must differ from implementation actor.", "audit.reviewer_actor"],
  "AUDIT-LIST-010": ["scope_only_audit_request_in_full_operational_mode", "Scope-only audit requests cannot satisfy full operational audit acceptance.", "audit.scope"],
};

export function buildAuditChecklistCheck(input) {
  const blockers = [];
  const warnings = [];

  if (!isObject(input.checklist)) {
    blockers.push(finding("AUDIT-LIST-001", { path: input.checklistPath ?? "audit_checklist" }));
    return report({ input, blockers, warnings });
  }

  const checklistItems = asArray(input.checklist.items);
  const auditItems = asArray(input.audit?.items);
  const requiredItems = checklistItems.filter((item) => item?.required !== false);
  const checklistIds = new Set(checklistItems.map((item) => item?.item_id).filter(Boolean));
  const auditCounts = countBy(auditItems.map((item) => item?.item_id).filter(Boolean));
  const machineEvidence = machineEvidenceSet(input.machineEvidence);
  const expectedHead = firstPresent(input.expectedHead, input.checklist?.source?.pr_head_sha, input.checklist?.source?.head_sha);

  if (input.checklist.schema_version !== CHECKLIST_SCHEMA) {
    blockers.push(finding("AUDIT-LIST-001", { message: `Expected ${CHECKLIST_SCHEMA}.`, path: input.checklistPath ?? "audit_checklist.schema_version" }));
  }

  if (!isObject(input.audit) || input.audit.schema_version !== AUDIT_SCHEMA) {
    for (const item of requiredItems) {
      blockers.push(finding("AUDIT-LIST-004", { path: item?.item_id ?? "audit.items", message: `${item?.item_id ?? "required item"} is not answered.` }));
    }
    return report({ input, blockers, warnings });
  }

  for (const item of requiredItems) {
    if (!validChecklistItem(item)) {
      blockers.push(finding("AUDIT-LIST-002", { path: item?.item_id ?? "audit_checklist.items" }));
    }
  }

  for (const [itemId, count] of auditCounts.entries()) {
    if (count > 1) blockers.push(finding("AUDIT-LIST-003", { path: itemId, message: `${itemId} has ${count} results.` }));
  }

  for (const item of auditItems) {
    if (item?.item_id && !checklistIds.has(item.item_id)) {
      warnings.push({
        item_id: "AUDIT-LIST-W001",
        code: "extra_item_result",
        message: `${item.item_id} is not in the checklist.`,
        path: item.item_id,
      });
    }
  }

  for (const required of requiredItems) {
    const answers = auditItems.filter((item) => item?.item_id === required.item_id);
    if (answers.length === 0) {
      blockers.push(finding("AUDIT-LIST-004", { path: required.item_id, message: `${required.item_id} is not answered.` }));
      continue;
    }
    if (answers.length > 1) continue;
    const answer = answers[0];
    const result = String(answer.result ?? "");
    const evidenceRefs = asStringArray(answer.evidence_refs);
    const hasRationale = nonEmptyString(answer.notes) || nonEmptyString(answer.rationale) || nonEmptyString(answer.reason);

    if (!RESULTS.includes(result) || !CONFIDENCE.includes(String(answer.confidence ?? ""))) {
      blockers.push(finding("AUDIT-LIST-004", { path: required.item_id, message: `${required.item_id} is missing valid result/confidence.` }));
      continue;
    }

    if (required.verification_method === "semantic" && evidenceRefs.length === 0 && !hasRationale) {
      blockers.push(finding("AUDIT-LIST-004", { path: required.item_id, message: `${required.item_id} requires evidence_refs or explicit rationale.` }));
    }

    if (required.verification_method === "executable" && result === "PASS" && !hasMachineEvidence({ evidenceRefs, expectedEvidence: asStringArray(required.expected_evidence), machineEvidence })) {
      blockers.push(finding("AUDIT-LIST-005", { path: required.item_id }));
    }

    if (result === "FAIL" && evidenceRefs.length === 0 && !hasAction(answer)) {
      blockers.push(finding("AUDIT-LIST-006", { path: required.item_id }));
    }

    if (result === "UNVERIFIED" && !hasEscalation(answer)) {
      blockers.push(finding("AUDIT-LIST-007", { path: required.item_id }));
    }
  }

  const auditHeadValue = auditHead(input.audit);
  if (!isPlaceholder(expectedHead) && isPlaceholder(auditHeadValue)) {
    blockers.push(finding("AUDIT-LIST-008", {
      message: `Audit head is missing; expected ${expectedHead}.`,
    }));
  } else if (!isPlaceholder(expectedHead) && !isPlaceholder(auditHeadValue) && String(expectedHead) !== String(auditHeadValue)) {
    blockers.push(finding("AUDIT-LIST-008", {
      message: `Audit head ${auditHeadValue} does not match expected head ${expectedHead}.`,
    }));
  }

  const implementationActor = firstPresent(input.implementationActor, input.checklist?.source?.implementation_actor, input.audit.implementation_actor);
  const reviewerActor = firstPresent(input.audit.reviewer_actor, input.audit.auditor_actor);
  if (!isPlaceholder(implementationActor) && !isPlaceholder(reviewerActor) && String(implementationActor) === String(reviewerActor)) {
    blockers.push(finding("AUDIT-LIST-009", { message: `Reviewer actor ${reviewerActor} matches implementation actor.` }));
  }

  if (input.operationalMode === "full_operational" && scopeOnly(input.audit, input.checklist)) {
    blockers.push(finding("AUDIT-LIST-010"));
  }

  return report({ input, blockers: uniqueFindings(blockers), warnings: uniqueFindings(warnings) });
}

function validChecklistItem(item) {
  return isObject(item) &&
    nonEmptyString(item.item_id) &&
    nonEmptyString(item.source) &&
    ["executable", "semantic"].includes(String(item.verification_method)) &&
    item.required === true &&
    nonEmptyString(item.prompt) &&
    asStringArray(item.expected_evidence).length > 0;
}

function hasMachineEvidence({ evidenceRefs, expectedEvidence, machineEvidence }) {
  const refs = new Set([...evidenceRefs, ...expectedEvidence].map(normalizeEvidence));
  for (const ref of refs) {
    if (machineEvidence.has(ref)) return true;
  }
  return false;
}

function machineEvidenceSet(value) {
  const refs = [];
  collectEvidenceRefs(value, refs);
  return new Set(refs.map(normalizeEvidence).filter(Boolean));
}

function collectEvidenceRefs(value, refs, key = "") {
  if (Array.isArray(value)) {
    for (const entry of value) collectEvidenceRefs(entry, refs, key);
    return;
  }
  if (!isObject(value)) {
    if (typeof value === "string" && evidenceLikeKey(key)) refs.push(value);
    return;
  }
  for (const [entryKey, entry] of Object.entries(value)) {
    if (typeof entry === "string" && evidenceLikeKey(entryKey)) refs.push(entry);
    if (Array.isArray(entry) && evidenceLikeKey(entryKey)) refs.push(...entry.filter((item) => typeof item === "string"));
    collectEvidenceRefs(entry, refs, entryKey);
  }
  if (nonEmptyString(value.command) && nonEmptyString(value.result) && String(value.result).toUpperCase() === "PASS") {
    refs.push(`command_result:${value.command}`);
    refs.push(value.command);
  }
}

function evidenceLikeKey(key) {
  return /(evidence|ref|refs|path|report|result|command)/i.test(key);
}

function hasAction(answer) {
  return nonEmptyString(answer.action) ||
    nonEmptyString(answer.required_next_action) ||
    nonEmptyString(answer.remediation) ||
    asArray(answer.required_next_actions).length > 0;
}

function hasEscalation(answer) {
  return answer.escalation_required === true ||
    nonEmptyString(answer.escalation_ref) ||
    nonEmptyString(answer.escalation_owner) ||
    /escalat/i.test(String(answer.notes ?? ""));
}

function scopeOnly(audit, checklist) {
  return audit.scope_only === true ||
    checklist.scope_only === true ||
    /scope[-_ ]?only/i.test(String(audit.audit_scope ?? audit.mode ?? checklist.audit_scope ?? ""));
}

function report({ input, blockers, warnings }) {
  const verdict = blockers.length > 0 ? "BLOCKED" : warnings.length > 0 ? "PASS_WITH_WARN" : "PASS";
  const baseReport = {
    schema: SCHEMA,
    generated_by: "scripts/shirube/check-audit-checklist.mjs",
    trusted_checker: true,
    verdict,
    would_block: verdict === "BLOCKED",
    owner_must_not_merge: verdict === "BLOCKED",
    audit_checklist_ref: input.checklistPath ?? null,
    structured_audit_ref: input.auditPath ?? null,
    pr_head_sha: auditHead(input.audit) ?? null,
    target_repo: auditTargetRepo(input.audit) ?? null,
    target_pr: auditTargetPr(input.audit) ?? null,
    inventory: {
      checklist_items: asArray(input.checklist?.items).length,
      audit_items: asArray(input.audit?.items).length,
      machine_evidence_refs: machineEvidenceSet(input.machineEvidence).size,
      operational_mode: input.operationalMode,
    },
    blockers,
    warnings,
    required_next_actions: requiredNextActions(blockers, warnings),
  };
  const auditCompletion = auditCompletionFrom({
    auditChecklistReport: baseReport,
    structuredAudit: input.audit,
    structuredAuditPath: input.auditPath,
    auditSource: input.auditSource,
    auditSourceTrusted: input.auditSourceTrusted,
    actualHead: input.expectedHead,
    actualRepo: input.expectedRepo,
    actualPr: input.expectedPr,
  });
  const sequencing = buildNextActionSequencing({
    auditRequired: true,
    operationCode: "INDEPENDENT_AUDIT",
    auditChecklistReport: { ...baseReport, audit_completion: auditCompletion },
    structuredAudit: input.audit,
    structuredAuditPath: input.auditPath,
    auditSource: input.auditSource,
    auditSourceTrusted: input.auditSourceTrusted,
    actualHead: input.expectedHead,
    actualRepo: input.expectedRepo,
    actualPr: input.expectedPr,
    blockingFindings: blockers,
  });
  return {
    ...baseReport,
    current_phase: sequencing.current_phase,
    next_action: sequencing.next_action,
    operation_code: sequencing.operation_code,
    approval_class: sequencing.approval_class,
    protected_surface_refs: sequencing.protected_surface_refs,
    authority_result_code: sequencing.result_code,
    owner_approval_allowed: sequencing.owner_approval_allowed,
    merge_ready_allowed: sequencing.merge_ready_allowed,
    forbidden_next_actions: sequencing.forbidden_next_actions,
    audit_required: sequencing.audit_required,
    audit_completion: auditCompletion,
    owner_decision_status: sequencing.owner_decision_status,
  };
}

function failure({ message, path }) {
  return {
    schema: SCHEMA,
    generated_by: "scripts/shirube/check-audit-checklist.mjs",
    trusted_checker: true,
    verdict: "FAILURE",
    would_block: true,
    owner_must_not_merge: true,
    audit_checklist_ref: path ?? null,
    structured_audit_ref: null,
    pr_head_sha: null,
    inventory: {},
    blockers: [
      finding("AUDIT-LIST-001", { message, path: path ?? "audit_checklist" }),
    ],
    warnings: [],
    required_next_actions: [
      { item_id: "AUDIT-LIST-001", action: "Fix malformed audit checklist input and rerun." },
    ],
    current_phase: "AUDIT_REQUIRED",
    next_action: {
      action: "request_independent_audit",
      responsible_role: "auditor",
      allowed_actor_role: "independent_reviewer",
      reason: "Malformed audit checklist input must be fixed before owner approval.",
    },
    owner_approval_allowed: false,
    merge_ready_allowed: false,
    forbidden_next_actions: ["owner_exact_head_approval", "mark_merge_ready", "merge"],
    audit_required: true,
    audit_completion: {
      exists: false,
      machine_readable: false,
      independent: false,
      exact_head_matches: false,
      target_repo_matches: false,
      target_pr_matches: false,
      verdict_accepted: false,
      required_items_answered: false,
      complete: false,
    },
    owner_decision_status: {
      present: false,
      pending: false,
      final_approval_present: false,
      exact_head_sha: null,
      head_mismatch: false,
    },
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

function requiredNextActions(blockers, warnings) {
  return [...blockers, ...warnings].map((item) => ({
    item_id: item.item_id,
    action: actionFor(item.item_id),
  }));
}

function actionFor(itemId) {
  const actions = {
    "AUDIT-LIST-001": "Provide a machine-readable shirube-audit-checklist/v1 artifact.",
    "AUDIT-LIST-002": "Regenerate the checklist so every required item has source, method, prompt, and expected evidence.",
    "AUDIT-LIST-003": "Remove duplicate structured audit item results.",
    "AUDIT-LIST-004": "Answer every required checklist item exactly once with result and confidence.",
    "AUDIT-LIST-005": "Attach machine evidence for executable PASS items or change the result.",
    "AUDIT-LIST-006": "Attach evidence or a concrete follow-up action for each FAIL item.",
    "AUDIT-LIST-007": "Add explicit owner/human escalation for UNVERIFIED items.",
    "AUDIT-LIST-008": "Refresh the audit response for the current exact head.",
    "AUDIT-LIST-009": "Use a reviewer actor distinct from the implementation actor.",
    "AUDIT-LIST-010": "Use a full checklist-based operational audit request.",
    "AUDIT-LIST-W001": "Remove extra non-checklist item answers or regenerate the checklist.",
  };
  return actions[itemId] ?? "Resolve audit checklist finding.";
}

function readInput(options) {
  const checklistPath = stringOption(options.checklist);
  const auditPath = stringOption(options.audit) ?? stringOption(options["structured-audit"]);
  const machineEvidencePath = stringOption(options["machine-evidence"]);
  const auditSourcePath = stringOption(options["audit-source"]) ?? stringOption(options["structured-audit-source"]);
  const auditSourceTrusted = options["trusted-audit-source"] === true;
  const operationalMode = stringOption(options["operational-mode"]) ?? "full_operational";
  const expectedHead = stringOption(options["expected-head"]);
  const expectedRepo = stringOption(options["expected-repo"]);
  const expectedPr = stringOption(options["expected-pr"]);
  const implementationActor = stringOption(options["implementation-actor"]);

  if (!checklistPath || !existsSync(checklistPath)) {
    return {
      input: {
        checklistPath,
        auditPath,
        operationalMode,
        expectedHead,
        expectedRepo,
        expectedPr,
        implementationActor,
      },
      missingChecklist: true,
    };
  }

  try {
    return {
      input: {
        checklistPath,
        auditPath,
        machineEvidencePath,
        operationalMode,
        expectedHead,
        expectedRepo,
        expectedPr,
        implementationActor,
        auditSourceTrusted,
        checklist: readStructuredFile(checklistPath),
        audit: auditPath && existsSync(auditPath) ? readStructuredFile(auditPath) : null,
        machineEvidence: machineEvidencePath && existsSync(machineEvidencePath) ? readStructuredFile(machineEvidencePath) : null,
        auditSource: auditSourcePath && existsSync(auditSourcePath) ? readStructuredFile(auditSourcePath) : null,
      },
    };
  } catch (error) {
    return {
      error: failure({
        message: error instanceof Error ? error.message : String(error),
        path: checklistPath,
      }),
    };
  }
}

function readChangedFiles(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function asStringArray(value) {
  return asArray(value).map((entry) => String(entry).trim()).filter(Boolean);
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function firstPresent(...values) {
  return values.find((value) => !isPlaceholder(value));
}

function auditHead(audit) {
  return firstPresent(audit?.exact_head_sha, audit?.pr_head_sha, audit?.head_sha, audit?.target_head, audit?.target?.head_sha);
}

function auditTargetRepo(audit) {
  return firstPresent(audit?.target_repo, audit?.repo, audit?.target?.repo);
}

function auditTargetPr(audit) {
  return firstPresent(audit?.target_pr, audit?.pr, audit?.pull_request, audit?.target?.pr);
}

function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return text.length === 0 || /^<.*>$/.test(text) || /^(pending|todo|tbd|null|none)$/i.test(text);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 && !isPlaceholder(value);
}

function normalizeEvidence(value) {
  return String(value ?? "").trim().toLowerCase();
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const { input, error, missingChecklist } = readInput(options);
  const format = stringOption(options.format) ?? "json";
  void readChangedFiles;
  if (error) {
    process.stdout.write(`${JSON.stringify(error, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const result = missingChecklist
    ? buildAuditChecklistCheck({ ...input, checklist: null, audit: null, machineEvidence: null })
    : buildAuditChecklistCheck(input);
  if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.verdict === "FAILURE") process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main();
}
