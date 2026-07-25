#!/usr/bin/env node
import { existsSync } from "node:fs";
import {
  asArray,
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";
import {
  buildNextActionSequencing,
} from "./next-action-sequencing.mjs";

const SCHEMA = "shirube-lifecycle-check/v1";
const DEFAULT_MODE = "rapid-lite";
const DEFAULT_PROFILE = "hotel-lite";

const PHASES = [
  "ADOPTION_REQUIRED",
  "RPS_REQUIRED",
  "RPS_READY",
  "HANDOFF_REQUIRED",
  "HANDOFF_READY",
  "EXECUTION_READY",
  "IMPLEMENTED",
  "PR_READY",
  "GATE_REVIEW_REQUIRED",
  "OWNER_DECISION_REQUIRED",
  "MERGE_READY",
  "MERGED",
  "POST_MERGE_REQUIRED",
  "COMPLETE",
  "BLOCKED",
];

const ADOPTION_REQUIRED_PHASES = [
  "HANDOFF_READY",
  "EXECUTION_READY",
  "IMPLEMENTED",
  "PR_READY",
  "GATE_REVIEW_REQUIRED",
  "OWNER_DECISION_REQUIRED",
  "MERGE_READY",
  "MERGED",
  "POST_MERGE_REQUIRED",
  "COMPLETE",
];

const GATE_CONTRACT_REQUIRED_PHASES = [
  "IMPLEMENTED",
  "PR_READY",
  "GATE_REVIEW_REQUIRED",
  "OWNER_DECISION_REQUIRED",
  "MERGE_READY",
  "MERGED",
  "POST_MERGE_REQUIRED",
  "COMPLETE",
];

const DESIGN_RULE_RELEVANT_PHASES = [
  "IMPLEMENTED",
  "PR_READY",
  "GATE_REVIEW_REQUIRED",
  "OWNER_DECISION_REQUIRED",
  "MERGE_READY",
  "MERGED",
  "POST_MERGE_REQUIRED",
  "COMPLETE",
];

const OWNER_DECISION_REQUIRED_PHASES = [
  "MERGE_READY",
  "MERGED",
  "POST_MERGE_REQUIRED",
  "COMPLETE",
];

const MERGED_OR_LATER_PHASES = [
  "MERGED",
  "POST_MERGE_REQUIRED",
  "COMPLETE",
];

const NORMAL_FORBIDDEN_PHASES = [
  "EXECUTION_READY",
  "IMPLEMENTED",
  "PR_READY",
  "MERGE_READY",
  "MERGED",
  "COMPLETE",
];

const ADOPTION_DISPOSITIONS = [
  "greenfield_initialize",
  "retrofit_accelerate",
  "retrofit_recover",
];

const BLOCKERS = {
  "LC-BOOT-001": ["missing_lifecycle_state", "Lifecycle state is missing, invalid, or has an unknown phase.", "state"],
  "LC-BOOT-002": ["missing_framework_ref", "Lifecycle state requires framework_ref or framework_lock_ref.", "state.framework_ref"],
  "LC-ADOPT-001": ["missing_adoption_report", "Adoption report is required before normal lifecycle progression.", "adoption_report"],
  "LC-ADOPT-002": ["adoption_report_blocked", "Adoption report verdict is BLOCKED or FAILURE.", "adoption_report.verdict"],
  "LC-ADOPT-003": ["adoption_not_ready", "Adoption report is not ADOPTION_READY for the requested lifecycle phase.", "adoption_report.current_phase"],
  "LC-ADOPT-004": ["adoption_report_disposition_unknown", "Adoption report disposition is not recognized.", "adoption_report.disposition"],
  "LC-RPS-001": ["missing_rps", "RPS / Repository Premise Spec evidence is required before handoff or implementation.", "repo_spec"],
  "LC-RPS-002": ["rps_not_ready", "RPS exists but lacks owner readiness confirmation.", "repo_spec.confirmation_evidence"],
  "LC-HANDOFF-001": ["missing_handoff", "Control handoff is required before implementation can start.", "handoff"],
  "LC-HANDOFF-002": ["handoff_not_ready", "Handoff must be ready_for_implementation.", "handoff.spec_review_state"],
  "LC-HANDOFF-003": ["cell_id_missing", "Handoff must include CELL-ID.", "handoff.cell.CELL-ID"],
  "LC-EXEC-001": ["gate_contract_missing", "Gate-contract report is required for implemented, PR, merge, or later phases.", "gate_contract_report"],
  "LC-EXEC-002": ["gate_contract_blocked", "Gate-contract report verdict is BLOCKED or FAILURE.", "gate_contract_report.verdict"],
  "LC-EXEC-003": ["design_rule_report_missing", "Design-rule report is required by lifecycle state or handoff.", "design_rule_report"],
  "LC-EXEC-004": ["design_rule_blocked", "Design-rule report verdict is BLOCKED or FAILURE.", "design_rule_report.verdict"],
  "LC-EXEC-005": ["llm_decision_as_phase_authority", "LLM/AI/model approval cannot be phase authority.", "phase_authority"],
  "LC-MERGE-001": ["owner_decision_missing", "MERGE_READY or later requires owner exact-head decision evidence.", "owner_decision"],
  "LC-MERGE-002": ["owner_decision_head_mismatch", "Owner decision head differs from gate report head.", "owner_decision.exact_head_sha"],
  "LC-MERGE-003": ["merge_before_allowed", "MERGED or later cannot be claimed while prior phase blockers remain.", "current_phase"],
  "LC-REVIEW-001": ["review_plan_blocked", "Review plan report is BLOCKED or FAILURE.", "review_plan_report"],
  "LC-POST-001": ["post_merge_missing", "COMPLETE requires post-merge evidence.", "post_merge"],
  "LC-POST-002": ["merge_commit_missing", "Post-merge evidence must include merge commit.", "post_merge.merge_commit"],
  "LC-POST-003": ["merged_at_missing", "Post-merge evidence must include merged_at.", "post_merge.merged_at"],
  "LC-POST-004": ["follow_up_blocker_unresolved", "COMPLETE cannot be claimed while follow-up blockers are unresolved.", "post_merge.unresolved_follow_up_blockers"],
};

const WARNINGS = {
  "LC-WARN-001": ["stale_phase_state", "Lifecycle state is older than current relevant evidence.", "state.updated_at"],
  "LC-WARN-002": ["design_rule_report_optional_missing", "Design-rule report is optional in this slice but should be supplied before enforcement.", "design_rule_report"],
  "LC-WARN-003": ["post_merge_smoke_na", "Post-merge smoke is explicitly N/A and should be reviewed.", "post_merge.post_merge_smoke"],
};

const LLM_AUTHORITY_PATTERNS = [
  new RegExp("LLM " + "approved", "i"),
  new RegExp("AI " + "approved", "i"),
  new RegExp("ChatGPT " + "approved", "i"),
  new RegExp("Claude " + "approved", "i"),
  /model says merge-ready/i,
  new RegExp("approved " + "by model", "i"),
  /LLM decided/i,
  /AI decided/i,
];

export function buildLifecycleReport(input) {
  const blockers = [];
  const warnings = [];
  const evidence = buildEvidence(input);
  const state = isObject(input.state) ? input.state : null;
  const currentPhase = normalizePhase(state?.current_phase);
  const mode = firstPresent(state?.mode, input.handoff?.mode, DEFAULT_MODE);
  const profile = firstPresent(state?.profile, input.handoff?.profile, DEFAULT_PROFILE);

  if (!state || !currentPhase) {
    blockers.push(finding("LC-BOOT-001", { path: input.statePath ?? "state" }));
  }

  if (state && isPlaceholder(firstPresent(state.framework_ref, state.framework_lock_ref, input.frameworkLock?.framework_ref, input.frameworkLock?.ref))) {
    blockers.push(finding("LC-BOOT-002"));
  }

  const phase = currentPhase ?? "BLOCKED";
  const adoptionRequired = phaseIn(phase, ADOPTION_REQUIRED_PHASES);
  const rpsRequired = phaseIn(phase, ADOPTION_REQUIRED_PHASES);
  const handoffRequired = phaseIn(phase, ADOPTION_REQUIRED_PHASES);
  const gateContractRequired = phaseIn(phase, GATE_CONTRACT_REQUIRED_PHASES);
  const designRuleRelevant = phaseIn(phase, DESIGN_RULE_RELEVANT_PHASES);
  const ownerDecisionRequired = phaseIn(phase, OWNER_DECISION_REQUIRED_PHASES);

  if (adoptionRequired) {
    applyAdoptionRules({ input, blockers });
  }

  if (rpsRequired) {
    if (!isObject(input.repoSpec)) {
      blockers.push(finding("LC-RPS-001"));
    } else if (!hasRpsReadinessConfirmation(input.repoSpec)) {
      blockers.push(finding("LC-RPS-002"));
    }
  }

  if (handoffRequired) {
    if (!isObject(input.handoff)) {
      blockers.push(finding("LC-HANDOFF-001"));
    } else {
      if (!handoffReady(input.handoff)) blockers.push(finding("LC-HANDOFF-002"));
      if (isPlaceholder(cellId(input.handoff))) blockers.push(finding("LC-HANDOFF-003"));
    }
  }

  if (gateContractRequired && !isObject(input.gateContractReport)) {
    blockers.push(finding("LC-EXEC-001"));
  }
  if (isBlockingReport(input.gateContractReport)) {
    blockers.push(finding("LC-EXEC-002"));
  }

  const designRequired = designRuleRequired(state, input.handoff);
  if (designRuleRelevant && designRequired && !isObject(input.designRuleReport)) {
    blockers.push(finding("LC-EXEC-003"));
  } else if (designRuleRelevant && !designRequired && !isObject(input.designRuleReport)) {
    warnings.push(finding("LC-WARN-002", {}, WARNINGS));
  }
  if (isBlockingReport(input.designRuleReport)) {
    blockers.push(finding("LC-EXEC-004"));
  }

  if (isBlockingReport(input.reviewPlanReport)) {
    blockers.push(finding("LC-REVIEW-001"));
  }

  if (hasLlmAuthorityClaim(input)) {
    blockers.push(finding("LC-EXEC-005"));
  }

  if (ownerDecisionRequired) {
    if (!hasOwnerDecision(input.ownerDecision)) {
      blockers.push(finding("LC-MERGE-001"));
    } else {
      const gateHead = reportHead(input.gateContractReport);
      const ownerHead = ownerDecisionHead(input.ownerDecision);
      if (!isPlaceholder(gateHead) && !isPlaceholder(ownerHead) && String(gateHead) !== String(ownerHead)) {
        blockers.push(finding("LC-MERGE-002"));
      }
    }
  }

  const priorBlockers = blockers.filter((blocker) => !blocker.item_id.startsWith("LC-POST-") && blocker.item_id !== "LC-MERGE-003");
  if (phaseIn(phase, MERGED_OR_LATER_PHASES) && priorBlockers.length > 0) {
    blockers.push(finding("LC-MERGE-003"));
  }

  if (phase === "COMPLETE") {
    if (!isObject(input.postMerge)) {
      blockers.push(finding("LC-POST-001"));
    } else {
      if (isPlaceholder(firstPresent(input.postMerge.merge_commit, input.postMerge.merge_commit_sha))) {
        blockers.push(finding("LC-POST-002"));
      }
      if (isPlaceholder(firstPresent(input.postMerge.merged_at, input.postMerge.merged_at_utc))) {
        blockers.push(finding("LC-POST-003"));
      }
      if (hasUnresolvedFollowUps(input.postMerge)) {
        blockers.push(finding("LC-POST-004"));
      }
    }
  }

  if (stateIsStale(state, [
    input.adoptionReport,
    input.gateContractReport,
    input.designRuleReport,
    input.ownerDecision,
    input.postMerge,
  ])) {
    warnings.push(finding("LC-WARN-001", {}, WARNINGS));
  }

  if (postMergeSmokeIsNa(input.postMerge)) {
    warnings.push(finding("LC-WARN-003", {}, WARNINGS));
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
    actualHead: firstPresent(input.actualHead, reportHead(input.gateContractReport), ownerDecisionHead(input.ownerDecision), input.state?.target_head, input.state?.head_sha),
    actualRepo: firstPresent(input.actualRepo, input.repoSpec?.repo, input.repoSpec?.repo_id, input.repoSpec?.id),
    actualPr: firstPresent(input.actualPr, input.handoff?.pr, input.handoff?.pr_url, input.state?.pr, input.state?.pr_url),
    currentPhase: phase,
    blockingFindings: blockers,
  });
  blockers.push(...sequencing.blockers);

  const uniqueBlockers = uniqueFindings(blockers);
  const uniqueWarnings = uniqueFindings(warnings);
  const verdict = uniqueBlockers.length > 0 ? "BLOCKED" : uniqueWarnings.length > 0 ? "PASS_WITH_WARN" : "PASS";
  const reportPhase = sequencing.audit_required && phaseIn(sequencing.current_phase, ["AUDIT_REQUIRED", "AUDIT_COMPLETE", "OWNER_DECISION_REQUIRED", "MERGE_READY"])
    ? sequencing.current_phase
    : phase;
  return {
    schema: SCHEMA,
    mode,
    profile,
    current_phase: reportPhase,
    lifecycle_phase: phase,
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
    verdict,
    would_block: verdict === "BLOCKED",
    adoption: adoptionSummary(input),
    allowed_next_phases: allowedNextPhases({ phase, blockers: uniqueBlockers, input }),
    forbidden_next_phases: forbiddenNextPhases(uniqueBlockers),
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    evidence: uniqueEvidence(evidence),
    required_next_actions: requiredNextActions(uniqueBlockers, uniqueWarnings),
  };
}

function applyAdoptionRules({ input, blockers }) {
  const report = input.adoptionReport;
  if (!isObject(report)) {
    blockers.push(finding("LC-ADOPT-001"));
    return;
  }
  if (report.verdict === "BLOCKED" || report.verdict === "FAILURE") {
    blockers.push(finding("LC-ADOPT-002"));
  }
  if (!ADOPTION_DISPOSITIONS.includes(report.disposition)) {
    blockers.push(finding("LC-ADOPT-004"));
  }
  if (report.current_phase !== "ADOPTION_READY") {
    blockers.push(finding("LC-ADOPT-003"));
  }
}

function adoptionSummary(input) {
  const report = isObject(input.adoptionReport) ? input.adoptionReport : {};
  return {
    report_ref: input.adoptionReportPath ?? null,
    lane: report.lane ?? null,
    disposition: report.disposition ?? null,
    current_phase: report.current_phase ?? null,
    verdict: report.verdict ?? null,
  };
}

function buildEvidence(input) {
  const evidence = [];
  addEvidence(evidence, "lifecycle_state", input.statePath, input.state);
  addEvidence(evidence, "adoption_report", input.adoptionReportPath, input.adoptionReport);
  addEvidence(evidence, "repo_spec", input.repoSpecPath, input.repoSpec);
  addEvidence(evidence, "framework_lock", input.frameworkLockPath, input.frameworkLock);
  addEvidence(evidence, "control_handoff", input.handoffPath, input.handoff);
  addEvidence(evidence, "gate_contract_report", input.gateContractReportPath, input.gateContractReport);
  addEvidence(evidence, "design_rule_report", input.designRuleReportPath, input.designRuleReport);
  addEvidence(evidence, "review_plan_report", input.reviewPlanReportPath, input.reviewPlanReport);
  addEvidence(evidence, "owner_decision", input.ownerDecisionPath, input.ownerDecision);
  addEvidence(evidence, "post_merge", input.postMergePath, input.postMerge);
  if (input.changedFilesPath) evidence.push({ code: "changed_files", source: "file", detail: input.changedFilesPath });
  return evidence;
}

function addEvidence(evidence, code, filePath, value) {
  if (filePath && isObject(value)) evidence.push({ code, source: "file", detail: filePath });
}

function allowedNextPhases({ phase, blockers, input }) {
  const itemIds = new Set(blockers.map((blocker) => blocker.item_id));
  if (itemIds.has("LC-BOOT-001") || itemIds.has("LC-BOOT-002")) return ["ADOPTION_REQUIRED"];
  if (hasAny(itemIds, ["LC-ADOPT-001", "LC-ADOPT-002", "LC-ADOPT-003", "LC-ADOPT-004"])) return adoptionRecoveryPhases(input.adoptionReport);
  if (hasAny(itemIds, ["LC-RPS-001", "LC-RPS-002"])) return ["RPS_REQUIRED"];
  if (hasAny(itemIds, ["LC-HANDOFF-001", "LC-HANDOFF-002", "LC-HANDOFF-003"])) return ["HANDOFF_REQUIRED"];
  if (itemIds.has("LC-EXEC-001")) return ["EXECUTION_READY"];
  if (itemIds.has("LC-EXEC-002") || itemIds.has("LC-EXEC-004") || itemIds.has("LC-MERGE-002") || itemIds.has("LC-EXEC-005")) return [];
  if (itemIds.has("LC-EXEC-003")) return ["GATE_REVIEW_REQUIRED"];
  if (itemIds.has("LC-MERGE-001")) return ["OWNER_DECISION_REQUIRED"];
  if (itemIds.has("LC-POST-001") || itemIds.has("LC-POST-002") || itemIds.has("LC-POST-003") || itemIds.has("LC-POST-004")) return ["POST_MERGE_REQUIRED"];
  if (phase === "MERGED" || phase === "POST_MERGE_REQUIRED") return ["POST_MERGE_REQUIRED"];
  if (phase === "COMPLETE") return [];
  const index = PHASES.indexOf(phase);
  if (index >= 0 && index < PHASES.indexOf("COMPLETE") - 1) return [PHASES[index + 1]];
  return [];
}

function adoptionRecoveryPhases(adoptionReport) {
  if (!isObject(adoptionReport)) return ["ADOPTION_REQUIRED"];
  if (adoptionReport.disposition === "retrofit_recover" || adoptionReport.current_phase === "RECOVERY_REQUIRED") {
    return ["ADOPTION_REQUIRED", "RPS_REQUIRED"];
  }
  if (adoptionReport.current_phase === "GAP_FILL_REQUIRED") {
    return ["RPS_REQUIRED", "HANDOFF_REQUIRED"];
  }
  return ["ADOPTION_REQUIRED"];
}

function forbiddenNextPhases(blockers) {
  if (blockers.length === 0) return [];
  return NORMAL_FORBIDDEN_PHASES;
}

function requiredNextActions(blockers, warnings) {
  return [...blockers, ...warnings].map((item) => ({
    item_id: item.item_id,
    action: actionFor(item.item_id),
  }));
}

function actionFor(itemId) {
  const actions = {
    "OWNER-SEQ-001": "Complete independent exact-head audit before requesting or accepting owner exact-head approval.",
    "REVIEW-SEQ-001": "Complete required additional reviews before requesting or accepting owner exact-head approval.",
    "LC-BOOT-001": "Create or repair lifecycle state before advancing.",
    "LC-BOOT-002": "Record pinned framework_ref or framework_lock_ref in lifecycle state.",
    "LC-ADOPT-001": "Run check-adoption and pass its JSON report with --adoption-report.",
    "LC-ADOPT-002": "Resolve adoption blockers before lifecycle progression.",
    "LC-ADOPT-003": "Complete adoption intake, gap-fill, or recovery before normal lifecycle phases.",
    "LC-ADOPT-004": "Use a supported adoption disposition from check-adoption.",
    "LC-RPS-001": "Provide repo-spec/RPS evidence.",
    "LC-RPS-002": "Record owner readiness confirmation for the RPS.",
    "LC-HANDOFF-001": "Provide Rapid/Lite control handoff evidence.",
    "LC-HANDOFF-002": "Mark the handoff ready_for_implementation through structured evidence.",
    "LC-HANDOFF-003": "Add CELL-ID to the handoff.",
    "LC-EXEC-001": "Run check-gate-contract and pass its JSON report.",
    "LC-EXEC-002": "Resolve gate-contract BLOCKED or FAILURE findings.",
    "LC-EXEC-003": "Run check-design-rules because this lifecycle requires it.",
    "LC-EXEC-004": "Resolve design-rule BLOCKED or FAILURE findings.",
    "LC-EXEC-005": "Replace LLM/AI/model authority claims with structured gate evidence.",
    "LC-MERGE-001": "Record owner exact-head merge decision evidence.",
    "LC-MERGE-002": "Re-approve the current exact head or regenerate matching gate evidence.",
    "LC-MERGE-003": "Return to the earliest blocked phase before claiming merged.",
    "LC-REVIEW-001": "Complete required machine-derived review plan actions before owner decision.",
    "LC-POST-001": "Record post-merge evidence before claiming complete.",
    "LC-POST-002": "Add merge commit to post-merge evidence.",
    "LC-POST-003": "Add merged_at timestamp to post-merge evidence.",
    "LC-POST-004": "Resolve follow-up blockers before claiming complete.",
    "LC-WARN-001": "Refresh lifecycle state against the latest evidence.",
    "LC-WARN-002": "Add check-design-rules report evidence when available.",
    "LC-WARN-003": "Review and justify post-merge smoke N/A.",
  };
  return actions[itemId] ?? "Resolve lifecycle finding.";
}

function readInput(options) {
  const refs = {
    statePath: stringOption(options.state),
    adoptionReportPath: stringOption(options["adoption-report"]),
    repoSpecPath: stringOption(options["repo-spec"]),
    frameworkLockPath: stringOption(options["framework-lock"]),
    handoffPath: stringOption(options.handoff),
    gateContractReportPath: stringOption(options["gate-contract-report"]),
    designRuleReportPath: stringOption(options["design-rule-report"]),
    ownerDecisionPath: stringOption(options["owner-decision"]),
    auditChecklistReportPath: stringOption(options["audit-checklist-report"]),
    structuredAuditPath: stringOption(options["structured-audit"]),
    auditSourcePath: stringOption(options["audit-source"]) ?? stringOption(options["structured-audit-source"]),
    auditSourceTrusted: options["trusted-audit-source"] === true,
    reviewPlanReportPath: stringOption(options["review-plan-report"]),
    additionalReviewPath: stringOption(options["additional-review"]),
    additionalReviewSourcePath: stringOption(options["additional-review-source"]),
    additionalReviewSourceTrusted: options["trusted-additional-review-source"] === true,
    postMergePath: stringOption(options["post-merge"]),
    changedFilesPath: stringOption(options["changed-files"]),
    actualRepo: stringOption(options["actual-repo"]),
    actualPr: stringOption(options["actual-pr"]),
    actualHead: stringOption(options["actual-head"]),
  };

  const loaded = {};
  for (const [key, filePath] of Object.entries(refs)) {
    if (!key.endsWith("Path") || key === "additionalReviewPath") continue;
    const valueKey = key.slice(0, -"Path".length);
    const result = readOptionalStructuredInput(filePath, `${toKebab(valueKey)}_parse_error`);
    if (result.error) return { error: result.error };
    loaded[valueKey] = result.value;
  }

  return {
    input: {
      ...refs,
      state: loaded.state,
      adoptionReport: loaded.adoptionReport,
      repoSpec: loaded.repoSpec,
      frameworkLock: loaded.frameworkLock,
      handoff: loaded.handoff,
      gateContractReport: loaded.gateContractReport,
      designRuleReport: loaded.designRuleReport,
      ownerDecision: loaded.ownerDecision,
      auditChecklistReport: loaded.auditChecklistReport,
      structuredAudit: loaded.structuredAudit,
      auditSource: loaded.auditSource,
      auditSourceTrusted: refs.auditSourceTrusted,
      reviewPlanReport: loaded.reviewPlanReport,
      additionalReviewReports: readAdditionalReviews(refs.additionalReviewPath),
      additionalReviewSource: loaded.additionalReviewSource,
      additionalReviewSourceTrusted: refs.additionalReviewSourceTrusted,
      postMerge: loaded.postMerge,
      actualRepo: refs.actualRepo,
      actualPr: refs.actualPr,
      actualHead: refs.actualHead,
    },
  };
}

function readAdditionalReviews(value) {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((filePath) => {
    const value = readOptionalStructuredInput(filePath, "additional_review_parse_error").value;
    return isObject(value) ? { ...value, __file_path: filePath } : value;
  }).filter(Boolean);
}

function readOptionalStructuredInput(filePath, errorCode) {
  if (!filePath || !existsSync(filePath)) return { value: null };
  try {
    return { value: readStructuredFile(filePath) };
  } catch (error) {
    return {
      error: failureReport({ code: errorCode, message: errorMessage(error) }),
    };
  }
}

function failureReport({ code, message }) {
  const nextAction = {
    action: "repair_lifecycle_input",
    responsible_role: "dev",
    allowed_actor_role: "dev",
    reason: message,
  };
  return {
    schema: SCHEMA,
    mode: DEFAULT_MODE,
    profile: DEFAULT_PROFILE,
    current_phase: "BLOCKED",
    next_action: nextAction,
    owner_approval_allowed: false,
    merge_ready_allowed: false,
    forbidden_next_actions: [
      "owner_exact_head_approval",
      "mark_merge_ready",
      "merge",
    ],
    audit_required: false,
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
    verdict: "FAILURE",
    would_block: false,
    adoption: {
      report_ref: null,
      lane: null,
      disposition: null,
      current_phase: null,
      verdict: null,
    },
    allowed_next_phases: [],
    forbidden_next_phases: NORMAL_FORBIDDEN_PHASES,
    blockers: [],
    warnings: [],
    evidence: [],
    required_next_actions: [{ code, message }],
  };
}

function finding(itemId, overrides = {}, source = BLOCKERS) {
  const [code, message, defaultPath] = source[itemId];
  return {
    item_id: itemId,
    code,
    message: overrides.message ?? message,
    path: overrides.path ?? defaultPath,
  };
}

function hasRpsReadinessConfirmation(repoSpec) {
  return repoSpec?.confirmation_evidence?.rps_readiness?.verdict === "CONFIRMED" ||
    repoSpec?.rps_confirmation?.verdict === "CONFIRMED" ||
    repoSpec?.owner_confirmation?.verdict === "CONFIRMED" ||
    repoSpec?.owner_readiness_confirmation?.verdict === "CONFIRMED" ||
    repoSpec?.premise_confirmation?.verdict === "CONFIRMED";
}

function handoffReady(handoff) {
  return handoff.spec_review_state === "ready_for_implementation" ||
    handoff.handoff_review_state === "ready_for_implementation" ||
    handoff.ready_for_implementation === true ||
    handoff.handoff_ready_for_implementation === true ||
    handoff?.handoff_review?.ready_for_implementation === true;
}

function cellId(handoff) {
  return firstPresent(handoff?.cell?.["CELL-ID"], handoff?.cell?.cell_id, handoff?.cell_id, handoff?.CELL_ID);
}

function isBlockingReport(report) {
  return isObject(report) && (report.verdict === "BLOCKED" || report.verdict === "FAILURE");
}

function designRuleRequired(state, handoff) {
  return state?.design_rule_required === true ||
    state?.design_rules_required === true ||
    state?.design_rules?.required === true ||
    handoff?.design_rule_required === true ||
    handoff?.design_rules_required === true ||
    handoff?.design_rules?.required === true;
}

function hasLlmAuthorityClaim(input) {
  const scanTargets = [
    input.state,
    input.handoff,
    input.ownerDecision,
    input.postMerge,
    input.gateContractReport,
    input.designRuleReport,
    input.adoptionReport,
  ];
  return scanTargets.some((target) => {
    if (target === null || target === undefined) return false;
    const text = JSON.stringify(target);
    return LLM_AUTHORITY_PATTERNS.some((pattern) => pattern.test(text));
  });
}

function hasOwnerDecision(ownerDecision) {
  return isObject(ownerDecision) && !isPlaceholder(ownerDecisionHead(ownerDecision));
}

function ownerDecisionHead(ownerDecision) {
  return firstPresent(ownerDecision?.exact_head_sha, ownerDecision?.target_head, ownerDecision?.target_head_sha, ownerDecision?.head_sha);
}

function reportHead(report) {
  return firstPresent(
    report?.head_sha,
    report?.target_head,
    report?.target_head_sha,
    report?.pr_head_sha,
    report?.expected_head_sha,
    report?.pr?.head_sha,
    report?.owner_decision?.exact_head_sha,
  );
}

function hasUnresolvedFollowUps(postMerge) {
  const direct = asArray(postMerge.unresolved_follow_up_blockers);
  if (direct.length > 0) return true;
  return asArray(postMerge.follow_up_blockers).some((item) => {
    if (isObject(item)) return item.resolved !== true && item.status !== "resolved";
    return !isPlaceholder(item);
  });
}

function postMergeSmokeIsNa(postMerge) {
  if (!isObject(postMerge)) return false;
  const value = firstPresent(postMerge.post_merge_smoke, postMerge.smoke, postMerge.post_merge_smoke_result);
  return typeof value === "string" && /^n\/?a$/i.test(value.trim());
}

function stateIsStale(state, evidenceItems) {
  if (!isObject(state) || isPlaceholder(state.updated_at)) return false;
  const stateTime = Date.parse(state.updated_at);
  if (Number.isNaN(stateTime)) return false;
  return evidenceItems.some((item) => {
    if (!isObject(item)) return false;
    const value = firstPresent(item.generated_at, item.created_at, item.updated_at, item.merged_at, item.merged_at_utc);
    if (isPlaceholder(value)) return false;
    const evidenceTime = Date.parse(value);
    return !Number.isNaN(evidenceTime) && evidenceTime > stateTime;
  });
}

function normalizePhase(value) {
  if (typeof value !== "string") return null;
  const phase = value.trim();
  return PHASES.includes(phase) ? phase : null;
}

function phaseIn(phase, phases) {
  return phases.includes(phase);
}

function hasAny(set, values) {
  return values.some((value) => set.has(value));
}

function firstPresent(...values) {
  return values.find((value) => !isPlaceholder(value));
}

function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^<[^>]+>$/.test(trimmed)) return true;
  return /^(pending|pending-.+|tbd|todo|null|none|n\/a|replace this.*)$/i.test(trimmed);
}

function stringOption(value) {
  return typeof value === "string" ? value : null;
}

function toKebab(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function uniqueFindings(findings) {
  const seen = new Set();
  const unique = [];
  for (const item of findings) {
    const key = `${item.item_id}\0${item.code}\0${item.path}\0${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function uniqueEvidence(evidence) {
  const seen = new Set();
  const unique = [];
  for (const item of evidence) {
    const key = `${item.code}\0${item.source}\0${item.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function runLifecycleCheck(argv = process.argv.slice(2)) {
  const { options } = parseArgs(argv);
  if (options.format !== "json") {
    return {
      result: failureReport({ code: "unsupported_format", message: "--format json is required." }),
      exitCode: 1,
    };
  }
  const loaded = readInput(options);
  if (loaded.error) return { result: loaded.error, exitCode: 1 };
  const result = buildLifecycleReport(loaded.input);
  return {
    result,
    exitCode: result.verdict === "FAILURE" ? 1 : 0,
  };
}

if (isMain(import.meta.url)) {
  const { result, exitCode } = runLifecycleCheck();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = exitCode;
}
