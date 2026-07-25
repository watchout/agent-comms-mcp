const SEQUENCING_PHASES = [
  "IMPLEMENTED",
  "METADATA_REFRESH_REQUIRED",
  "AUDIT_REQUIRED",
  "SCOPED_REAUDIT_REQUIRED",
  "AUDIT_COMPLETE",
  "ADDITIONAL_REVIEW_REQUIRED",
  "ADDITIONAL_REVIEW_COMPLETE",
  "OWNER_DECISION_REQUIRED",
  "OWNER_APPROVED",
  "MERGE_READY",
  "MERGED",
];

export const OWNER_SEQUENCE_BLOCKER = {
  item_id: "OWNER-SEQ-001",
  code: "owner_decision_before_audit_complete",
  message: "Owner exact-head decision cannot be accepted before independent audit completion.",
  path: "owner_decision",
};

export const REVIEW_SEQUENCE_BLOCKER = {
  item_id: "REVIEW-SEQ-001",
  code: "owner_decision_before_additional_review_complete",
  message: "Owner exact-head decision cannot be accepted before required additional reviews complete.",
  path: "owner_decision",
};

export const HEAD_CHANGE_SEQUENCE_BLOCKER = {
  item_id: "HEAD-CHANGE-001",
  code: "head_change_requires_classification_or_reaudit",
  message: "PR head changed after audit; metadata refresh, scoped re-audit, or full re-audit is required before owner approval.",
  path: "head_change",
};

const TRUSTED_AUDIT_CHECKER = "scripts/shirube/check-audit-checklist.mjs";
const TRUSTED_AUDIT_RESOLVER = "scripts/shirube/resolve-structured-audit-ref.mjs";
const TRUSTED_ADDITIONAL_REVIEW_RESOLVER = "scripts/shirube/resolve-additional-review-ref.mjs";

const FORBID_OWNER_AND_MERGE = [
  "owner_exact_head_approval",
  "request_owner_exact_head_decision",
  "mark_merge_ready",
  "merge",
];

const FORBID_MERGE = [
  "mark_merge_ready",
  "merge",
];

export const APPROVAL_CLASSES = Object.freeze([
  "NONE", "OWNER_EXACT_HEAD", "OWNER_PROTECTED_EFFECT", "OWNER_ROOT_TRANSITION",
]);
export const OPERATION_CODES = Object.freeze([
  "WORK_ITEM_DISPATCH", "INDEPENDENT_AUDIT", "INDEPENDENT_REAUDIT", "PARENT_RETURN",
  "EVIDENCE_RECORD", "INTERNAL_REPLY", "GITHUB_WRITEBACK", "DEPENDENCY_BYPASS",
  "LOCAL_DIRECT_ADAPTER", "EXACT_CONTROL_HANDOFF_ACQUISITION", "DESIGN_GAP_RETURN",
  "FINAL_MERGE", "CONTROL_DOC_MERGE", "PROTECTED_OWNER_DECISION", "SCHEMA_MIGRATION",
  "RUNTIME_RUNNER_ACTIVATION", "PROVIDER_AUN_ACTIVATION", "WORKFLOW_PROTECTION",
  "SECRET_MUTATION", "DEPLOY", "EXTERNAL_SEND", "ENROLLMENT_FLEET_CUTOVER",
  "AUTHORITY_MUTATION", "ROOT_CANCEL", "ROOT_SUPERSEDE",
]);
const OPERATION_CODE_SET = new Set(OPERATION_CODES);
const EXACT_HEAD_OPERATIONS = new Set(["FINAL_MERGE", "CONTROL_DOC_MERGE"]);
const PROTECTED_OPERATIONS = new Set([
  "PROTECTED_OWNER_DECISION", "SCHEMA_MIGRATION", "RUNTIME_RUNNER_ACTIVATION",
  "PROVIDER_AUN_ACTIVATION", "WORKFLOW_PROTECTION", "SECRET_MUTATION", "DEPLOY",
  "EXTERNAL_SEND", "ENROLLMENT_FLEET_CUTOVER", "AUTHORITY_MUTATION",
]);
const ROOT_TRANSITION_OPERATIONS = new Set(["ROOT_CANCEL", "ROOT_SUPERSEDE"]);

export function deriveSequencingAuthority(input = {}) {
  const handoff = isObject(input.handoff) ? input.handoff : {};
  const operationCode = firstPresent(
    input.operationCode,
    input.operation_code,
    input.gateContractReport?.authority?.operation_code,
    handoff?.authority?.operation_code,
    handoff.operation_code,
    handoff?.cell?.operation_code,
  );
  const operationProvided = typeof operationCode === "string" && operationCode.trim().length > 0;
  const operationKnown = OPERATION_CODE_SET.has(operationCode);
  const normalizedOperation = operationKnown ? operationCode : operationProvided ? "WORK_ITEM_DISPATCH" : "FINAL_MERGE";
  const protectedSurfaceRefs = uniqueStrings(asArray(firstPresent(
    input.protectedSurfaceRefs,
    input.protected_surface_refs,
    input.gateContractReport?.authority?.protected_surface_refs,
    handoff?.authority?.protected_surface_refs,
    handoff.protected_surface_refs,
    handoff?.cell?.protected_surface_refs,
  )).filter((value) => /^registry:[a-z0-9._:-]+$/.test(String(value))));
  const riskClass = firstPresent(
    input.riskClass,
    input.risk_class,
    input.gateContractReport?.risk_class,
    handoff.risk_class,
    handoff?.cell?.risk_class,
    handoff?.cell?.risk_tier,
  );
  const approvalClass = ROOT_TRANSITION_OPERATIONS.has(normalizedOperation) ? "OWNER_ROOT_TRANSITION" :
    EXACT_HEAD_OPERATIONS.has(normalizedOperation) && (!operationProvided || riskClass === undefined || ["R3", "R4"].includes(riskClass)) ? "OWNER_EXACT_HEAD" :
    PROTECTED_OPERATIONS.has(normalizedOperation) && protectedSurfaceRefs.length > 0 ? "OWNER_PROTECTED_EFFECT" :
    "NONE";
  const untrustedProposal = String(firstPresent(input.untrustedProposal, input.untrusted_proposal, handoff.untrusted_proposal) ?? "");
  return {
    operation_code: normalizedOperation,
    approval_class: approvalClass,
    protected_surface_refs: protectedSurfaceRefs,
    risk_class: typeof riskClass === "string" ? riskClass : null,
    result_code: operationProvided && !operationKnown
      ? "UNKNOWN_OPERATION_CODE"
      : approvalClass === "NONE" && /owner[- ]authorized|owner.*approv|request_owner/i.test(untrustedProposal)
      ? "UNAUTHORIZED_EFFECT_PROPOSAL"
      : null,
  };
}

export function buildNextActionSequencing(input = {}) {
  const auditRequired = input.auditRequired ?? auditRequiredFrom(input);
  const auditCompletion = auditCompletionFrom(input);
  const additionalReviewCompletion = additionalReviewCompletionFrom(input);
  const ownerDecision = ownerDecisionStatus(input.ownerDecision, input.actualHead);
  const headChange = classifyHeadChange({ ...input, auditCompletion });
  const blockingFindings = asArray(input.blockingFindings).filter(Boolean);
  const authority = deriveSequencingAuthority(input);
  const ownerSequenceBlockers = [];

  if (auditRequired && !auditCompletion.complete && ownerDecision.final_approval_present) {
    ownerSequenceBlockers.push({ ...OWNER_SEQUENCE_BLOCKER });
  }
  if (headChange?.requires_action && ownerDecision.final_approval_present) {
    ownerSequenceBlockers.push({ ...HEAD_CHANGE_SEQUENCE_BLOCKER });
  }
  if (additionalReviewCompletion.required && !additionalReviewCompletion.complete && ownerDecision.final_approval_present) {
    ownerSequenceBlockers.push({ ...REVIEW_SEQUENCE_BLOCKER });
  }

  if (headChange?.current_phase === "METADATA_REFRESH_REQUIRED") {
    return sequencingResult({
      current_phase: "METADATA_REFRESH_REQUIRED",
      next_action: {
        action: "refresh_exact_head_metadata",
        responsible_role: "dev",
        allowed_actor_role: "dev",
        reason: `Refresh PR body and control metadata to current exact head ${headChange.current_head ?? input.actualHead ?? "<unknown>"}.`,
      },
      owner_approval_allowed: false,
      merge_ready_allowed: false,
      forbidden_next_actions: FORBID_OWNER_AND_MERGE,
      head_change: headChange,
      audit_required: auditRequired,
      audit_completion: auditCompletion,
      additional_review_completion: additionalReviewCompletion,
      owner_decision_status: ownerDecision,
      blockers: [{ ...HEAD_CHANGE_SEQUENCE_BLOCKER, message: "PR body exact-head metadata is stale after a head change." }, ...ownerSequenceBlockers],
      authority,
    });
  }

  if (headChange?.current_phase === "SCOPED_REAUDIT_REQUIRED") {
    return sequencingResult({
      current_phase: "SCOPED_REAUDIT_REQUIRED",
      next_action: {
        action: "request_scoped_reaudit",
        responsible_role: "auditor",
        allowed_actor_role: "independent_reviewer",
        reason: `Request scoped re-audit from ${headChange.previous_audited_head ?? "<unknown>"} to current exact head ${headChange.current_head ?? input.actualHead ?? "<unknown>"}.`,
      },
      owner_approval_allowed: false,
      merge_ready_allowed: false,
      forbidden_next_actions: FORBID_OWNER_AND_MERGE,
      head_change: headChange,
      audit_required: true,
      audit_completion: auditCompletion,
      additional_review_completion: additionalReviewCompletion,
      owner_decision_status: ownerDecision,
      blockers: [{ ...HEAD_CHANGE_SEQUENCE_BLOCKER, message: "Scoped exact-head re-audit is required before owner approval." }, ...ownerSequenceBlockers],
      authority,
    });
  }

  if (headChange?.current_phase === "AUDIT_REQUIRED") {
    const reason = headChange.classification === "blocked_unclassified_head_change"
      ? "Classify the PR head-change delta before audit depth can be trusted."
      : `Independent machine-readable audit is required for exact head ${headChange.current_head ?? input.actualHead ?? "<unknown>"}.`;
    return sequencingResult({
      current_phase: "AUDIT_REQUIRED",
      next_action: {
        action: headChange.classification === "blocked_unclassified_head_change" ? "classify_head_change_delta" : "request_independent_audit",
        responsible_role: "auditor",
        allowed_actor_role: "independent_reviewer",
        reason,
      },
      owner_approval_allowed: false,
      merge_ready_allowed: false,
      forbidden_next_actions: FORBID_OWNER_AND_MERGE,
      head_change: headChange,
      audit_required: true,
      audit_completion: auditCompletion,
      additional_review_completion: additionalReviewCompletion,
      owner_decision_status: ownerDecision,
      blockers: [{ ...HEAD_CHANGE_SEQUENCE_BLOCKER }, ...ownerSequenceBlockers],
      authority,
    });
  }

  if (auditRequired && !auditCompletion.complete) {
    return blockedSequencingResult({
      current_phase: "AUDIT_REQUIRED",
      next_action: {
        action: "request_independent_audit",
        responsible_role: "auditor",
        allowed_actor_role: "independent_reviewer",
        reason: `Independent machine-readable audit is required for exact head ${input.actualHead ?? auditCompletion.expected_head ?? "<unknown>"}.`,
      },
      head_change: headChange,
      audit_required: auditRequired,
      audit_completion: auditCompletion,
      additional_review_completion: additionalReviewCompletion,
      owner_decision_status: ownerDecision,
      blockers: ownerSequenceBlockers,
      authority,
    });
  }

  if (additionalReviewCompletion.required && !additionalReviewCompletion.complete) {
    return blockedSequencingResult({
      current_phase: "ADDITIONAL_REVIEW_REQUIRED",
      next_action: {
        action: "request_required_additional_review",
        responsible_role: "review_owner",
        allowed_actor_role: "required_additional_reviewer",
        reason: `Required additional review is missing for exact head ${input.actualHead ?? auditCompletion.expected_head ?? "<unknown>"}.`,
      },
      head_change: headChange,
      audit_required: auditRequired,
      audit_completion: auditCompletion,
      additional_review_completion: additionalReviewCompletion,
      owner_decision_status: ownerDecision,
      blockers: ownerSequenceBlockers,
      authority,
    });
  }

  const nonOwnerSequenceBlockers = blockingFindings.filter((finding) => finding?.item_id !== "OWNER-SEQ-001");
  if (nonOwnerSequenceBlockers.length > 0) {
    return sequencingResult({
      current_phase: additionalReviewCompletion.required ? "ADDITIONAL_REVIEW_COMPLETE" : auditRequired ? "AUDIT_COMPLETE" : normalizePhase(input.currentPhase) ?? "IMPLEMENTED",
      next_action: {
        action: "resolve_gate_blockers",
        responsible_role: "dev",
        allowed_actor_role: "dev",
        reason: "Gate blockers remain before owner decision or merge readiness can proceed.",
      },
      owner_approval_allowed: false,
      merge_ready_allowed: false,
      forbidden_next_actions: FORBID_OWNER_AND_MERGE.filter((action) => action !== "request_owner_exact_head_decision"),
      head_change: headChange,
      audit_required: auditRequired,
      audit_completion: auditCompletion,
      additional_review_completion: additionalReviewCompletion,
      owner_decision_status: ownerDecision,
      blockers: ownerSequenceBlockers,
      authority,
    });
  }

  if (authority.approval_class === "NONE") {
    return sequencingResult({
      current_phase: auditRequired ? "AUDIT_COMPLETE" : normalizePhase(input.currentPhase) ?? "IMPLEMENTED",
      next_action: {
        action: authority.operation_code === "INDEPENDENT_AUDIT" || authority.operation_code === "INDEPENDENT_REAUDIT"
          ? "record_independent_audit_return"
          : "continue_policy_selected_lifecycle",
        responsible_role: "runner",
        allowed_actor_role: "deterministic_runner",
        reason: "Derived approval class is NONE; no owner wait may be synthesized.",
      },
      owner_approval_allowed: false,
      merge_ready_allowed: false,
      forbidden_next_actions: ["owner_exact_head_approval", "request_owner_exact_head_decision"],
      head_change: headChange,
      audit_required: auditRequired,
      audit_completion: auditCompletion,
      additional_review_completion: additionalReviewCompletion,
      owner_decision_status: ownerDecision,
      blockers: ownerSequenceBlockers,
      authority,
    });
  }

  if (!ownerDecision.final_approval_present) {
    return ownerDecisionRequiredResult({
      next_action: {
        action: "request_owner_exact_head_decision",
        responsible_role: "owner",
        allowed_actor_role: "repo_owner",
        reason: `Independent audit prerequisites are satisfied; owner exact-head decision is required for ${input.actualHead ?? auditCompletion.expected_head ?? "<unknown>"}.`,
      },
      head_change: headChange,
      audit_required: auditRequired,
      audit_completion: auditCompletion,
      additional_review_completion: additionalReviewCompletion,
      owner_decision_status: ownerDecision,
      blockers: ownerSequenceBlockers,
      authority,
    });
  }

  if (ownerDecision.head_mismatch) {
    return ownerDecisionRequiredResult({
      next_action: {
        action: "request_owner_exact_head_decision",
        responsible_role: "owner",
        allowed_actor_role: "repo_owner",
        reason: "Owner decision exists but does not match the current exact head.",
      },
      head_change: headChange,
      audit_required: auditRequired,
      audit_completion: auditCompletion,
      additional_review_completion: additionalReviewCompletion,
      owner_decision_status: ownerDecision,
      blockers: ownerSequenceBlockers,
      authority,
    });
  }

  return sequencingResult({
    current_phase: authority.approval_class === "OWNER_EXACT_HEAD" ? "MERGE_READY" : "OWNER_APPROVED",
    next_action: {
      action: authority.approval_class === "OWNER_EXACT_HEAD" ? "merge_when_policy_allows" : "execute_policy_selected_protected_effect",
      responsible_role: "owner",
      allowed_actor_role: "repo_owner",
      reason: "Independent audit and owner exact-head approval are complete.",
    },
    owner_approval_allowed: true,
    merge_ready_allowed: authority.approval_class === "OWNER_EXACT_HEAD",
    forbidden_next_actions: [],
    head_change: headChange,
    audit_required: auditRequired,
    audit_completion: auditCompletion,
    additional_review_completion: additionalReviewCompletion,
    owner_decision_status: ownerDecision,
    blockers: ownerSequenceBlockers,
    authority,
  });
}

export function classifyHeadChange(input = {}) {
  const raw = normalizeHeadChangeInput(input);
  const previousAuditedHead = raw.previous_audited_head;
  const currentHead = raw.current_head;
  const headChanged = Boolean(raw.head_changed || (!isPlaceholder(previousAuditedHead) && !isPlaceholder(currentHead) && String(previousAuditedHead) !== String(currentHead)));
  const result = {
    previous_audited_head: previousAuditedHead ?? null,
    current_head: currentHead ?? null,
    classification: null,
    functional_diff_changed: raw.functional_diff_changed === true,
    metadata_only_conflict_resolution: raw.metadata_only_conflict_resolution === true,
    required_next_action: null,
    head_changed: headChanged,
    requires_action: false,
    current_phase: null,
    details: raw.details,
  };

  if (!headChanged && !raw.pr_body_exact_head_stale) return result;

  if (raw.pr_body_exact_head_stale) {
    return {
      ...result,
      classification: "metadata_refresh_required",
      required_next_action: "refresh_exact_head_metadata",
      requires_action: true,
      current_phase: "METADATA_REFRESH_REQUIRED",
    };
  }

  if (isPlaceholder(previousAuditedHead) || isPlaceholder(currentHead) || raw.delta_available !== true) {
    return {
      ...result,
      classification: "blocked_unclassified_head_change",
      required_next_action: "classify_head_change_delta",
      requires_action: true,
      current_phase: "AUDIT_REQUIRED",
    };
  }

  if (raw.new_protected_functional_surface === true || raw.functional_diff_changed === true || raw.package_or_lockfile_changed === true) {
    const fullReauditComplete = raw.current_exact_head_full_reaudit_complete === true;
    return {
      ...result,
      classification: "full_reaudit_required",
      functional_diff_changed: true,
      required_next_action: fullReauditComplete ? null : "request_independent_audit",
      requires_action: !fullReauditComplete,
      current_phase: fullReauditComplete ? null : "AUDIT_REQUIRED",
    };
  }

  const scopedAllowed = raw.previous_audit_accepted === true &&
    raw.metadata_only_conflict_resolution === true &&
    raw.functional_diff_changed !== true &&
    raw.new_protected_functional_surface !== true &&
    raw.allowed_paths_pass === true &&
    raw.forbidden_paths_pass === true &&
    raw.validation_rerun === true;

  if (scopedAllowed) {
    const scopedComplete = raw.current_exact_head_audit_complete === true && scopedReauditReferencesHeads({
      structuredAudit: input.structuredAudit,
      auditChecklistReport: input.auditChecklistReport,
      previousAuditedHead,
      currentHead,
    });
    return {
      ...result,
      classification: "scoped_reaudit_allowed",
      functional_diff_changed: false,
      metadata_only_conflict_resolution: true,
      required_next_action: scopedComplete ? null : "request_scoped_reaudit",
      requires_action: !scopedComplete,
      current_phase: scopedComplete ? null : "SCOPED_REAUDIT_REQUIRED",
    };
  }

  return {
    ...result,
    classification: "full_reaudit_required",
    required_next_action: raw.current_exact_head_full_reaudit_complete ? null : "request_independent_audit",
    requires_action: !raw.current_exact_head_full_reaudit_complete,
    current_phase: raw.current_exact_head_full_reaudit_complete ? null : "AUDIT_REQUIRED",
  };
}

function sequencingResult(fields) {
  const authority = fields.authority ?? { operation_code: "FINAL_MERGE", approval_class: "OWNER_EXACT_HEAD", protected_surface_refs: [], result_code: null };
  return {
    phases: SEQUENCING_PHASES,
    operation_code: authority.operation_code,
    approval_class: authority.approval_class,
    protected_surface_refs: authority.protected_surface_refs,
    result_code: authority.result_code,
    ...fields,
  };
}

function blockedSequencingResult(fields) {
  return sequencingResult({
    owner_approval_allowed: false,
    merge_ready_allowed: false,
    forbidden_next_actions: FORBID_OWNER_AND_MERGE,
    ...fields,
  });
}

function ownerDecisionRequiredResult(fields) {
  return sequencingResult({
    current_phase: "OWNER_DECISION_REQUIRED",
    owner_approval_allowed: true,
    merge_ready_allowed: false,
    forbidden_next_actions: FORBID_MERGE,
    ...fields,
  });
}

export function auditRequiredFrom(input = {}) {
  const handoff = input.handoff ?? {};
  if (input.reviewPlan?.base_audit?.required === true) return true;
  if (input.reviewPlan?.base_audit?.required === false) return false;
  const risk = String(firstPresent(handoff?.cell?.risk_class, handoff?.risk_tier, input.repoSpec?.risk_tier) ?? "").toUpperCase();
  return handoff.audit_required === true ||
    handoff.formal_audit_required === true ||
    handoff.independent_audit_required === true ||
    handoff?.audit?.required === true ||
    handoff?.reviewer_audit?.required === true ||
    asArray(handoff.required_audits).length > 0 ||
    ["R3", "R4"].includes(risk);
}

function normalizeHeadChangeInput(input = {}) {
  const headChange = isObject(input.headChange) ? input.headChange : {};
  const auditCompletion = isObject(input.auditCompletion) ? input.auditCompletion : auditCompletionFrom(input);
  const currentHead = firstPresent(
    headChange.current_head,
    headChange.currentHead,
    input.actualHead,
    auditCompletion.expected_head,
  );
  const previousAuditedHead = firstPresent(
    headChange.previous_audited_head,
    headChange.previousAuditedHead,
    headChange.previous_head,
    headChange.previousHead,
    auditCompletion.observed_head && !isPlaceholder(currentHead) && String(auditCompletion.observed_head) !== String(currentHead)
      ? auditCompletion.observed_head
      : null,
  );
  const deltaFiles = asArray(firstPresent(
    headChange.delta_changed_files,
    headChange.changed_files_since_previous_audit,
    headChange.changed_files,
    headChange.files,
  )).map((file) => String(file ?? "").trim()).filter(Boolean);
  const prBodyExactHead = firstPresent(
    headChange.pr_body_exact_head,
    headChange.prBodyExactHead,
    headChange.body_exact_head,
    input.prBodyExactHead,
  );
  const prBodyExactHeadStale = !isPlaceholder(prBodyExactHead) &&
    !isPlaceholder(currentHead) &&
    String(prBodyExactHead) !== String(currentHead);
  const metadataOnly = booleanValue(headChange.metadata_only_conflict_resolution) ??
    booleanValue(headChange.metadataOnlyConflictResolution) ??
    (deltaFiles.length > 0 && deltaFiles.every(isMetadataOnlyConflictFile));
  const protectedFunctional = booleanValue(headChange.new_protected_functional_surface) ??
    booleanValue(headChange.newProtectedFunctionalSurface) ??
    deltaFiles.some(isProtectedFunctionalFile);
  const packageOrLockfileChanged = deltaFiles.some(isPackageOrLockfile);
  const previousAuditVerdict = String(firstPresent(
    headChange.previous_audit_verdict,
    headChange.previousAuditVerdict,
    input.auditChecklistReport?.verdict,
  ) ?? "").toUpperCase();
  const previousAuditAccepted = ["PASS", "PASS_WITH_WARN"].includes(previousAuditVerdict) ||
    headChange.previous_audit_accepted === true ||
    headChange.previousAuditAccepted === true ||
    auditCompletion.verdict_accepted === true;
  const validationRerun = booleanValue(headChange.validation_rerun) ??
    booleanValue(headChange.validationRerun) ??
    false;
  const allowedPathsPass = booleanValue(headChange.allowed_paths_pass) ??
    booleanValue(headChange.allowedPathsPass) ??
    true;
  const forbiddenPathsPass = booleanValue(headChange.forbidden_paths_pass) ??
    booleanValue(headChange.forbiddenPathsPass) ??
    true;
  const currentExactHeadAuditComplete = auditCompletion.complete === true &&
    !isPlaceholder(currentHead) &&
    !isPlaceholder(auditCompletion.observed_head) &&
    String(auditCompletion.observed_head) === String(currentHead);
  const currentExactHeadFullReauditComplete = currentExactHeadAuditComplete && fullReauditEvidenceComplete({
    structuredAudit: input.structuredAudit,
    auditChecklistReport: input.auditChecklistReport,
  });
  const deltaAvailable = booleanValue(headChange.delta_available) ??
    booleanValue(headChange.deltaAvailable) ??
    deltaFiles.length > 0;
  const functionalDiffChanged = booleanValue(headChange.functional_diff_changed) ??
    booleanValue(headChange.functionalDiffChanged) ??
    (protectedFunctional || packageOrLockfileChanged ? true : metadataOnly ? false : null);

  return {
    previous_audited_head: previousAuditedHead,
    current_head: currentHead,
    head_changed: booleanValue(headChange.head_changed) ?? booleanValue(headChange.headChanged) ?? null,
    pr_body_exact_head_stale: prBodyExactHeadStale,
    delta_available: deltaAvailable,
    functional_diff_changed: functionalDiffChanged,
    metadata_only_conflict_resolution: metadataOnly === true,
    new_protected_functional_surface: protectedFunctional === true,
    package_or_lockfile_changed: packageOrLockfileChanged,
    previous_audit_accepted: previousAuditAccepted,
    validation_rerun: validationRerun,
    allowed_paths_pass: allowedPathsPass,
    forbidden_paths_pass: forbiddenPathsPass,
    current_exact_head_audit_complete: currentExactHeadAuditComplete,
    current_exact_head_full_reaudit_complete: currentExactHeadFullReauditComplete,
    details: {
      pr_body_exact_head: prBodyExactHead ?? null,
      delta_changed_files: deltaFiles,
      previous_audit_verdict: previousAuditVerdict || null,
      current_audit_type: auditTypeFrom({
        structuredAudit: input.structuredAudit,
        auditChecklistReport: input.auditChecklistReport,
      }) ?? null,
    },
  };
}

function fullReauditEvidenceComplete({ structuredAudit, auditChecklistReport }) {
  const auditType = auditTypeFrom({ structuredAudit, auditChecklistReport });
  if (!auditType) return false;
  if (/scoped.*reaudit|scoped.*audit/.test(auditType)) return false;
  return /full.*reaudit|full.*audit|independent.*audit|independent.*structured.*audit/.test(auditType);
}

function auditTypeFrom({ structuredAudit, auditChecklistReport }) {
  const auditType = normalizeText(firstPresent(
    structuredAudit?.audit_type,
    structuredAudit?.document_type,
    auditChecklistReport?.audit_type,
    auditChecklistReport?.document_type,
  ));
  return auditType || null;
}

function scopedReauditReferencesHeads({ structuredAudit, auditChecklistReport, previousAuditedHead, currentHead }) {
  const text = JSON.stringify([structuredAudit ?? {}, auditChecklistReport ?? {}]);
  if (isPlaceholder(previousAuditedHead) || isPlaceholder(currentHead)) return false;
  if (!text.includes(String(previousAuditedHead)) || !text.includes(String(currentHead))) return false;
  const auditType = auditTypeFrom({ structuredAudit, auditChecklistReport });
  if (!auditType) return true;
  return /scoped.*reaudit|reaudit|full.*audit|independent.*audit/.test(auditType);
}

function isMetadataOnlyConflictFile(file) {
  const normalized = normalizePath(file) ?? "";
  return normalized.startsWith(".shirube/") ||
    normalized.startsWith("docs/shirube/") ||
    normalized.startsWith("docs/standards/") ||
    normalized.includes("control-handoff") ||
    normalized.includes("handoff") ||
    normalized.includes("validation-evidence") ||
    normalized.includes("owner-decision-pending") ||
    normalized.endsWith(".md");
}

function isProtectedFunctionalFile(file) {
  const normalized = normalizePath(file) ?? "";
  return /^(src|app|api|lib|db|migrations|deploy|deployment)\//.test(normalized) ||
    /^\.github\/workflows\//.test(normalized) ||
    /^\.github\/(branch-protection|rulesets)\//.test(normalized) ||
    /(^|\/)(schema|schemas|permissions|auth|policy|privacy|security)(\/|\.|-)/i.test(normalized) ||
    isPackageOrLockfile(normalized);
}

function isPackageOrLockfile(file) {
  const normalized = normalizePath(file) ?? "";
  return /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|npm-shrinkwrap\.json)$/.test(normalized);
}

export function additionalReviewCompletionFrom(input = {}) {
  const required = asArray(input.reviewPlan?.additional_reviews).filter((review) => review?.required === true);
  const reports = asArray(input.additionalReviewReports).filter(isObject);
  const source = input.additionalReviewSource;
  const sourceRuntimeTrusted = input.additionalReviewSourceTrusted === true;
  const sourceTrusted = additionalReviewSourceIsTrusted(source, sourceRuntimeTrusted);
  const actualHead = input.actualHead;
  const actualRepo = normalizeRepo(input.actualRepo);
  const actualPr = normalizePr(input.actualPr);
  const completeReviews = [];
  const missingReviews = [];
  const headMismatches = [];
  const provenanceMissing = [];
  const makerCheckerViolations = [];

  for (const review of required) {
    const report = reports.find((entry) => normalizeText(entry.review_type ?? entry.type) === normalizeText(review.review_type));
    const status = additionalReviewReportStatus({ report, source, sourceTrusted, actualHead, actualRepo, actualPr });
    if (!status.complete) {
      missingReviews.push(review.review_type);
      if (status.head_mismatch) headMismatches.push({ review_type: review.review_type, expected: actualHead, observed: status.observed_head ?? null });
      if (!status.provenance_complete) provenanceMissing.push(review.review_type);
      if (!status.maker_checker_separated) makerCheckerViolations.push(review.review_type);
      continue;
    }
    completeReviews.push(review.review_type);
  }

  return {
    required: required.length > 0,
    complete: required.length === 0 || missingReviews.length === 0,
    required_reviews: required.map((review) => review.review_type),
    complete_reviews: completeReviews,
    missing_reviews: missingReviews,
    head_mismatches: headMismatches,
    provenance_missing: uniqueStrings(provenanceMissing),
    maker_checker_violations: uniqueStrings(makerCheckerViolations),
    source_runtime_trusted: Boolean(sourceRuntimeTrusted),
    trusted_source: Boolean(sourceTrusted),
  };
}

function additionalReviewReportStatus({ report, source, sourceTrusted, actualHead, actualRepo, actualPr }) {
  if (!isObject(report)) return { complete: false };
  const verdict = String(firstPresent(report.verdict, report.decision, report.status) ?? "").toUpperCase();
  const accepted = ["PASS", "PASS_WITH_WARN", "APPROVED", "CONDITIONAL_GO"].includes(verdict);
  const observedHead = firstPresent(report.exact_head_sha, report.pr_head_sha, report.head_sha, report.target_head);
  const observedRepo = normalizeRepo(firstPresent(report.target_repo, report.repo));
  const observedPr = normalizePr(firstPresent(report.target_pr, report.pr, report.pull_request));
  const headMatches = isPlaceholder(actualHead) || !isPlaceholder(observedHead) && String(observedHead) === String(actualHead);
  const repoMatches = !isPlaceholder(observedRepo) && (!actualRepo || observedRepo === actualRepo);
  const prMatches = !isPlaceholder(observedPr) && (!actualPr || observedPr === actualPr);
  const provenance = additionalReviewProvenanceStatus({ report, source, sourceTrusted, actualHead, actualRepo, actualPr });
  const makerCheckerSeparated = additionalReviewMakerCheckerSeparated(report);
  return {
    complete: accepted && headMatches && repoMatches && prMatches && provenance.complete && makerCheckerSeparated,
    accepted,
    head_matches: Boolean(headMatches),
    head_mismatch: !isPlaceholder(actualHead) && !isPlaceholder(observedHead) && !headMatches,
    repo_matches: Boolean(repoMatches),
    pr_matches: Boolean(prMatches),
    observed_head: observedHead ?? null,
    provenance_complete: Boolean(provenance.complete),
    maker_checker_separated: Boolean(makerCheckerSeparated),
  };
}

function additionalReviewProvenanceStatus({ report, source, sourceTrusted, actualHead, actualRepo, actualPr }) {
  if (!sourceTrusted || !isObject(source)) return { complete: false };
  const reviewType = normalizeText(firstPresent(report.review_type, report.type));
  const entry = additionalReviewSourceEntries(source).find((candidate) => normalizeText(candidate.review_type) === reviewType);
  if (!entry) return { complete: false };
  const sourceHead = firstPresent(entry.exact_head_sha, entry.pr_head_sha, source.exact_head_sha, source.pr_head_sha, source.head_sha, source.target_head);
  const sourceRepo = normalizeRepo(firstPresent(entry.target_repo, source.target_repo, source.repo));
  const sourcePr = normalizePr(firstPresent(entry.target_pr, source.target_pr, source.pr));
  const sourceHeadMatches = !isPlaceholder(sourceHead) && (isPlaceholder(actualHead) || String(sourceHead) === String(actualHead));
  const sourceRepoMatches = !isPlaceholder(sourceRepo) && (!actualRepo || sourceRepo === actualRepo);
  const sourcePrMatches = !isPlaceholder(sourcePr) && (!actualPr || sourcePr === actualPr);
  const sourceMaterializedPathMatches = additionalReviewSourceMaterializedPathMatches({ source, report });
  return {
    complete: sourceHeadMatches && sourceRepoMatches && sourcePrMatches && sourceMaterializedPathMatches,
  };
}

function additionalReviewSourceIsTrusted(source, runtimeTrusted) {
  if (!isObject(source)) return false;
  if (runtimeTrusted !== true) return false;
  if (source.target_branch_mutated === true || source.owner_approval_synthesized === true) return false;
  if (source.trusted_base_workflow !== true) return false;
  if (String(firstPresent(source.generated_by, source.resolver, source.tool) ?? "") !== TRUSTED_ADDITIONAL_REVIEW_RESOLVER) return false;
  const resolverSchema = firstPresent(source.resolver_schema, source.resolution_schema);
  if (!isPlaceholder(resolverSchema) && resolverSchema !== "shirube-additional-review-ref-resolution/v1") return false;
  const hasSourceLocator = additionalReviewSourceEntries(source).some((entry) => !isPlaceholder(firstPresent(
    entry.source_comment_url,
    entry.comment_url,
    entry.review_url,
    entry.source_ref,
    entry.comment_id,
    entry.evidence_ref,
  )));
  if (!hasSourceLocator) return false;
  const type = String(firstPresent(source.source_type, source.type) ?? "").toLowerCase();
  return ["github_comment", "github_pr_comment", "github_review", "external_review_ref", "owner_accepted_external_review_ref"].includes(type);
}

function additionalReviewSourceEntries(source) {
  if (Array.isArray(source?.sources)) return source.sources.filter(isObject);
  if (isObject(source)) return [source];
  return [];
}

function additionalReviewSourceMaterializedPathMatches({ source, report }) {
  const reportPath = normalizePath(firstPresent(report?.__file_path, report?.file_path, report?.path));
  if (isPlaceholder(reportPath)) return false;
  const sourcePaths = [
    ...asArray(source?.materialized_paths),
    ...asArray(source?.materialized_path),
    ...asArray(source?.additional_review_paths),
  ].map(normalizePath).filter(Boolean);
  return sourcePaths.includes(reportPath);
}

function additionalReviewMakerCheckerSeparated(report) {
  if (!isObject(report)) return false;
  const reviewerActor = firstPresent(report.reviewer_actor, report.review_actor, report.actor);
  const implementationActor = firstPresent(report.implementation_actor, report.implementer_actor);
  if (isPlaceholder(reviewerActor) || isPlaceholder(implementationActor)) return false;
  return String(reviewerActor) !== String(implementationActor);
}

export function auditCompletionFrom(input = {}) {
  const report = input.auditChecklistReport;
  const audit = input.structuredAudit;
  const source = input.auditSource;
  const actualHead = input.actualHead;
  const actualRepo = normalizeRepo(input.actualRepo);
  const actualPr = normalizePr(input.actualPr);
  const reportBlockers = [
    ...asArray(report?.blockers),
    ...asArray(report?.hard_blocks),
  ];
  const reportWarnings = asArray(report?.warnings);
  const sourceHead = auditSourceHead(source);
  const sourceRepo = normalizeRepo(auditSourceTargetRepo(source));
  const sourcePr = normalizePr(auditSourceTargetPr(source));
  const reportHead = firstPresent(
    report?.exact_head_sha,
    report?.pr_head_sha,
    auditHead(audit),
    sourceHead,
  );
  const reportRepo = normalizeRepo(firstPresent(report?.target_repo, auditTargetRepo(audit), sourceRepo));
  const reportPr = normalizePr(firstPresent(report?.target_pr, auditTargetPr(audit), sourcePr));
  const verdictAccepted = report?.verdict === "PASS" ||
    (report?.verdict === "PASS_WITH_WARN" && passWithWarnAccepted(report));
  const machineReadable = isObject(report) && String(report.schema ?? report.schema_version) === "shirube-audit-checklist-check/v1";
  const exactHeadMatches = !isPlaceholder(reportHead) &&
    (isPlaceholder(actualHead) || String(reportHead) === String(actualHead));
  const targetRepoMatches = !isPlaceholder(reportRepo) &&
    (actualRepo ? reportRepo === actualRepo : true);
  const targetPrMatches = !isPlaceholder(reportPr) &&
    (actualPr ? reportPr === actualPr : true);
  const sourceHeadMatches = !isPlaceholder(sourceHead) &&
    (isPlaceholder(actualHead) || String(sourceHead) === String(actualHead));
  const sourceRepoMatches = !isPlaceholder(sourceRepo) &&
    (actualRepo ? sourceRepo === actualRepo : true);
  const sourcePrMatches = !isPlaceholder(sourcePr) &&
    (actualPr ? sourcePr === actualPr : true);
  const sourceMaterializedPathMatches = sourceMaterializedPathMatchesReport({ source, report, auditPath: input.structuredAuditPath });
  const sourceRuntimeTrusted = input.auditSourceTrusted === true;
  const sourceTrusted = sourceIsTrusted(source, sourceRuntimeTrusted);
  const independent = sourceTrusted &&
    sourceHeadMatches &&
    sourceRepoMatches &&
    sourcePrMatches &&
    sourceMaterializedPathMatches;
  const checkerTrusted = reportIsTrustedChecker(report);
  const makerCheckerSeparated = auditMakerCheckerSeparated(audit);
  const checklistItemCount = numberValue(report?.inventory?.checklist_items);
  const auditItemCount = Math.max(numberValue(report?.inventory?.audit_items), asArray(audit?.items).length);
  const requiredItemsAnswered = isObject(report) &&
    reportBlockers.length === 0 &&
    report?.verdict !== "FAILURE" &&
    report?.verdict !== "BLOCKED" &&
    checklistItemCount > 0 &&
    auditItemCount > 0;
  const complete = Boolean(
    isObject(report) &&
    isObject(audit) &&
    machineReadable &&
    checkerTrusted &&
    exactHeadMatches &&
    targetRepoMatches &&
    targetPrMatches &&
    independent &&
    makerCheckerSeparated &&
    verdictAccepted &&
    requiredItemsAnswered &&
    reportBlockers.length === 0,
  );

  return {
    exists: isObject(report) || isObject(audit),
    machine_readable: Boolean(machineReadable),
    independent: Boolean(independent),
    exact_head_matches: Boolean(exactHeadMatches),
    target_repo_matches: Boolean(targetRepoMatches),
    target_pr_matches: Boolean(targetPrMatches),
    verdict_accepted: Boolean(verdictAccepted),
    required_items_answered: Boolean(requiredItemsAnswered),
    complete,
    source_runtime_trusted: Boolean(sourceRuntimeTrusted),
    trusted_checker: Boolean(checkerTrusted),
    trusted_source: Boolean(sourceTrusted),
    maker_checker_separated: Boolean(makerCheckerSeparated),
    expected_head: actualHead ?? null,
    observed_head: reportHead ?? null,
    target_repo: reportRepo ?? null,
    target_pr: reportPr ?? null,
    source_head_matches: Boolean(sourceHeadMatches),
    source_repo_matches: Boolean(sourceRepoMatches),
    source_pr_matches: Boolean(sourcePrMatches),
    source_materialized_path_matches: Boolean(sourceMaterializedPathMatches),
    warnings_count: reportWarnings.length,
  };
}

export function ownerDecisionStatus(ownerDecision, actualHead) {
  const finalDecision = finalOwnerApproval(ownerDecision);
  const head = ownerDecisionHead(ownerDecision);
  const headMismatch = finalDecision && !isPlaceholder(actualHead) && !isPlaceholder(head) && String(head) !== String(actualHead);
  return {
    present: isObject(ownerDecision),
    pending: isObject(ownerDecision) && !finalDecision,
    final_approval_present: finalDecision,
    exact_head_sha: head ?? null,
    head_mismatch: Boolean(headMismatch),
  };
}

export function finalOwnerApproval(ownerDecision) {
  if (!isObject(ownerDecision)) return false;
  const decision = String(firstPresent(ownerDecision.decision, ownerDecision.verdict, ownerDecision.status) ?? "").toUpperCase();
  const approvalGranted = ownerDecision.approval_granted === true || ownerDecision.approved === true;
  const approvedDecision = decision === "APPROVED_EXACT_HEAD" || decision === "APPROVED";
  return (approvalGranted || approvedDecision) && !isPlaceholder(ownerDecisionHead(ownerDecision));
}

export function ownerDecisionHead(ownerDecision) {
  return firstPresent(ownerDecision?.exact_head_sha, ownerDecision?.target_head, ownerDecision?.target_head_sha, ownerDecision?.head_sha);
}

function passWithWarnAccepted(report) {
  return report.accepted_pass_with_warn === true ||
    report.warnings_accepted === true ||
    report.owner_accepted_warnings === true;
}

function sourceIsIndependent(source) {
  return sourceIsTrusted(source, false);
}

function sourceIsTrusted(source, runtimeTrusted) {
  if (!isObject(source)) return false;
  if (runtimeTrusted !== true) return false;
  if (source.target_branch_mutated === true || source.owner_approval_synthesized === true) return false;
  if (source.trusted_base_workflow !== true) return false;
  if (String(firstPresent(source.generated_by, source.resolver, source.tool) ?? "") !== TRUSTED_AUDIT_RESOLVER) return false;
  const resolverSchema = firstPresent(source.resolver_schema, source.resolution_schema);
  if (!isPlaceholder(resolverSchema) && resolverSchema !== "shirube-structured-audit-ref-resolution/v1") return false;
  const hasSourceLocator = !isPlaceholder(firstPresent(
    source.source_comment_url,
    source.comment_url,
    source.review_url,
    source.source_ref,
    source.comment_id,
    source.evidence_ref,
  ));
  if (!hasSourceLocator) return false;
  const type = String(firstPresent(source.source_type, source.type) ?? "").toLowerCase();
  if (["github_comment", "github_pr_comment", "github_review", "external_audit_ref", "owner_accepted_external_audit_ref"].includes(type)) return true;
  return false;
}

function reportIsTrustedChecker(report) {
  if (!isObject(report)) return false;
  if (report.trusted_checker !== true) return false;
  if (String(firstPresent(report.generated_by, report.checker, report.tool) ?? "") !== TRUSTED_AUDIT_CHECKER) return false;
  return true;
}

function auditMakerCheckerSeparated(audit) {
  if (!isObject(audit)) return false;
  const reviewerActor = firstPresent(audit.reviewer_actor, audit.auditor_actor);
  const implementationActor = firstPresent(audit.implementation_actor, audit.implementer_actor);
  if (isPlaceholder(reviewerActor) || isPlaceholder(implementationActor)) return false;
  return String(reviewerActor) !== String(implementationActor);
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

function auditSourceHead(source) {
  return firstPresent(source?.exact_head_sha, source?.pr_head_sha, source?.head_sha, source?.target_head, source?.target?.head_sha);
}

function auditSourceTargetRepo(source) {
  return firstPresent(source?.target_repo, source?.repo, source?.target?.repo);
}

function auditSourceTargetPr(source) {
  return firstPresent(source?.target_pr, source?.pr, source?.pull_request, source?.target?.pr);
}

function sourceMaterializedPathMatchesReport({ source, report, auditPath }) {
  const sourcePath = normalizePath(firstPresent(source?.materialized_path, source?.structured_audit_path, source?.audit_path));
  if (isPlaceholder(sourcePath)) return false;
  const reportPath = normalizePath(firstPresent(
    report?.structured_audit_ref,
    report?.structured_audit_path,
    report?.audit_ref,
    report?.audit_path,
    auditPath,
  ));
  return !isPlaceholder(reportPath) && sourcePath === reportPath;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function booleanValue(value) {
  if (value === true || value === false) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "pass", "passed"].includes(normalized)) return true;
  if (["false", "no", "fail", "failed"].includes(normalized)) return false;
  return null;
}

function normalizePath(value) {
  if (isPlaceholder(value)) return null;
  let text = String(value).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const cwd = process.cwd().replace(/\\/g, "/").replace(/\/+$/, "");
  if (text.startsWith(`${cwd}/`)) text = text.slice(cwd.length + 1);
  return text;
}

function normalizePhase(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return SEQUENCING_PHASES.includes(text) ? text : null;
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
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^<[^>]+>$/.test(trimmed)) return true;
  return /^(pending|pending-.+|tbd|todo|null|none|n\/a|replace this.*)$/i.test(trimmed);
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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
