#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";
import {
  normalizeControlHandoff,
} from "./normalize-control-handoff.mjs";
import { deriveSequencingAuthority } from "./next-action-sequencing.mjs";

const SCHEMA = "shirube-gate-contract-check/v1";
const DEFAULT_MATRIX = ".shirube/gate-contracts/shirube-v3-rapid-lite-gate-contract-matrix.yaml";
const DEFAULT_REPO_SPEC = ".shirube/repo-spec.yaml";
const DEFAULT_FRAMEWORK_LOCK = ".shirube/shirube-framework-lock.yaml";
const RAPID_LITE_CHANGED_FILE_WARN_LIMIT = 12;
const FORBIDDEN_WHEN_BLOCKED = ["EXECUTION_READY", "IMPLEMENTED", "MERGED", "RELEASED"];

const HARD_MESSAGES = {
  "RL-BOOT-001": ["missing_framework_lock", "Framework lock or handoff framework/matrix reference is required.", "framework_ref"],
  "RL-BOOT-002": ["missing_mode_or_profile", "mode/profile must be rapid-lite / hotel-lite.", "mode"],
  "RL-BOOT-003": ["framework_ref_unpinned", "framework_ref must be pinned when enforce_pinned_ref is true.", "framework_ref"],
  "RL-RPS-001": ["missing_premise_ssot", "Repository premise spec or handoff premise reference is required.", "repo_spec_ref"],
  "RL-RPS-002": ["missing_premise_owner_confirmation", "Premise owner confirmation is required.", "owner_confirmation_ref"],
  "RL-RPS-003": ["rps_scope_missing", "RPS or handoff must state what Shirube owns and does not own for the repo.", "rps_scope"],
  "RL-RPS-004": ["legacy_source_as_truth", "Legacy or external docs must not be treated as authority without current repo-local RPS/control reference.", "legacy_source_boundary"],
  "RL-GOAL-001": ["missing_control_handoff", "Control handoff file is required and must be readable.", "handoff"],
  "RL-GOAL-002": ["missing_repo_local_issue", "repo_local_issue is required.", "repo_local_issue"],
  "RL-GOAL-004": ["missing_owner_or_next_role", "owner.role, owner.actor, and next_role are required.", "owner"],
  "RL-SPEC-004": ["missing_minimal_spec_boundary", "Minimal spec boundary is missing goal, non_scope, risk_class, cell_type, paths, or validation plan.", "cell"],
  "RL-SPEC-005": ["missing_spec_review_state", "Handoff must state whether it is ready for implementation and who owns the next role.", "spec_review_state"],
  "RL-CELL-001": ["missing_cell_id", "CELL-ID is required.", "cell.CELL-ID"],
  "RL-CELL-002": ["missing_allowed_paths", "cell.allowed_paths must contain at least one path glob.", "cell.allowed_paths"],
  "RL-CELL-003": ["missing_forbidden_paths", "cell.forbidden_paths must contain at least one path glob.", "cell.forbidden_paths"],
  "RL-CELL-004": ["missing_stop_conditions", "cell.stop_conditions must contain at least one stop condition.", "cell.stop_conditions"],
  "RL-CELL-006": ["protected_surface_requires_standard_or_enterprise", "Protected surfaces require Standard or Enterprise mode.", "cell.cell_type"],
  "RL-PR-001": ["missing_pr_head_sha", "PR head SHA is required.", "pr_head_sha"],
  "RL-PR-002": ["changed_files_outside_allowed_paths", "Changed file is outside cell.allowed_paths.", "changed_files"],
  "RL-PR-003": ["forbidden_paths_touched", "Changed file matches cell.forbidden_paths.", "changed_files"],
  "RL-PR-004": ["runtime_pr_head_mismatch", "Declared PR head evidence does not match the GitHub runtime PR head.", "pr_head_sha"],
  "RL-EVID-001": ["missing_validation_evidence", "validation.required_evidence is required.", "validation.required_evidence"],
  "RL-EVID-002": ["placeholder_evidence", "Required evidence must not contain placeholder or pending values.", "validation.required_evidence"],
  "RL-MERGE-001": ["owner_decision_missing", "Owner decision is required before merge.", "owner_decision"],
  "RL-MERGE-002": ["merge_head_mismatch", "Owner decision exact head does not match expected PR head.", "owner_decision.exact_head_sha"],
  "RL-AUTH-001": ["authority_derivation_mismatch", "Declared authority differs from the deterministic risk/operation gate plan.", "authority"],
};

const WARN_MESSAGES = {
  "RL-BOOT-003": ["framework_ref_unpinned", "framework_ref is symbolic and should be pinned before enforcement.", "framework_ref"],
  "RL-SPEC-W001": ["AC_TEST_granularity_low", "Acceptance or test detail is too thin for Rapid/Lite promotion.", "acceptance_criteria"],
  "RL-PR-W001": ["PR_size_large", "Changed file count exceeds the Rapid/Lite report-only threshold.", "changed_files"],
  "RL-EVID-W002": ["manual_evidence_only", "Validation evidence is durable but manual only.", "validation"],
  "RL-MERGE-W001": ["owner_decision_pending", "Owner exact-head decision is pending and remains required before merge.", "owner_decision"],
};

export function buildGateContractReport(input) {
  const hardBlocks = [];
  const warnings = [];
  const evidence = [];
  const matrixPath = input.matrixPath;
  const handoffPath = input.handoffPath;
  const repoSpecPath = input.repoSpecPath;
  const frameworkLockPath = input.frameworkLockPath;
  const changedFiles = input.changedFiles ?? [];
  const matrix = input.matrix;
  const handoff = normalizeControlHandoff(input.handoff);
  const repoSpec = input.repoSpec;
  const frameworkLock = input.frameworkLock;
  const validationArtifact = input.validationArtifact;
  const ownerDecisionArtifact = input.ownerDecisionArtifact;

  evidence.push({ code: "gate_contract_matrix", source: "file", detail: matrixPath });
  if (repoSpec) evidence.push({ code: "repo_spec", source: "file", detail: repoSpecPath });
  if (frameworkLock) evidence.push({ code: "framework_lock", source: "file", detail: frameworkLockPath });

  if (!handoff) {
    hardBlocks.push(finding("RL-BOOT-001"));
    hardBlocks.push(finding("RL-GOAL-001"));
    return report({
      matrixPath,
      handoffPath: handoffPath ?? "",
      bootstrap: buildBootstrap({ matrix, repoSpec, repoSpecPath, frameworkLock, handoff: null }),
      cellId: null,
      cellType: null,
      hardBlocks,
      warnings,
      evidence,
    });
  }

  const cell = isObject(handoff.cell) ? handoff.cell : {};
  const owner = isObject(handoff.owner) ? handoff.owner : {};
  const ownerDecision = mergeObjects(isObject(handoff.owner_decision) ? handoff.owner_decision : {}, ownerDecisionArtifact);
  const validation = mergeObjects(isObject(handoff.validation) ? handoff.validation : {}, validationArtifact);
  const cellId = stringValue(cell["CELL-ID"]) ?? null;
  const cellType = stringValue(cell.cell_type) ?? null;
  const allowedPaths = asStringArray(cell.allowed_paths);
  const forbiddenPaths = asStringArray(cell.forbidden_paths);
  const stopConditions = asArray(cell.stop_conditions);
  const bootstrap = buildBootstrap({ matrix, repoSpec, repoSpecPath, frameworkLock, handoff });
  const authority = deriveSequencingAuthority({ ...input, handoff });
  const gatePlan = {
    operation_code: authority.operation_code,
    approval_class: authority.approval_class,
    independent_audit_required: authority.operation_code === "INDEPENDENT_AUDIT" || authority.operation_code === "INDEPENDENT_REAUDIT",
    owner_decision_required: authority.approval_class !== "NONE",
    merge_gate_required: authority.approval_class === "OWNER_EXACT_HEAD",
    protected_gate_required: authority.approval_class === "OWNER_PROTECTED_EFFECT",
  };

  evidence.push({ code: "control_handoff", source: "file", detail: handoffPath });
  evidence.push({ code: "changed_files", source: input.changedFilesPath ? "file" : "input", detail: `${changedFiles.length} changed file(s)` });
  if (input.ownerDecisionPath) evidence.push({ code: "owner_decision", source: "file", detail: input.ownerDecisionPath });
  if (input.validationPath) evidence.push({ code: "validation_evidence", source: "file", detail: input.validationPath });

  // 1. bootstrap / adoption preflight
  if (!hasFrameworkReference({ frameworkLock, handoff })) hardBlocks.push(finding("RL-BOOT-001"));
  if (bootstrap.mode !== "rapid-lite" || bootstrap.profile !== "hotel-lite") hardBlocks.push(finding("RL-BOOT-002"));
  if (!isPlaceholder(bootstrap.framework_ref) && !isPinnedFrameworkRef(bootstrap.framework_ref)) {
    if (handoff.enforce_pinned_ref === true || frameworkLock?.enforce_pinned_ref === true) {
      hardBlocks.push(finding("RL-BOOT-003"));
    } else {
      warnings.push(finding("RL-BOOT-003", {}, WARN_MESSAGES));
    }
  }

  // 2. RPS / Repository Premise Spec preflight
  if (!hasPremiseReference({ repoSpec, handoff })) hardBlocks.push(finding("RL-RPS-001"));
  if (isPremiseOwnerConfirmationRequired({ repoSpec, handoff }) && !hasPremiseOwnerConfirmation(handoff)) {
    hardBlocks.push(finding("RL-RPS-002"));
  }
  if (!hasRpsScope({ repoSpec, handoff })) hardBlocks.push(finding("RL-RPS-003"));
  if (handoff.legacy_source_boundary?.legacy_sources_are_truth === true) hardBlocks.push(finding("RL-RPS-004"));

  // 3. rapid-lite control handoff / minimal spec preflight
  if (isPlaceholder(handoff.repo_local_issue)) hardBlocks.push(finding("RL-GOAL-002"));
  if (isPlaceholder(owner.role) || isPlaceholder(owner.actor) || isPlaceholder(handoff.next_role)) {
    hardBlocks.push(finding("RL-GOAL-004"));
  }
  if (!hasMinimalSpecBoundary({ handoff, cell, allowedPaths, forbiddenPaths, validation })) {
    hardBlocks.push(finding("RL-SPEC-004"));
  }
  if (!hasSpecReviewState(handoff)) hardBlocks.push(finding("RL-SPEC-005"));

  // 4. cell boundary
  if (isPlaceholder(cellId)) hardBlocks.push(finding("RL-CELL-001"));
  if (allowedPaths.length === 0) hardBlocks.push(finding("RL-CELL-002"));
  if (forbiddenPaths.length === 0) hardBlocks.push(finding("RL-CELL-003"));
  if (stopConditions.length === 0) hardBlocks.push(finding("RL-CELL-004"));
  const protectedSurfaceContext = protectedSurfaceCellContext({ handoff, cell });
  if (isProtectedStop({ matrix, profile: bootstrap.profile, cell: protectedSurfaceContext, cellType })) hardBlocks.push(finding("RL-CELL-006"));

  // 5. PR diff scope
  const declaredHead = firstPresent(
    handoff.pr_head_sha,
    handoff.PR_head_SHA,
    handoff.expected_pr_head_sha,
    validation.pr_head_sha,
    validation.PR_head_SHA,
    validation.expected_pr_head_sha,
  );
  const expectedHead = firstPresent(input.actualHead, declaredHead);
  if (isPlaceholder(expectedHead)) hardBlocks.push(finding("RL-PR-001"));
  if (!isPlaceholder(input.actualHead) && !isPlaceholder(declaredHead) && String(input.actualHead) !== String(declaredHead)) {
    hardBlocks.push(finding("RL-PR-004", {
      message: `Declared PR head ${declaredHead} does not match GitHub runtime PR head ${input.actualHead}.`,
    }));
  }

  for (const file of changedFiles) {
    if (allowedPaths.length > 0 && !matchesAnyGlob(file, allowedPaths)) {
      hardBlocks.push(finding("RL-PR-002", { message: `${file} is outside cell.allowed_paths.`, path: file }));
    }
    if (forbiddenPaths.length > 0 && matchesAnyGlob(file, forbiddenPaths)) {
      hardBlocks.push(finding("RL-PR-003", { message: `${file} matches cell.forbidden_paths.`, path: file }));
    }
  }

  // 6. validation evidence
  const requiredEvidence = asArray(validation.required_evidence);
  if (requiredEvidence.length === 0 || validation.evidence_file_required === true && !input.validationPath) {
    hardBlocks.push(finding("RL-EVID-001"));
  }
  for (const placeholderPath of findPlaceholderPaths(requiredEvidence, "validation.required_evidence")) {
    hardBlocks.push(finding("RL-EVID-002", { path: placeholderPath }));
  }
  if (validationArtifact !== undefined) {
    for (const placeholderPath of findPlaceholderPaths(validationArtifact, "validation")) {
      hardBlocks.push(finding("RL-EVID-002", { path: placeholderPath }));
    }
  }

  // 7. owner decision / head match
  const declaredApprovalClass = firstPresent(handoff?.authority?.approval_class, handoff.approval_class);
  const declaredOwnerRequired = firstPresent(handoff?.authority?.owner_decision_required, handoff.owner_decision_required);
  const protectedOperationMissingRegistry = [
    "PROTECTED_OWNER_DECISION", "SCHEMA_MIGRATION", "RUNTIME_RUNNER_ACTIVATION",
    "PROVIDER_AUN_ACTIVATION", "WORKFLOW_PROTECTION", "SECRET_MUTATION", "DEPLOY",
    "EXTERNAL_SEND", "ENROLLMENT_FLEET_CUTOVER", "AUTHORITY_MUTATION",
  ].includes(authority.operation_code) && authority.protected_surface_refs.length === 0;
  if (
    !isPlaceholder(declaredApprovalClass) && declaredApprovalClass !== authority.approval_class ||
    typeof declaredOwnerRequired === "boolean" && declaredOwnerRequired !== gatePlan.owner_decision_required ||
    protectedOperationMissingRegistry || authority.result_code === "UNKNOWN_OPERATION_CODE"
  ) {
    hardBlocks.push(finding("RL-AUTH-001"));
  }
  const ownerDecisionRequired = gatePlan.owner_decision_required;
  const ownerDecisionRequiredNow = isOwnerDecisionRequiredNow({ handoff, ownerDecision });
  const finalOwnerApproval = hasFinalOwnerApproval(ownerDecision);
  if (ownerDecisionRequired && !finalOwnerApproval && ownerDecisionRequiredNow) {
    hardBlocks.push(finding("RL-MERGE-001"));
  } else if (ownerDecisionRequired && !finalOwnerApproval) {
    warnings.push(finding("RL-MERGE-W001", {}, WARN_MESSAGES));
  }
  const ownerHead = ownerDecisionHead(ownerDecision);
  if (!isPlaceholder(expectedHead) && !isPlaceholder(ownerHead) && String(expectedHead) !== String(ownerHead)) {
    hardBlocks.push(finding("RL-MERGE-002"));
  }

  if (!hasAcceptanceOrTestDetail(handoff)) warnings.push(finding("RL-SPEC-W001", {}, WARN_MESSAGES));
  if (changedFiles.length > RAPID_LITE_CHANGED_FILE_WARN_LIMIT) warnings.push(finding("RL-PR-W001", {}, WARN_MESSAGES));
  if (input.validationPath && isManualOnlyValidation(validationArtifact)) {
    warnings.push(finding("RL-EVID-W002", {}, WARN_MESSAGES));
  }

  return report({
    matrixPath,
    handoffPath,
    bootstrap,
    cellId,
    cellType,
    exactHead: expectedHead,
    exactHeadSource: !isPlaceholder(input.actualHead) ? "github_runtime" : !isPlaceholder(declaredHead) ? "declared_evidence" : null,
    hardBlocks: uniqueFindings(hardBlocks),
    warnings: uniqueFindings(warnings),
    evidence,
    authority,
    gatePlan,
  });
}

function report({ matrixPath, handoffPath, bootstrap, cellId, cellType, exactHead = null, exactHeadSource = null, hardBlocks, warnings, evidence, authority, gatePlan }) {
  const verdict = hardBlocks.length > 0 ? "BLOCKED" : warnings.length > 0 ? "PASS_WITH_WARN" : "PASS";
  const currentPhase = currentPhaseFromFindings(hardBlocks);
  return {
    schema: SCHEMA,
    mode: bootstrap.mode,
    profile: bootstrap.profile,
    bootstrap,
    current_phase: verdict === "PASS" || verdict === "PASS_WITH_WARN" ? "EXECUTION_READY" : currentPhase,
    allowed_next_phases: verdict === "PASS" || verdict === "PASS_WITH_WARN" ? ["EXECUTION_READY"] : allowedNextPhases(currentPhase),
    forbidden_next_phases: hardBlocks.length > 0 ? FORBIDDEN_WHEN_BLOCKED : [],
    verdict,
    would_block: verdict === "BLOCKED",
    handoff_ref: handoffPath,
    matrix_ref: matrixPath,
    cell_id: cellId,
    cell_type: cellType,
    exact_head_sha: exactHead,
    exact_head_source: exactHeadSource,
    authority: authority ?? null,
    gate_plan: gatePlan ?? null,
    hard_blocks: hardBlocks,
    warnings,
    evidence: uniqueEvidence(evidence),
    required_next_actions: requiredNextActions(hardBlocks, warnings),
  };
}

function failureReport({ code, message, matrixPath = "", handoffPath = "" }) {
  return {
    schema: SCHEMA,
    mode: "rapid-lite",
    profile: "UNKNOWN",
    bootstrap: {
      mode: "rapid-lite",
      profile: "UNKNOWN",
      framework_ref: null,
      repo_spec_ref: null,
      premise_confirmed: false,
    },
    current_phase: "BLOCKED",
    allowed_next_phases: [],
    forbidden_next_phases: FORBIDDEN_WHEN_BLOCKED,
    verdict: "FAILURE",
    would_block: false,
    handoff_ref: handoffPath,
    matrix_ref: matrixPath,
    cell_id: null,
    cell_type: null,
    hard_blocks: [],
    warnings: [],
    evidence: [],
    required_next_actions: [
      {
        code,
        message,
      },
    ],
  };
}

function buildBootstrap({ matrix, repoSpec, repoSpecPath, frameworkLock, handoff }) {
  const mode = firstPresent(handoff?.mode, frameworkLock?.mode, matrix?.mode) ?? "UNKNOWN";
  const profile = firstPresent(handoff?.profile, frameworkLock?.profile) ?? "UNKNOWN";
  const frameworkRef = firstPresent(
    handoff?.framework_ref,
    handoff?.framework_lock_ref,
    frameworkLock?.framework_ref,
    frameworkLock?.ref,
    frameworkLock?.canonical_core,
  ) ?? null;
  const repoSpecRef = firstPresent(
    handoff?.repo_spec_ref,
    handoff?.premise_ref,
    repoSpec?.repo_spec_ref,
    repoSpec?.canonical_core,
    repoSpec ? repoSpecPath : undefined,
  ) ?? null;
  return {
    mode,
    profile,
    framework_ref: frameworkRef,
    repo_spec_ref: repoSpecRef,
    premise_confirmed: hasPremiseOwnerConfirmation(handoff),
  };
}

function finding(itemId, overrides = {}, source = HARD_MESSAGES) {
  const [code, message, defaultPath] = source[itemId];
  return {
    item_id: itemId,
    code,
    message: overrides.message ?? message,
    path: overrides.path ?? defaultPath,
  };
}

function requiredNextActions(hardBlocks, warnings) {
  if (hardBlocks.length === 0 && warnings.length === 0) return [];
  return [...hardBlocks, ...warnings].map((finding) => ({
    item_id: finding.item_id,
    action: finding.message,
  }));
}

function readInput(options) {
  const matrixPath = typeof options.matrix === "string"
    ? options.matrix
    : existsSync(DEFAULT_MATRIX)
      ? DEFAULT_MATRIX
      : null;
  const handoffPath = typeof options.handoff === "string" ? options.handoff : null;
  const changedFilesPath = typeof options["changed-files"] === "string" ? options["changed-files"] : null;
  const ownerDecisionPath = typeof options["owner-decision"] === "string" ? options["owner-decision"] : null;
  const validationPath = typeof options.validation === "string" ? options.validation : null;
  const repoSpecPath = typeof options["repo-spec"] === "string"
    ? options["repo-spec"]
    : existsSync(DEFAULT_REPO_SPEC)
      ? DEFAULT_REPO_SPEC
      : null;
  const frameworkLockPath = typeof options["framework-lock"] === "string"
    ? options["framework-lock"]
    : existsSync(DEFAULT_FRAMEWORK_LOCK)
      ? DEFAULT_FRAMEWORK_LOCK
      : null;

  if (!matrixPath) {
    return { error: failureReport({ code: "missing_matrix", message: "--matrix is required when the default matrix does not exist." }) };
  }

  const matrixResult = readOptionalStructuredInput(matrixPath, "matrix_parse_error", { matrixPath, handoffPath: handoffPath ?? "" }, true);
  if (matrixResult.error) return { error: matrixResult.error };

  const handoffResult = handoffPath
    ? readOptionalStructuredInput(handoffPath, "handoff_parse_error", { matrixPath, handoffPath }, true)
    : { value: null };
  if (handoffResult.error) return { error: handoffResult.error };

  const repoSpecResult = repoSpecPath
    ? readOptionalStructuredInput(repoSpecPath, "repo_spec_parse_error", { matrixPath, handoffPath: handoffPath ?? "" }, false)
    : { value: null };
  if (repoSpecResult.error) return { error: repoSpecResult.error };

  const frameworkLockResult = frameworkLockPath
    ? readOptionalStructuredInput(frameworkLockPath, "framework_lock_parse_error", { matrixPath, handoffPath: handoffPath ?? "" }, false)
    : { value: null };
  if (frameworkLockResult.error) return { error: frameworkLockResult.error };

  const ownerDecisionResult = ownerDecisionPath
    ? readOptionalStructuredInput(ownerDecisionPath, "owner_decision_parse_error", { matrixPath, handoffPath: handoffPath ?? "" }, true)
    : { value: undefined };
  if (ownerDecisionResult.error) return { error: ownerDecisionResult.error };

  const validationResult = validationPath
    ? readOptionalStructuredInput(validationPath, "validation_parse_error", { matrixPath, handoffPath: handoffPath ?? "" }, true)
    : { value: undefined };
  if (validationResult.error) return { error: validationResult.error };

  return {
    input: {
      matrix: matrixResult.value,
      matrixPath,
      handoff: handoffResult.value,
      handoffPath,
      repoSpec: repoSpecResult.value,
      repoSpecPath: repoSpecPath ?? "",
      frameworkLock: frameworkLockResult.value,
      frameworkLockPath: frameworkLockPath ?? "",
      changedFiles: readChangedFiles(changedFilesPath),
      changedFilesPath,
      actualHead: typeof options["actual-head"] === "string" ? options["actual-head"] : null,
      ownerDecisionArtifact: ownerDecisionResult.value,
      ownerDecisionPath,
      validationArtifact: validationResult.value,
      validationPath,
    },
  };
}

function readOptionalStructuredInput(filePath, errorCode, refs, required) {
  if (!existsSync(filePath)) {
    if (!required) return { value: null };
    return {
      error: failureReport({
        code: errorCode,
        message: `File not found: ${filePath}`,
        ...refs,
      }),
    };
  }
  try {
    return { value: readStructuredFile(filePath) };
  } catch (error) {
    return {
      error: failureReport({
        code: errorCode,
        message: errorMessage(error),
        ...refs,
      }),
    };
  }
}

function readChangedFiles(filePath) {
  if (!filePath) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .sort((a, b) => a.localeCompare(b));
}

function hasFrameworkReference({ frameworkLock, handoff }) {
  return Boolean(frameworkLock) ||
    isObject(handoff?.canonical_control_handoff) ||
    !isPlaceholder(handoff?.framework_ref) ||
    !isPlaceholder(handoff?.framework_lock_ref) ||
    !isPlaceholder(handoff?.matrix_ref);
}

function hasPremiseReference({ repoSpec, handoff }) {
  return Boolean(repoSpec) ||
    !isPlaceholder(handoff?.repo_spec_ref) ||
    !isPlaceholder(handoff?.premise_ref);
}

function isPremiseOwnerConfirmationRequired({ repoSpec, handoff }) {
  return handoff?.owner_confirmation_required === true ||
    handoff?.premise_owner_confirmation_required === true ||
    handoff?.owner_confirmation?.required === true ||
    repoSpec?.confirmation_evidence?.rps_readiness?.required === true;
}

function hasPremiseOwnerConfirmation(handoff) {
  return !isPlaceholder(handoff?.owner_confirmation_ref) ||
    !isPlaceholder(handoff?.premise_confirmation_ref) ||
    !isPlaceholder(handoff?.owner_confirmation?.ref) ||
    !isPlaceholder(handoff?.owner_confirmation?.evidence_ref);
}

function hasRpsScope({ repoSpec, handoff }) {
  const rpsScope = handoff?.rps_scope;
  const shirubeScope = handoff?.shirube_scope;
  const handoffOwns = presentArray(rpsScope?.shirube_owns) ||
    presentArray(rpsScope?.owns) ||
    presentArray(shirubeScope?.owns);
  const handoffDoesNotOwn = presentArray(rpsScope?.shirube_does_not_own) ||
    presentArray(rpsScope?.does_not_own) ||
    presentArray(shirubeScope?.does_not_own);
  const repoSpecOwns = presentArray(repoSpec?.scope);
  const repoSpecDoesNotOwn = presentArray(repoSpec?.non_goals) || presentArray(repoSpec?.non_scope);
  const canonicalScope = isObject(handoff?.canonical_control_handoff) &&
    presentArray(handoff?.allowed_paths) &&
    presentArray(handoff?.forbidden_paths) &&
    presentArray(handoff?.forbidden_operations);
  return canonicalScope || (handoffOwns && handoffDoesNotOwn) || (repoSpecOwns && repoSpecDoesNotOwn);
}

function hasMinimalSpecBoundary({ handoff, cell, allowedPaths, forbiddenPaths, validation }) {
  const canonicalV3 = isObject(handoff?.canonical_control_handoff);
  return !isPlaceholder(cell.goal) &&
    presentArray(cell.non_scope) &&
    (canonicalV3 || !isPlaceholder(cell.risk_class)) &&
    (canonicalV3 || !isPlaceholder(cell.cell_type)) &&
    allowedPaths.length > 0 &&
    forbiddenPaths.length > 0 &&
    presentArray(validation.required_commands);
}

function hasSpecReviewState(handoff) {
  return !isPlaceholder(handoff.spec_review_state) ||
    !isPlaceholder(handoff.handoff_review_state) ||
    handoff.ready_for_implementation === true ||
    handoff.handoff_ready_for_implementation === true ||
    handoff?.handoff_review?.ready_for_implementation === true;
}

function isProtectedStop({ matrix, profile, cell, cellType }) {
  if (cellType === "protected_stop") return true;
  const forbiddenSurfaces = new Set(asArray(matrix?.profiles?.[profile]?.hard_forbidden_surfaces).flatMap(normalizeSurface));
  const requested = [
    ...surfacesFrom(cell.protected_surfaces),
    ...surfacesFrom(cell.requested_surfaces),
    ...surfacesFrom(cell.surfaces),
    ...surfacesFrom(cell.requested_operations),
    ...surfacesFrom(cell.forbidden_operations),
  ];
  return requested.some((surface) => forbiddenSurfaces.has(surface));
}

function protectedSurfaceCellContext({ handoff, cell }) {
  const forbiddenOperations = isObject(handoff?.canonical_control_handoff)
    ? []
    : [handoff?.forbidden_operations, cell.forbidden_operations];
  return {
    protected_surfaces: [handoff?.protected_surfaces, cell.protected_surfaces],
    requested_surfaces: [handoff?.requested_surfaces, cell.requested_surfaces],
    surfaces: [handoff?.surfaces, cell.surfaces],
    requested_operations: [handoff?.requested_operations, cell.requested_operations],
    forbidden_operations: forbiddenOperations,
  };
}

function isOwnerDecisionRequired({ matrix, profile, handoff, ownerDecision }) {
  return ownerDecision.required_now === true ||
    ownerDecision.required_for_current_phase === true ||
    ownerDecision.merge_ready_claimed === true ||
    handoff.merge_ready_claimed === true ||
    handoff.owner_decision_required_now === true ||
    handoff.owner_decision_required === true ||
    handoff.required_owner_decision_now === true ||
    handoff.current_phase === "MERGE_READY" ||
    handoff.phase === "MERGE_READY" ||
    handoff.lifecycle_phase === "MERGE_READY" ||
    ownerDecision.required_before_merge === true ||
    handoff.owner_decision_required === true ||
    handoff.required_owner_decision_for_merge === true ||
    handoff?.owner_decision?.required === true ||
    matrix?.profiles?.[profile]?.required_owner_decision_for_merge === true ||
    asArray(matrix?.artifact_policy?.non_optional_invariants).includes("owner_decision");
}

function isOwnerDecisionRequiredNow({ handoff, ownerDecision }) {
  const phase = String(firstPresent(
    ownerDecision.current_phase,
    ownerDecision.phase,
    handoff.current_phase,
    handoff.phase,
    handoff.lifecycle_phase,
  ) ?? "").toUpperCase();
  return ownerDecision.required_now === true ||
    ownerDecision.required_for_current_phase === true ||
    ownerDecision.merge_ready_claimed === true ||
    handoff.merge_ready_claimed === true ||
    handoff.owner_decision_required_now === true ||
    handoff.required_owner_decision_now === true ||
    ["MERGE_READY", "MERGED", "RELEASE_READY", "COMPLETE", "CONTROL_COMPLETE"].includes(phase);
}

function hasFinalOwnerApproval(ownerDecision) {
  if (!isObject(ownerDecision)) return false;
  if (ownerDecision.approval_granted === false) return false;
  if (hasPendingOwnerDecision(ownerDecision)) return false;
  const head = ownerDecisionHead(ownerDecision);
  if (isPlaceholder(head)) return false;
  const decision = decisionStatus(ownerDecision);
  if (ownerDecision.approval_granted === true) return true;
  return [
    "APPROVED",
    "APPROVED_EXACT_HEAD",
    "APPROVED_PILOT_EXCEPTION",
    "OWNER_EXCEPTION",
    "APPROVED_EXCEPTION",
  ].includes(decision);
}

function hasPendingOwnerDecision(ownerDecision) {
  if (!isObject(ownerDecision)) return false;
  if (ownerDecision.approval_granted === false) return true;
  const decision = decisionStatus(ownerDecision);
  if ([
    "PENDING",
    "PENDING_OWNER_FINAL_DECISION",
    "PENDING_FINAL_OWNER_DECISION",
    "OWNER_DECISION_PENDING",
  ].includes(decision)) return true;
  return hasOwnerDecisionReference(ownerDecision) && isPlaceholder(ownerDecisionHead(ownerDecision));
}

function hasOwnerDecisionReference(ownerDecision, ownerDecisionPath) {
  if (ownerDecisionPath) return true;
  return !isPlaceholder(ownerDecision.decision_ref) ||
    !isPlaceholder(ownerDecision.ref) ||
    !isPlaceholder(ownerDecision.url) ||
    !isPlaceholder(ownerDecision.exact_head_sha) ||
    !isPlaceholder(ownerDecision.head_sha) ||
    !isPlaceholder(ownerDecision.target_head);
}

function ownerDecisionHead(ownerDecision) {
  return firstPresent(ownerDecision?.exact_head_sha, ownerDecision?.head_sha, ownerDecision?.target_head);
}

function decisionStatus(ownerDecision) {
  return String(firstPresent(ownerDecision?.decision, ownerDecision?.status, ownerDecision?.verdict) ?? "").trim().toUpperCase();
}

function surfacesFrom(value) {
  if (Array.isArray(value)) return value.flatMap(surfacesFrom);
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, entry]) => {
      if (entry === true) return normalizeSurface(key);
      return [...normalizeSurface(key), ...surfacesFrom(entry)];
    });
  }
  return normalizeSurface(value);
}

function normalizeSurface(value) {
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  return trimmed ? [trimmed, trimmed.toLowerCase()] : [];
}

function hasAcceptanceOrTestDetail(handoff) {
  return presentArray(handoff.acceptance_criteria) ||
    presentArray(handoff.tests) ||
    presentArray(handoff.test_plan) ||
    presentArray(handoff.cell?.acceptance_criteria) ||
    presentArray(handoff.validation?.acceptance_tests) ||
    presentArray(handoff.validation?.test_expectations);
}

function isManualOnlyValidation(value) {
  if (!isObject(value)) return false;
  const hasManual = value.manual === true ||
    presentArray(value.manual_notes) ||
    presentArray(value.notes) ||
    typeof value.manual_notes === "string";
  const hasExecutable = presentArray(value.commands) ||
    presentArray(value.required_commands) ||
    presentArray(value.results) ||
    presentArray(value.validation_results);
  return hasManual && !hasExecutable;
}

function findPlaceholderPaths(value, path) {
  if (isPlaceholder(value)) return [path];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findPlaceholderPaths(entry, `${path}[${index}]`));
  }
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, entry]) => findPlaceholderPaths(entry, `${path}.${key}`));
  }
  return [];
}

function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^<[^>]+>$/.test(trimmed)) return true;
  return /^(pending|pending-.+|tbd|todo|null|none|n\/a|replace this.*)$/i.test(trimmed);
}

function isPinnedFrameworkRef(value) {
  if (typeof value !== "string") return false;
  return /@[a-f0-9]{7,40}\b/i.test(value) || /@v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/.test(value);
}

function currentPhaseFromFindings(hardBlocks) {
  const itemIds = new Set(hardBlocks.map((finding) => finding.item_id));
  if (hasAnyPrefix(itemIds, "RL-BOOT-")) return "BLOCKED";
  if (hasAnyPrefix(itemIds, "RL-RPS-")) return "PREMISE_REQUIRED";
  if (itemIds.has("RL-GOAL-001") || hasAnyPrefix(itemIds, "RL-SPEC-")) return "HANDOFF_REQUIRED";
  if (hardBlocks.length > 0) return "BLOCKED";
  return "EXECUTION_READY";
}

function allowedNextPhases(currentPhase) {
  if (currentPhase === "PREMISE_REQUIRED") return ["PREMISE_REQUIRED"];
  if (currentPhase === "HANDOFF_REQUIRED") return ["HANDOFF_REQUIRED"];
  return [];
}

function hasAnyPrefix(values, prefix) {
  return [...values].some((value) => value.startsWith(prefix));
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function asStringArray(value) {
  return asArray(value).filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
}

function presentArray(value) {
  return asArray(value).some((entry) => {
    if (Array.isArray(entry)) return presentArray(entry);
    if (isObject(entry)) return Object.keys(entry).length > 0;
    return !isPlaceholder(entry);
  });
}

function mergeObjects(base, override) {
  return {
    ...(isObject(base) ? base : {}),
    ...(isObject(override) ? override : {}),
  };
}

function firstPresent(...values) {
  return values.find((value) => !isPlaceholder(value));
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueFindings(findings) {
  const seen = new Set();
  const unique = [];
  for (const finding of findings) {
    const key = `${finding.item_id}\0${finding.code}\0${finding.path}\0${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
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

function printPlain(result) {
  process.stdout.write(`${result.verdict} ${result.current_phase} ${result.cell_id ?? "UNKNOWN"} ${result.cell_type ?? "UNKNOWN"} hard_blocks=${result.hard_blocks.length} warnings=${result.warnings.length}\n`);
}

export function runGateContractCheck(argv = process.argv.slice(2)) {
  const { options } = parseArgs(argv);
  const format = options.format;
  if (format !== undefined && format !== "json") {
    return {
      result: failureReport({
        code: "unsupported_format",
        message: `Unsupported format: ${String(format)}. Only --format json is supported.`,
      }),
      exitCode: 1,
      json: true,
    };
  }
  const loaded = readInput(options);
  if (loaded.error) return { result: loaded.error, exitCode: 1, json: true };
  const result = buildGateContractReport(loaded.input);
  return {
    result,
    exitCode: result.verdict === "FAILURE" ? 1 : 0,
    json: format === "json",
  };
}

if (isMain(import.meta.url)) {
  const { result, exitCode, json } = runGateContractCheck();
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printPlain(result);
  }
  process.exitCode = exitCode;
}
