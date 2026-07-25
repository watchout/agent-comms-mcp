#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";
import {
  buildNextActionSequencing,
} from "./next-action-sequencing.mjs";
import {
  normalizeControlHandoff,
} from "./normalize-control-handoff.mjs";

const SCHEMA = "shirube-control-state-completeness/v1";
const CONTROL_STATES = ["CONTROL_COMPLETE", "CONTROL_COMPLETE_WITH_WARNINGS", "CONTROL_PARTIAL", "CONTROL_BLOCKED", "CONTROL_FAILURE"];
const BLOCKING_PHASES = ["EXECUTION_READY", "IMPLEMENTED", "PR_READY", "GATE_REVIEW_REQUIRED", "OWNER_DECISION_REQUIRED", "MERGE_READY", "MERGED", "POST_MERGE_REQUIRED", "COMPLETE"];
const FULL_CONTROL_READY_STATES = ["FULL_CONTROL_READY", "CONTROL_COMPLETE", "RAPID_LITE_REPORT_ONLY_READY"];

const FINDINGS = {
  "CSC-001": ["missing_execution_context", "Execution context report is missing, blocked, or failed.", "execution_context_report"],
  "CSC-002": ["missing_rps_or_prs", "RPS / PRS artifact is required.", "repo_spec"],
  "CSC-003": ["source_mirror_missing_for_declared_control_source", "Declared control source requires a source mirror artifact.", "source_mirror"],
  "CSC-004": ["handoff_missing_or_cell_id_mismatch", "Control handoff is missing or CELL-ID references do not match.", "handoff"],
  "CSC-005": ["allowed_forbidden_paths_missing", "allowed_paths and forbidden_paths are required and changed files must fit allowed scope.", "handoff.cell.paths"],
  "CSC-006": ["protected_surface_not_in_taxonomy", "Protected surfaces must exist in the matrix or allowed taxonomy.", "protected_surfaces"],
  "CSC-007": ["required_evidence_missing_ref", "Required evidence entries must have concrete evidence refs.", "validation.required_evidence"],
  "CSC-008": ["owner_head_mismatch", "Owner decision exact head must match PR/gate head.", "owner_decision.exact_head_sha"],
  "CSC-009": ["adoption_lifecycle_mismatch", "Adoption disposition/current phase is not compatible with lifecycle phase.", "adoption_lifecycle"],
  "CSC-010": ["gate_contract_blocked_but_lifecycle_allows_progress", "Gate-contract BLOCKED/FAILURE prevents lifecycle progress.", "gate_contract_report"],
  "CSC-011": ["design_rule_blocked_but_owner_ready_claimed", "Design-rule BLOCKED/FAILURE prevents owner/final decision progress claims.", "design_rule_report"],
  "CSC-012": ["audit_required_but_missing", "Formal audit/reviewer audit is required but missing.", "audit_record"],
  "CSC-013": ["audit_item_set_incomplete_or_duplicate", "Audit record must answer required item-set items exactly once.", "audit_record.items"],
  "CSC-014": ["post_merge_required_but_missing", "Post-merge evidence is required before COMPLETE.", "post_merge"],
  "CSC-015": ["full_control_claim_without_full_readiness", "Full-control claims require FULL_CONTROL_READY readiness.", "readiness"],
  "CSC-016": ["stale_artifact_reference", "Artifact reference is stale, missing, placeholder, or points outside current evidence.", "artifact_ref"],
  "CSC-017": ["report_failure_ignored", "Report FAILURE or report_failed=true must not be ignored.", "reports"],
  "CSC-018": ["required_additional_review_missing", "Required additional review is missing or incomplete.", "review_plan_report"],
};

const DEFAULT_TAXONOMY = [
  "none",
  "repo_spec_confirmation_evidence",
  "runtime code",
  "runtime",
  "api",
  "database",
  "db",
  "migrations",
  "secrets",
  "active workflows",
  "workflows",
  "required checks",
  "branch protection",
  "rulesets",
  "aun activation",
  "production",
  "deploy",
  "auth",
  "permissions",
];

export function buildControlStateCompletenessReport(input) {
  const blockers = [];
  const warnings = [];
  const missingStates = [];
  const staleStates = [];
  const mismatches = [];
  const inventory = buildInventory(input);

  const reports = [
    ["execution_context_report", input.executionContextReport],
    ["adoption_report", input.adoptionReport],
    ["lifecycle_report", input.lifecycleReport],
    ["gate_contract_report", input.gateContractReport],
    ["design_rule_report", input.designRuleReport],
    ["audit_checklist_report", input.auditChecklistReport],
    ["enforcement_policy_report", input.enforcementPolicyReport],
    ["readiness_report", input.readinessReport],
  ];

  if (!isPassingReport(input.executionContextReport)) {
    missingStates.push(missingState("execution_context", input.executionContextReportPath));
    blockers.push(finding("CSC-001", { path: input.executionContextReportPath ?? "execution_context_report" }));
  }

  if (!isObject(input.repoSpec)) {
    missingStates.push(missingState("rps_or_prs", input.repoSpecPath));
    blockers.push(finding("CSC-002", { path: input.repoSpecPath ?? "repo_spec" }));
  } else {
    const repoMismatch = contextRepoMismatch(input);
    if (repoMismatch) {
      mismatches.push(repoMismatch);
      blockers.push(finding("CSC-002", { path: "repo_spec.repo", message: repoMismatch.message }));
    }
  }

  for (const [name, path, value] of [
    ["adoption_report", input.adoptionReportPath, input.adoptionReport],
    ["lifecycle_report", input.lifecycleReportPath, input.lifecycleReport],
    ["gate_contract_report", input.gateContractReportPath, input.gateContractReport],
    ["design_rule_report", input.designRuleReportPath, input.designRuleReport],
    ["enforcement_policy_report", input.enforcementPolicyReportPath, input.enforcementPolicyReport],
  ]) {
    if (!isObject(value)) missingStates.push(missingState(name, path));
  }

  if (declaresControlSource({ repoSpec: input.repoSpec, handoff: input.handoff, contextReport: input.executionContextReport }) && !isObject(input.sourceMirror)) {
    missingStates.push(missingState("source_mirror", input.sourceMirrorPath));
    blockers.push(finding("CSC-003", { path: input.sourceMirrorPath ?? "source_mirror" }));
  } else {
    const sourceMismatch = sourceMirrorMismatch(input);
    if (sourceMismatch) {
      mismatches.push(sourceMismatch);
      blockers.push(finding("CSC-003", { path: "source_mirror", message: sourceMismatch.message }));
    }
  }

  if (!isObject(input.handoff) || isPlaceholder(handoffCellId(input.handoff))) {
    missingStates.push(missingState("handoff", input.handoffPath));
    blockers.push(finding("CSC-004", { path: input.handoffPath ?? "handoff" }));
  } else {
    const cellMismatch = cellIdMismatch(input);
    if (cellMismatch) {
      mismatches.push(cellMismatch);
      blockers.push(finding("CSC-004", { message: cellMismatch.message }));
    }
    const controlRefMismatch = controlReferenceMismatch(input);
    if (controlRefMismatch) {
      mismatches.push(controlRefMismatch);
      blockers.push(finding("CSC-004", { message: controlRefMismatch.message }));
    }
  }

  const pathFinding = pathScopeFinding(input);
  if (pathFinding) {
    blockers.push(finding("CSC-005", pathFinding));
  }

  const protectedSurfaceFinding = protectedSurfaceTaxonomyFinding(input);
  if (protectedSurfaceFinding) {
    blockers.push(finding("CSC-006", protectedSurfaceFinding));
  }

  const missingEvidenceRefs = requiredEvidenceMissingRefs(input);
  for (const entry of missingEvidenceRefs) {
    blockers.push(finding("CSC-007", { path: entry.path, message: entry.message }));
  }

  const headMismatch = ownerHeadMismatch(input);
  if (headMismatch) {
    mismatches.push(headMismatch);
    blockers.push(finding("CSC-008", { message: headMismatch.message }));
  }

  const adoptionMismatch = adoptionLifecycleMismatch(input);
  if (adoptionMismatch) {
    mismatches.push(adoptionMismatch);
    blockers.push(finding("CSC-009", { message: adoptionMismatch.message }));
  }

  if (isBlockingReport(input.gateContractReport) && lifecycleAllowsProgress(input.lifecycleReport)) {
    blockers.push(finding("CSC-010"));
  }

  if (isBlockingReport(input.designRuleReport) && ownerReadyClaimed(input)) {
    blockers.push(finding("CSC-011"));
  }

  if (isBlockingReport(input.reviewPlanReport)) {
    blockers.push(...reviewPlanReportBlockers(input.reviewPlanReport));
  }

  const auditRequired = auditIsRequired(input);
  if (auditRequired && !isObject(input.auditChecklistReport)) {
    missingStates.push(missingState("audit_checklist_report", input.auditChecklistReportPath));
    blockers.push(finding("CSC-012", {
      path: input.auditChecklistReportPath ?? "audit_checklist_report",
      message: "Formal audit/reviewer audit is required but no audit checklist check report is present.",
    }));
  }
  if (auditRequired && !isObject(input.auditRecord) && !isObject(input.auditChecklistReport)) {
    missingStates.push(missingState("audit_record", input.auditRecordPath));
    blockers.push(finding("CSC-012", { path: input.auditRecordPath ?? "audit_record" }));
  }

  blockers.push(...auditChecklistReportBlockers(input.auditChecklistReport));
  warnings.push(...auditChecklistReportWarnings(input.auditChecklistReport));

  const auditFinding = auditItemSetFinding(input);
  if (auditFinding) {
    blockers.push(finding("CSC-013", auditFinding));
  }

  if (postMergeRequired(input) && !hasPostMergeEvidence(input.postMerge)) {
    missingStates.push(missingState("post_merge", input.postMergePath));
    blockers.push(finding("CSC-014", { path: input.postMergePath ?? "post_merge" }));
  }

  if (claimsFullControl(input) && !readinessIsFullControlReady(input.readinessReport)) {
    blockers.push(finding("CSC-015"));
  }

  for (const stale of staleArtifactRefs(input)) {
    staleStates.push(stale);
    blockers.push(finding("CSC-016", { path: stale.path, message: stale.message }));
  }

  for (const [name, report] of reports) {
    if (reportFailureIgnored(report)) {
      blockers.push(finding("CSC-017", { path: name, message: `${name} failed and must block control completeness.` }));
    }
  }

  if (isObject(input.enforcementPolicyReport)) {
    const enforcementMismatch = enforcementMismatchFinding(input);
    if (enforcementMismatch) {
      warnings.push({
        item_id: "CSC-W001",
        code: "enforcement_policy_warns",
        message: enforcementMismatch.message,
        path: "enforcement_policy_report",
      });
    }
  }

  const sequencing = buildNextActionSequencing({
    handoff: input.handoff,
    repoSpec: input.repoSpec,
    auditChecklistReport: input.auditChecklistReport,
    structuredAudit: input.structuredAudit,
    structuredAuditPath: input.structuredAuditPath,
    auditSource: input.auditSource,
    auditSourceTrusted: input.auditSourceTrusted,
    reviewPlan: input.reviewPlanReport?.review_plan,
    additionalReviewReports: input.additionalReviewReports,
    additionalReviewSource: input.additionalReviewSource,
    additionalReviewSourceTrusted: input.additionalReviewSourceTrusted,
    ownerDecision: input.ownerDecision,
    actualHead: expectedHead(input),
    actualRepo: expectedRepo(input),
    actualPr: expectedPr(input),
    currentPhase: input.lifecycleReport?.current_phase,
    blockingFindings: blockers,
    headChange: headChangeInput(input),
    prBodyExactHead: handoffExactHead(input.handoff),
  });
  if (auditRequired && isObject(input.auditChecklistReport) && sequencing.audit_completion?.complete !== true) {
    blockers.push(finding("CSC-012", {
      path: input.auditChecklistReportPath ?? "audit_checklist_report",
      message: "Formal audit/reviewer audit is required but is not independently exact-head verified.",
    }));
  }
  blockers.push(...sequencing.blockers);

  const uniqueBlockers = uniqueFindings(blockers);
  const uniqueWarnings = uniqueFindings(warnings);
  const state = controlState({ blockers: uniqueBlockers, warnings: uniqueWarnings, missingStates });
  return {
    schema: SCHEMA,
    state,
    verdict: verdictForState(state),
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
    audit_completion: sequencing.audit_completion,
    additional_review_completion: sequencing.additional_review_completion,
    owner_decision_status: sequencing.owner_decision_status,
    head_change: sequencing.head_change,
    would_block: state === "CONTROL_BLOCKED" || state === "CONTROL_FAILURE" || state === "CONTROL_PARTIAL",
    owner_must_not_merge: state !== "CONTROL_COMPLETE" && state !== "CONTROL_COMPLETE_WITH_WARNINGS",
    inventory,
    missing_states: uniqueByKey(missingStates, (item) => item.name),
    stale_states: uniqueByKey(staleStates, (item) => `${item.path}:${item.ref}`),
    mismatches: uniqueByKey(mismatches, (item) => `${item.code}:${item.message}`),
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    required_next_actions: requiredNextActions(uniqueBlockers, uniqueWarnings, state),
  };
}

function buildInventory(input) {
  const handoff = input.handoff;
  const context = input.executionContextReport;
  const gate = input.gateContractReport;
  const lifecycle = input.lifecycleReport;
  const enforcement = input.enforcementPolicyReport;
  const changedFiles = input.changedFiles ?? [];
  return {
    execution_context: inventoryRecord(input.executionContextReportPath, context),
    role_context: {
      active_role: context?.active_role ?? null,
      present: Boolean(context?.active_role),
    },
    repo_relations: Array.isArray(context?.repo_relations) ? context.repo_relations : [],
    rps_or_prs: inventoryRecord(input.repoSpecPath, input.repoSpec),
    source_mirrors: inventoryRecord(input.sourceMirrorPath, input.sourceMirror),
    adoption_report: inventoryRecord(input.adoptionReportPath, input.adoptionReport),
    lifecycle_report: inventoryRecord(input.lifecycleReportPath, lifecycle),
    gate_contract_report: inventoryRecord(input.gateContractReportPath, gate),
    design_rule_report: inventoryRecord(input.designRuleReportPath, input.designRuleReport),
    review_plan_report: inventoryRecord(input.reviewPlanReportPath, input.reviewPlanReport),
    audit_checklist_report: inventoryRecord(input.auditChecklistReportPath, input.auditChecklistReport),
    enforcement_policy_report: inventoryRecord(input.enforcementPolicyReportPath, enforcement),
    readiness_report: inventoryRecord(input.readinessReportPath, input.readinessReport),
    handoff: inventoryRecord(input.handoffPath, handoff),
    allowed_paths: asStringArray(handoff?.cell?.allowed_paths),
    forbidden_paths: asStringArray(handoff?.cell?.forbidden_paths),
    protected_surfaces: protectedSurfaces(input),
    required_evidence: asStringArray(handoff?.validation?.required_evidence),
    validation_evidence: inventoryRecord(input.validationPath, input.validation),
    owner_decision: inventoryRecord(input.ownerDecisionPath, input.ownerDecision),
    head_change: headChangeInput(input),
    audit_checklist: inventoryRecord(input.auditChecklistPath, input.auditChecklist),
    audit_record: inventoryRecord(input.auditRecordPath, input.auditRecord),
    additional_reviews: asArray(input.additionalReviewReports).map((report) => ({
      review_type: report?.review_type ?? report?.type ?? null,
      verdict: report?.verdict ?? report?.decision ?? report?.status ?? null,
      exact_head_sha: firstPresent(report?.exact_head_sha, report?.pr_head_sha, report?.head_sha, report?.target_head) ?? null,
    })),
    audit_item_set: inventoryRecord(input.auditItemSetPath, input.auditItemSet),
    post_merge: inventoryRecord(input.postMergePath, input.postMerge),
    open_blockers: openBlockers(input),
    heads: {
      context_actual_head: context?.evidence?.find?.((entry) => entry.code === "actual_head")?.detail ?? null,
      gate_head: reportHead(gate),
      validation_head: firstPresent(input.validation?.pr_head_sha, input.validation?.head_sha, input.validation?.exact_head_sha),
      owner_head: ownerDecisionHead(input.ownerDecision),
    },
    control_refs: {
      work_order: contextWorkOrderRef(input.executionContextReport),
      pr: contextPrRef(input.executionContextReport),
      handoff_work_order: handoffWorkOrderRef(handoff),
      handoff_pr: handoffPrRef(handoff),
    },
    phases: {
      lifecycle: lifecycle?.current_phase ?? null,
      gate_contract: gate?.current_phase ?? null,
      adoption: input.adoptionReport?.current_phase ?? null,
    },
    changed_files: changedFiles,
  };
}

function inventoryRecord(path, value) {
  return {
    present: isObject(value),
    path: path ?? null,
    schema: isObject(value) ? value.schema ?? value.schema_version ?? null : null,
    verdict: isObject(value) ? value.verdict ?? null : null,
    state: isObject(value) ? value.state ?? null : null,
    report_failed: isObject(value) ? value.report_failed === true : false,
  };
}

function controlState({ blockers, warnings, missingStates }) {
  if (blockers.some((item) => item.item_id === "CSC-017")) return "CONTROL_FAILURE";
  if (blockers.length > 0) return "CONTROL_BLOCKED";
  if (missingStates.length > 0) return "CONTROL_PARTIAL";
  if (warnings.length > 0) return "CONTROL_COMPLETE_WITH_WARNINGS";
  return "CONTROL_COMPLETE";
}

function verdictForState(state) {
  if (state === "CONTROL_COMPLETE") return "PASS";
  if (state === "CONTROL_COMPLETE_WITH_WARNINGS" || state === "CONTROL_PARTIAL") return "PASS_WITH_WARN";
  if (state === "CONTROL_FAILURE") return "FAILURE";
  return "BLOCKED";
}

function declaresControlSource({ repoSpec, handoff, contextReport }) {
  return Boolean(
    firstPresent(
      repoSpec?.control_source?.ref,
      repoSpec?.control_source_ref,
      repoSpec?.source_ref,
      repoSpec?.source_refs?.control,
      handoff?.control_source?.ref,
    ) ||
    asArray(contextReport?.repo_relations).some((relation) => relation?.relation === "control_source")
  );
}

function contextRepoMismatch(input) {
  const contextRepo = normalizeRepo(input.executionContextReport?.primary_repo);
  const repoSpecRepo = normalizeRepo(firstPresent(input.repoSpec?.repo, input.repoSpec?.repo_id, input.repoSpec?.id));
  if (!contextRepo || !repoSpecRepo || contextRepo === repoSpecRepo) return null;
  return {
    code: "context_rps_repo_mismatch",
    expected: contextRepo,
    observed: repoSpecRepo,
    message: `Execution context primary repo ${contextRepo} does not match RPS repo ${repoSpecRepo}.`,
  };
}

function sourceMirrorMismatch(input) {
  if (!isObject(input.repoSpec) || !isObject(input.sourceMirror)) return null;
  const declared = firstPresent(
    input.repoSpec.control_source?.ref,
    input.repoSpec.control_source_ref,
    input.repoSpec.source_refs?.control,
    input.handoff?.control_source?.ref,
  );
  if (isPlaceholder(declared)) return null;
  const mirrorRef = firstPresent(
    input.sourceMirror.source_ref,
    input.sourceMirror.ref,
    input.sourceMirror.source_repo && input.sourceMirror.issue_number ? `${input.sourceMirror.source_repo}#${input.sourceMirror.issue_number}` : undefined,
  );
  if (isPlaceholder(mirrorRef) || normalizeRef(declared) === normalizeRef(mirrorRef)) return null;
  return {
    code: "source_mirror_ref_mismatch",
    expected: declared,
    observed: mirrorRef,
    message: `Source mirror ${mirrorRef} does not match declared control source ${declared}.`,
  };
}

function cellIdMismatch(input) {
  const expected = handoffCellId(input.handoff);
  const observed = [
    input.gateContractReport?.cell_id,
    input.lifecycleReport?.cell_id,
    input.lifecycleReport?.handoff?.cell_id,
    input.auditRecord?.target_refs?.cell_id,
  ].filter((value) => !isPlaceholder(value));
  const mismatch = observed.find((value) => String(value) !== String(expected));
  if (!mismatch) return null;
  return {
    code: "cell_id_mismatch",
    expected,
    observed: mismatch,
    message: `Expected CELL-ID ${expected}, observed ${mismatch}.`,
  };
}

function controlReferenceMismatch(input) {
  const contextWorkOrder = contextWorkOrderRef(input.executionContextReport);
  const handoffWorkOrder = handoffWorkOrderRef(input.handoff);
  if (!isPlaceholder(contextWorkOrder) && !isPlaceholder(handoffWorkOrder) && normalizeRef(contextWorkOrder) !== normalizeRef(handoffWorkOrder)) {
    return {
      code: "work_order_mismatch",
      expected: contextWorkOrder,
      observed: handoffWorkOrder,
      message: `Execution context work order ${contextWorkOrder} does not match handoff work order ${handoffWorkOrder}.`,
    };
  }

  const contextPr = contextPrRef(input.executionContextReport);
  const observedPrs = [
    handoffPrRef(input.handoff),
    firstPresent(input.lifecycleReport?.pr, input.lifecycleReport?.pr_url, input.lifecycleReport?.source_pr),
    firstPresent(input.gateContractReport?.pr, input.gateContractReport?.pr_url, input.gateContractReport?.source_pr),
  ].filter((value) => !isPlaceholder(value));
  const mismatch = !isPlaceholder(contextPr)
    ? observedPrs.find((value) => normalizeRef(value) !== normalizeRef(contextPr))
    : null;
  if (!mismatch) return null;
  return {
    code: "pr_mismatch",
    expected: contextPr,
    observed: mismatch,
    message: `Execution context PR ${contextPr} does not match observed PR reference ${mismatch}.`,
  };
}

function pathScopeFinding(input) {
  const allowed = asStringArray(input.handoff?.cell?.allowed_paths);
  const forbidden = asStringArray(input.handoff?.cell?.forbidden_paths);
  if (allowed.length === 0 || forbidden.length === 0) {
    return { path: "handoff.cell.allowed_paths", message: "allowed_paths and forbidden_paths are both required." };
  }
  for (const file of input.changedFiles ?? []) {
    if (!matchesAnyGlob(file, allowed)) {
      return { path: file, message: `${file} is outside allowed_paths.` };
    }
    if (matchesAnyGlob(file, forbidden)) {
      return { path: file, message: `${file} matches forbidden_paths.` };
    }
  }
  return null;
}

function protectedSurfaceTaxonomyFinding(input) {
  const surfaces = protectedSurfaces(input).filter((surface) => surface !== "none");
  if (surfaces.length === 0) return null;
  const taxonomy = new Set([...DEFAULT_TAXONOMY, ...matrixTaxonomy(input.matrix), ...asStringArray(input.controlState?.allowed_protected_surfaces)].map(normalizeSurface));
  const unknown = surfaces.find((surface) => !taxonomy.has(normalizeSurface(surface)));
  return unknown ? { path: "protected_surfaces", message: `${unknown} is not in the protected-surface taxonomy.` } : null;
}

function requiredEvidenceMissingRefs(input) {
  const required = asStringArray(input.handoff?.validation?.required_evidence);
  if (required.length === 0) return [];
  const refs = evidenceRefSet(input);
  const findings = [];
  for (const item of required) {
    if (isPlaceholder(item)) {
      findings.push({ path: "handoff.validation.required_evidence", message: "required_evidence contains a placeholder." });
      continue;
    }
    const key = normalizeEvidenceKey(item);
    if (!refs.has(key) && !refs.has(normalizeEvidenceKey(`.${item}`)) && !hasEvidenceByType({ key, input })) {
      findings.push({ path: item, message: `${item} has no concrete evidence reference.` });
    }
  }
  return findings;
}

function evidenceRefSet(input) {
  const values = [
    input.executionContextReportPath,
    input.adoptionReportPath,
    input.lifecycleReportPath,
    input.gateContractReportPath,
    input.designRuleReportPath,
    input.auditChecklistReportPath,
    input.enforcementPolicyReportPath,
    input.readinessReportPath,
    input.validationPath,
    input.ownerDecisionPath,
    input.auditChecklistPath,
    input.auditRecordPath,
    input.postMergePath,
    ...asArray(input.validation?.evidence_refs),
    ...asArray(input.validation?.required_evidence),
    ...asArray(input.gateContractReport?.evidence).map((entry) => entry?.detail),
    ...asArray(input.designRuleReport?.evidence).map((entry) => entry?.detail),
  ];
  return new Set(values.filter((value) => !isPlaceholder(value)).map(normalizeEvidenceKey));
}

function hasEvidenceByType({ key, input }) {
  const typeMap = {
    pr_head_sha: !isPlaceholder(firstPresent(input.actualHead, input.validation?.pr_head_sha, input.gateContractReport?.head_sha, input.gateContractReport?.exact_head_sha)),
    changed_files: (input.changedFiles ?? []).length > 0,
    validation_commands: asArray(input.validation?.commands).length > 0 || asArray(input.validation?.required_commands).length > 0 || asArray(input.handoff?.validation?.required_commands).length > 0,
    validation_results: asArray(input.validation?.results).length > 0 || asArray(input.validation?.validation_results).length > 0 || input.validation?.result === "PASS",
    owner_decision: isObject(input.ownerDecision) || isObject(input.handoff?.owner_decision),
    control_state_completeness_report: isObject(input.aggregate) || !isPlaceholder(input.aggregatePath),
    audit_checklist_report: isObject(input.auditChecklistReport),
  };
  return typeMap[key] === true;
}

function ownerHeadMismatch(input) {
  const ownerHead = ownerDecisionHead(input.ownerDecision) ?? ownerDecisionHead(input.handoff?.owner_decision);
  if (isPlaceholder(ownerHead)) return null;
  const expected = firstPresent(
    input.actualHead,
    reportHead(input.gateContractReport),
    input.validation?.pr_head_sha,
    input.validation?.exact_head_sha,
    input.handoff?.pr_head_sha,
    input.executionContextReport?.evidence?.find?.((entry) => entry.code === "actual_head")?.detail,
  );
  if (isPlaceholder(expected) || String(ownerHead) === String(expected)) return null;
  return {
    code: "owner_head_mismatch",
    expected,
    observed: ownerHead,
    message: `Owner exact head ${ownerHead} does not match expected head ${expected}.`,
  };
}

function expectedHead(input) {
  return firstPresent(
    input.actualHead,
    reportHead(input.gateContractReport),
    input.validation?.pr_head_sha,
    input.validation?.exact_head_sha,
    input.handoff?.pr_head_sha,
    input.executionContextReport?.evidence?.find?.((entry) => entry.code === "actual_head")?.detail,
  );
}

function handoffExactHead(handoff) {
  return firstPresent(
    handoff?.pr_head_sha,
    handoff?.exact_head_sha,
    handoff?.target_head,
    handoff?.head_sha,
    handoff?.owner_decision?.exact_head_sha,
  );
}

function headChangeInput(input) {
  const source = [
    input.validation?.head_change,
    input.handoff?.head_change,
    input.controlState?.head_change,
    input.aggregate?.head_change,
    input.auditChecklistReport?.head_change,
  ].find(isObject) ?? {};
  const currentHead = expectedHead(input);
  const previousAuditedHead = firstPresent(
    source.previous_audited_head,
    source.previous_head,
    input.auditChecklistReport?.audit_completion?.observed_head,
    auditReportHead(input.auditChecklistReport),
    auditRecordHead(input.structuredAudit),
    auditRecordHead(input.auditRecord),
  );
  return {
    ...source,
    previous_audited_head: previousAuditedHead,
    current_head: firstPresent(source.current_head, currentHead),
    pr_body_exact_head: firstPresent(source.pr_body_exact_head, handoffExactHead(input.handoff)),
    validation_rerun: source.validation_rerun ?? validationReranAtHead(input, currentHead),
    allowed_paths_pass: source.allowed_paths_pass ?? pathScopeFinding(input) === null,
    forbidden_paths_pass: source.forbidden_paths_pass ?? pathScopeFinding(input) === null,
    previous_audit_verdict: firstPresent(source.previous_audit_verdict, input.auditChecklistReport?.verdict),
  };
}

function validationReranAtHead(input, currentHead) {
  const validationHead = firstPresent(input.validation?.pr_head_sha, input.validation?.exact_head_sha, input.validation?.head_sha);
  const hasResults = asArray(input.validation?.results).length > 0 ||
    asArray(input.validation?.validation_results).length > 0 ||
    input.validation?.result === "PASS";
  return !isPlaceholder(currentHead) && !isPlaceholder(validationHead) && String(validationHead) === String(currentHead) && hasResults;
}

function auditReportHead(report) {
  return firstPresent(report?.exact_head_sha, report?.pr_head_sha, report?.head_sha, report?.target_head);
}

function auditRecordHead(record) {
  return firstPresent(record?.exact_head_sha, record?.pr_head_sha, record?.head_sha, record?.target_head);
}

function expectedRepo(input) {
  return firstPresent(
    input.actualRepo,
    input.executionContextReport?.primary_repo,
    input.executionContextReport?.primary?.repo,
    input.repoSpec?.repo,
    input.repoSpec?.repo_id,
    input.repoSpec?.id,
  );
}

function expectedPr(input) {
  return firstPresent(
    input.actualPr,
    contextPrRef(input.executionContextReport),
    handoffPrRef(input.handoff),
    input.gateContractReport?.pr,
    input.gateContractReport?.pr_url,
    input.lifecycleReport?.pr,
    input.lifecycleReport?.pr_url,
  );
}

function adoptionLifecycleMismatch(input) {
  const adoption = input.adoptionReport;
  const lifecycle = input.lifecycleReport;
  if (!isObject(adoption) || !isObject(lifecycle)) return null;
  const phase = lifecycle.current_phase;
  if (adoption.verdict === "BLOCKED" && BLOCKING_PHASES.includes(phase)) {
    return {
      code: "adoption_blocked_lifecycle_progress",
      message: `Adoption report is ${adoption.verdict} but lifecycle is ${phase}.`,
    };
  }
  if (adoption.disposition === "retrofit_recover" && BLOCKING_PHASES.includes(phase)) {
    return {
      code: "recover_lifecycle_progress",
      message: "retrofit_recover cannot advance to implementation or merge phases.",
    };
  }
  if (adoption.current_phase && adoption.current_phase !== "ADOPTION_READY" && BLOCKING_PHASES.includes(phase)) {
    return {
      code: "adoption_not_ready",
      message: `Adoption phase ${adoption.current_phase} is incompatible with lifecycle ${phase}.`,
    };
  }
  return null;
}

function lifecycleAllowsProgress(report) {
  if (!isObject(report)) return false;
  return report.verdict === "PASS" || report.verdict === "PASS_WITH_WARN" || BLOCKING_PHASES.includes(report.current_phase);
}

function ownerReadyClaimed(input) {
  return isObject(input.ownerDecision) ||
    ["OWNER_DECISION_REQUIRED", "MERGE_READY", "MERGED", "COMPLETE"].includes(input.lifecycleReport?.current_phase) ||
    input.lifecycleReport?.owner_must_not_merge === false;
}

function auditIsRequired(input) {
  if (input.reviewPlanReport?.review_plan?.base_audit?.required === true) return true;
  if (input.reviewPlanReport?.review_plan?.base_audit?.required === false) return false;
  const risk = String(firstPresent(input.handoff?.cell?.risk_class, input.handoff?.risk_tier, input.repoSpec?.risk_tier) ?? "").toUpperCase();
  return input.handoff?.audit_required === true ||
    input.handoff?.formal_audit_required === true ||
    asArray(input.handoff?.required_audits).length > 0 ||
    ["R3", "R4"].includes(risk);
}

function auditChecklistReportBlockers(report) {
  if (!isBlockingReport(report)) return [];
  const blockers = [
    ...asArray(report?.blockers),
    ...asArray(report?.hard_blocks),
  ].filter((item) => isObject(item));
  const auditBlockers = blockers
    .filter((item) => String(item.item_id ?? "").startsWith("AUDIT-LIST-"))
    .map((item) => ({
      item_id: item.item_id,
      code: item.code ?? "audit_checklist_blocker",
      message: item.message ?? "Audit checklist report blocked.",
      path: item.path ?? "audit_checklist_report",
    }));
  if (auditBlockers.length > 0) return auditBlockers;
  return [{
    item_id: "AUDIT-LIST-001",
    code: "audit_checklist_report_blocked",
    message: "Audit checklist report is blocking but did not include itemized blockers.",
    path: "audit_checklist_report",
  }];
}

function auditChecklistReportWarnings(report) {
  if (!isObject(report)) return [];
  return asArray(report.warnings)
    .filter((item) => isObject(item))
    .filter((item) => String(item.item_id ?? "").startsWith("AUDIT-LIST-"))
    .map((item) => ({
      item_id: item.item_id,
      code: item.code ?? "audit_checklist_warning",
      message: item.message ?? "Audit checklist report warning.",
      path: item.path ?? "audit_checklist_report",
    }));
}

function reviewPlanReportBlockers(report) {
  if (!isObject(report)) return [];
  const blockers = asArray(report.blockers)
    .filter((item) => isObject(item))
    .map((item) => ({
      item_id: item.item_id ?? "CSC-018",
      code: item.code ?? "review_plan_blocker",
      message: item.message ?? "Review plan report blocked.",
      path: item.path ?? "review_plan_report",
    }));
  if (blockers.length > 0) return blockers;
  if (report.verdict === "BLOCKED" || report.would_block === true) {
    return [finding("CSC-018", {
      path: "review_plan_report",
      message: "Review plan report blocks owner/merge progression.",
    })];
  }
  return [];
}

function auditItemSetFinding(input) {
  if (!isObject(input.auditRecord) || !isObject(input.auditItemSet)) return null;
  const requiredIds = asArray(input.auditItemSet.items)
    .map((item) => typeof item === "string" ? item : item?.item_id ?? item?.id)
    .filter(Boolean);
  if (requiredIds.length === 0) return null;
  const observed = asArray(input.auditRecord.items)
    .map((item) => item?.item_id ?? item?.id)
    .filter(Boolean);
  const counts = new Map();
  for (const item of observed) counts.set(item, (counts.get(item) ?? 0) + 1);
  const missing = requiredIds.filter((item) => !counts.has(item));
  const duplicate = [...counts.entries()].filter(([, count]) => count > 1).map(([item]) => item);
  const extra = observed.filter((item) => !requiredIds.includes(item));
  if (missing.length === 0 && duplicate.length === 0 && extra.length === 0) return null;
  return {
    path: "audit_record.items",
    message: `Audit item set mismatch. missing=${missing.join(",") || "none"} duplicate=${duplicate.join(",") || "none"} extra=${extra.join(",") || "none"}.`,
  };
}

function postMergeRequired(input) {
  return input.lifecycleReport?.current_phase === "COMPLETE" ||
    input.handoff?.post_merge?.required === true ||
    input.postMerge?.required === true;
}

function hasPostMergeEvidence(value) {
  if (!isObject(value)) return false;
  if (value.status === "finalized" || value.status === "complete") return true;
  return !isPlaceholder(firstPresent(value.merge_commit, value.merge_commit_sha)) &&
    !isPlaceholder(firstPresent(value.merged_at, value.merged_at_utc));
}

function claimsFullControl(input) {
  const text = scalarClaimValues([
    input.controlState,
    input.repoSpec,
    input.handoff,
    input.readinessReport,
    input.adoptionReport,
    input.lifecycleReport,
  ]).join("\n");
  return /FULL_CONTROL|fully controlled|V3 complete|required-check protected/i.test(text);
}

function scalarClaimValues(value) {
  const values = [];
  visit(value, "value", (_path, entry) => {
    if (typeof entry === "string") values.push(entry);
  });
  return values;
}

function readinessIsFullControlReady(report) {
  return FULL_CONTROL_READY_STATES.includes(report?.state) ||
    FULL_CONTROL_READY_STATES.includes(report?.current_phase) ||
    report?.full_control_ready === true;
}

function staleArtifactRefs(input) {
  const refs = [
    ...artifactRefsFrom(input.handoff, "handoff"),
    ...artifactRefsFrom(input.repoSpec, "repo_spec"),
    ...artifactRefsFrom(input.validation, "validation"),
    ...artifactRefsFrom(input.sourceMirror, "source_mirror"),
  ];
  const known = new Set([
    input.executionContextReportPath,
    input.repoSpecPath,
    input.sourceMirrorPath,
    input.adoptionReportPath,
    input.lifecycleReportPath,
    input.gateContractReportPath,
    input.designRuleReportPath,
    input.auditChecklistReportPath,
    input.enforcementPolicyReportPath,
    input.readinessReportPath,
    input.handoffPath,
    input.validationPath,
    input.ownerDecisionPath,
    input.auditChecklistPath,
    input.auditRecordPath,
    input.auditItemSetPath,
    input.postMergePath,
  ].filter(Boolean));
  return refs
    .filter(({ ref }) => !isPlaceholder(ref) && looksLocalPath(ref))
    .filter(({ ref }) => !known.has(ref) && !existsSync(ref))
    .map(({ path, ref }) => ({
      path,
      ref,
      message: `${ref} is referenced but not present.`,
    }));
}

function artifactRefsFrom(value, prefix) {
  const refs = [];
  visit(value, prefix, (path, entry) => {
    if (/(_ref|_path|ref|path)$/i.test(path.split(".").pop() ?? "") && typeof entry === "string") {
      refs.push({ path, ref: entry });
    }
  });
  return refs;
}

function reportFailureIgnored(report) {
  if (!isObject(report)) return false;
  return report.report_failed === true || report.verdict === "FAILURE" || report.state === "CONTROL_FAILURE";
}

function enforcementMismatchFinding(input) {
  const report = input.enforcementPolicyReport;
  const aggregate = input.aggregate;
  if (!isObject(report) || !isObject(aggregate)) return null;
  if (aggregate.would_block === true && report.mode === "report_only" && report.owner_must_not_merge !== true) {
    return { message: "report_only aggregate would_block=true should set owner_must_not_merge=true." };
  }
  if (["owner_block", "ci_hard_block", "required_check"].includes(report.mode) && aggregate.would_block === true && report.verdict !== "BLOCKED") {
    return { message: `${report.mode} should block when aggregate would_block=true.` };
  }
  return null;
}

function openBlockers(input) {
  return [
    ...asArray(input.executionContextReport?.blockers),
    ...asArray(input.adoptionReport?.blockers),
    ...asArray(input.lifecycleReport?.blockers),
    ...asArray(input.gateContractReport?.blockers),
    ...asArray(input.gateContractReport?.hard_blocks),
    ...asArray(input.designRuleReport?.blockers),
    ...asArray(input.auditChecklistReport?.blockers),
    ...asArray(input.enforcementPolicyReport?.blockers),
    ...asArray(input.postMerge?.unresolved_follow_up_blockers),
  ].filter(Boolean);
}

function protectedSurfaces(input) {
  return [
    ...surfaceValues(input.handoff?.protected_surfaces),
    ...surfaceValues(input.handoff?.cell?.protected_surfaces),
    ...surfaceValues(input.gateContractReport?.protected_surfaces),
  ].map(String).filter(Boolean);
}

function surfaceValues(value) {
  if (Array.isArray(value)) return value.flatMap(surfaceValues);
  if (isObject(value)) {
    if (Array.isArray(value.declared)) return value.declared;
    return Object.entries(value).flatMap(([key, entry]) => entry === true ? [key] : surfaceValues(entry));
  }
  if (typeof value === "string") return [value];
  return [];
}

function matrixTaxonomy(matrix) {
  const values = [];
  visit(matrix, "matrix", (path, value) => {
    if (/(surface|surfaces|protected)/i.test(path) && typeof value === "string") values.push(value);
  });
  return values;
}

function reportHead(report) {
  return firstPresent(report?.head_sha, report?.exact_head_sha, report?.target_head, report?.expected_head_sha, report?.bootstrap?.head_sha);
}

function ownerDecisionHead(ownerDecision) {
  return firstPresent(ownerDecision?.exact_head_sha, ownerDecision?.head_sha, ownerDecision?.target_head);
}

function contextWorkOrderRef(report) {
  return firstPresent(report?.work_order, report?.primary?.work_order, report?.context?.primary?.work_order);
}

function contextPrRef(report) {
  return firstPresent(report?.pr, report?.primary?.pr, report?.context?.primary?.pr);
}

function handoffWorkOrderRef(handoff) {
  return firstPresent(handoff?.work_order, handoff?.work_order_ref, handoff?.repo_local_issue, handoff?.issue_ref);
}

function handoffPrRef(handoff) {
  return firstPresent(handoff?.pr, handoff?.pr_url, handoff?.pull_request, handoff?.source_pr);
}

function handoffCellId(handoff) {
  return firstPresent(handoff?.cell?.["CELL-ID"], handoff?.cell?.cell_id, handoff?.cell_id, handoff?.CELL_ID);
}

function isPassingReport(report) {
  return isObject(report) && report.report_failed !== true && !["BLOCKED", "FAILURE"].includes(report.verdict);
}

function isBlockingReport(report) {
  if (!isObject(report)) return false;
  return report.report_failed === true || report.would_block === true || report.verdict === "BLOCKED" || report.verdict === "FAILURE";
}

function missingState(name, path) {
  return { name, path: path ?? null };
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

function requiredNextActions(blockers, warnings, state) {
  if (state === "CONTROL_COMPLETE") return [];
  return [...blockers, ...warnings].map((item) => ({
    item_id: item.item_id,
    action: actionFor(item.item_id),
  }));
}

function actionFor(itemId) {
  if (String(itemId).startsWith("AUDIT-LIST-")) return "Resolve the structured audit checklist finding and rerun check-audit-checklist.";
  const actions = {
    "CSC-001": "Run check-execution-context and provide its JSON report.",
    "CSC-002": "Provide a machine-readable RPS / PRS artifact.",
    "CSC-003": "Materialize the declared control source as a source mirror artifact.",
    "CSC-004": "Provide a handoff and reconcile CELL-ID references across reports.",
    "CSC-005": "Record allowed_paths/forbidden_paths and keep changed files inside scope.",
    "CSC-006": "Declare protected surfaces using the matrix or allowed taxonomy.",
    "CSC-007": "Attach concrete evidence refs for each required evidence item.",
    "CSC-008": "Refresh owner exact-head decision evidence for the current PR/gate head.",
    "CSC-009": "Reconcile adoption disposition/current phase with lifecycle state.",
    "CSC-010": "Resolve gate-contract blockers before lifecycle/merge progression.",
    "CSC-011": "Resolve design-rule blockers before owner/final decision progress.",
    "CSC-012": "Provide formal audit/reviewer audit evidence.",
    "CSC-013": "Regenerate audit record so each required item is answered exactly once.",
    "CSC-014": "Provide post-merge evidence before claiming COMPLETE.",
    "CSC-015": "Remove full-control claims or provide FULL_CONTROL_READY readiness evidence.",
    "CSC-016": "Refresh stale artifact references to existing machine-readable artifacts.",
    "CSC-017": "Treat failed reports as blocking evidence and rerun/fix the failed gate.",
    "CSC-018": "Provide required additional review evidence before owner decision.",
    "CSC-W001": "Review enforcement policy warnings before merge or graduation.",
    "HEAD-CHANGE-001": "Refresh exact-head metadata or complete the required scoped/full re-audit for the current PR head.",
    "OWNER-SEQ-001": "Complete independent exact-head audit before requesting or accepting owner exact-head approval.",
    "REVIEW-SEQ-001": "Complete required additional reviews before requesting or accepting owner exact-head approval.",
  };
  return actions[itemId] ?? "Resolve control-state completeness finding.";
}

function readInput(options) {
  const input = {
    controlStatePath: stringOption(options["control-state"]),
    executionContextReportPath: stringOption(options["execution-context-report"]),
    repoSpecPath: stringOption(options["repo-spec"]),
    sourceMirrorPath: stringOption(options["source-mirror"]),
    adoptionReportPath: stringOption(options["adoption-report"]),
    lifecycleReportPath: stringOption(options["lifecycle-report"]),
    gateContractReportPath: stringOption(options["gate-contract-report"]),
    designRuleReportPath: stringOption(options["design-rule-report"]),
    reviewPlanReportPath: stringOption(options["review-plan-report"]),
    enforcementPolicyReportPath: stringOption(options["enforcement-policy-report"]),
    readinessReportPath: stringOption(options["readiness-report"]),
    handoffPath: stringOption(options.handoff),
    matrixPath: stringOption(options.matrix),
    changedFilesPath: stringOption(options["changed-files"]),
    validationPath: stringOption(options.validation),
    ownerDecisionPath: stringOption(options["owner-decision"]),
    auditChecklistPath: stringOption(options["audit-checklist"]),
    auditChecklistReportPath: stringOption(options["audit-checklist-report"]),
    structuredAuditPath: stringOption(options["structured-audit"]),
    auditSourcePath: stringOption(options["audit-source"]) ?? stringOption(options["structured-audit-source"]),
    auditSourceTrusted: options["trusted-audit-source"] === true,
    additionalReviewPath: stringOption(options["additional-review"]),
    additionalReviewSourcePath: stringOption(options["additional-review-source"]),
    additionalReviewSourceTrusted: options["trusted-additional-review-source"] === true,
    auditRecordPath: stringOption(options["audit-record"]) ?? stringOption(options["structured-audit"]),
    auditItemSetPath: stringOption(options["audit-item-set"]),
    postMergePath: stringOption(options["post-merge"]),
    aggregatePath: stringOption(options.aggregate),
    actualRepo: stringOption(options["actual-repo"]),
    actualPr: stringOption(options["actual-pr"]),
    actualHead: stringOption(options["actual-head"]),
  };

  const parseErrors = [];
  for (const [key, path] of Object.entries(input)) {
    if (!key.endsWith("Path") || !path || key === "changedFilesPath" || key === "additionalReviewPath") continue;
    const valueKey = key.replace(/Path$/, "");
    const { value, error } = readOptionalStructured(path);
    input[valueKey] = value;
    if (error) parseErrors.push({ path, message: error });
  }
  input.changedFiles = readChangedFiles(input.changedFilesPath);
  input.additionalReviewReports = readAdditionalReviews(input.additionalReviewPath);
  input.handoff = normalizeControlHandoff(input.handoff);

  if (parseErrors.length > 0) {
    return {
      error: {
        schema: SCHEMA,
        state: "CONTROL_FAILURE",
        verdict: "FAILURE",
        would_block: true,
        owner_must_not_merge: true,
        inventory: {},
        missing_states: [],
        stale_states: [],
        mismatches: [],
        blockers: parseErrors.map((error) => ({
          item_id: "CSC-017",
          code: "parse_error",
          message: error.message,
          path: error.path,
        })),
        warnings: [],
        required_next_actions: parseErrors.map((error) => ({
          item_id: "CSC-017",
          action: `Fix parse error in ${error.path}.`,
        })),
      },
    };
  }

  return { input };
}

function readAdditionalReviews(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((filePath) => {
      const value = readOptionalStructured(filePath).value;
      return isObject(value) ? { ...value, __file_path: filePath } : value;
    })
    .filter(Boolean);
}

function readOptionalStructured(filePath) {
  if (!filePath || !existsSync(filePath)) return { value: null };
  try {
    return { value: readStructuredFile(filePath) };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function readChangedFiles(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .sort((a, b) => a.localeCompare(b));
}

function matchesAnyGlob(file, globs) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

function globToRegExp(glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    const nextNext = glob[index + 2];
    if (char === "*" && next === "*" && nextNext === "/") {
      pattern += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }
    pattern += escapeRegExp(char);
  }
  pattern += "$";
  return new RegExp(pattern);
}

function looksLocalPath(value) {
  return typeof value === "string" &&
    !/^https?:\/\//i.test(value) &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(value) &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+/.test(value) &&
    (value.startsWith(".") || value.includes("/") || /\.(ya?ml|json|md|txt)$/i.test(value));
}

function visit(value, path, callback) {
  callback(path, value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, `${path}[${index}]`, callback));
  } else if (isObject(value)) {
    Object.entries(value).forEach(([key, entry]) => visit(entry, `${path}.${key}`, callback));
  }
}

function firstPresent(...values) {
  return values.find((value) => !isPlaceholder(value));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function asStringArray(value) {
  return asArray(value).flatMap((entry) => {
    if (Array.isArray(entry)) return asStringArray(entry);
    if (isObject(entry)) return [];
    return isPlaceholder(entry) ? [] : [String(entry)];
  });
}

function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^<[^>]+>$/.test(trimmed)) return true;
  return /^(pending|pending-.+|tbd|todo|null|none|n\/a|replace this.*)$/i.test(trimmed);
}

function normalizeEvidenceKey(value) {
  return String(value).trim().toLowerCase().replace(/[-\s]+/g, "_").replace(/^\.+\//, "");
}

function normalizeSurface(value) {
  return String(value).trim().toLowerCase().replace(/[-_\s]+/g, " ");
}

function normalizeRepo(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function normalizeRef(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/issues\/(\d+).*/, "#$1")
    .replace(/\/pull\/(\d+).*/, "#$1")
    .replace(/#issuecomment-\d+$/, "");
}

function stringOption(value) {
  return typeof value === "string" ? value : null;
}

function uniqueFindings(findings) {
  return uniqueByKey(findings, (item) => `${item.item_id}:${item.path}:${item.message}`);
}

function uniqueByKey(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.format !== "json") {
    process.stdout.write(`${JSON.stringify({
      schema: SCHEMA,
      state: "CONTROL_FAILURE",
      verdict: "FAILURE",
      would_block: true,
      owner_must_not_merge: true,
      inventory: {},
      missing_states: [],
      stale_states: [],
      mismatches: [],
      blockers: [{ item_id: "CSC-017", code: "unsupported_format", message: "--format json is required.", path: "format" }],
      warnings: [],
      required_next_actions: [{ item_id: "CSC-017", action: "Run with --format json." }],
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const { input, error } = readInput(options);
  const report = error ?? buildControlStateCompletenessReport(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.state === "CONTROL_FAILURE" ? 1 : 0;
}

if (isMain(import.meta.url)) {
  main();
}
