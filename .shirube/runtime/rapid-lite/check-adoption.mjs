#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";

const SCHEMA = "shirube-adoption-check/v1";
const LANE = "adoption_intake";
const DISPOSITIONS = ["greenfield_initialize", "retrofit_accelerate", "retrofit_recover"];
const BLOCKED_NEXT = ["EXECUTION_READY", "IMPLEMENTED", "MERGED", "RELEASED"];

const FLOW = [
  "ADOPTION_INTAKE",
  "EXISTING_STATE_SCAN",
  "CLASSIFICATION",
  "RPS_DRAFT_FROM_CURRENT_REALITY",
  "RPS_OWNER_CONFIRMATION",
  "GAP_FILL_OR_RECONCILIATION_PLAN",
  "NEXT_SAFE_CELL_OR_CONTROL_HANDOFF",
  "ADOPTION_READY",
];

const BLOCKERS = {
  "ADOPT-001": ["missing_adoption_plan", "Adoption intake plan is missing or invalid."],
  "ADOPT-002": ["invalid_adoption_intake_lane", "Adoption intake must use lane: adoption_intake."],
  "ADOPT-003": ["invalid_disposition", "Disposition must be greenfield_initialize, retrofit_accelerate, or retrofit_recover."],
  "ADOPT-005": ["owner_missing", "owner.role and owner.actor are required."],
  "ADOPT-007": ["no_owner_confirmed_direction", "Owner-confirmed direction is required for retrofit adoption."],
  "ADOPT-008": ["missing_existing_state_scan", "Existing-state scan must be present; empty scan means greenfield_initialize."],
  "RPS-001": ["missing_rps_draft_from_current_reality", "RPS draft from current reality is required before adoption is ready."],
  "RPS-002": ["missing_rps_owner_confirmation", "Owner confirmation for RPS direction is required."],
  "GAP-001": ["missing_gap_fill_or_reconciliation_plan", "Retrofit adoption requires a gap-fill or reconciliation plan before execution."],
  "HANDOFF-001": ["missing_next_safe_cell_or_control_handoff", "Next safe Cell or control handoff is required before adoption is ready."],
  "RECOVER-001": ["material_drift", "Material drift requires retrofit_recover."],
  "RECOVER-002": ["legacy_as_truth", "Legacy material may inform adoption but cannot be authority before reconciliation."],
  "RECOVER-003": ["llm_as_truth", "LLM summary or reconciliation cannot be authority without owner-confirmed RPS/control handoff."],
  "RECOVER-004": ["unsafe_change", "Unsafe or protected change requires retrofit_recover before execution."],
};

const WARNINGS = {
  "ADOPT-W001": ["stale_existing_state_scan", "Existing-state scan appears stale."],
  "ADOPT-W002": ["tests_absent_or_partial", "Existing tests are absent or partial."],
  "ADOPT-W003": ["specs_partial", "Existing specs are partial but captured as input-only."],
  "ADOPT-W004": ["high_unknown_count", "Existing-state scan has many unknowns."],
  "GREEN-W001": ["greenfield_artifacts_expected", "Greenfield initialization still needs RPS, owner confirmation, and handoff artifacts."],
  "RETRO-W001": ["shirube_gap_fill_required", "Retrofit repository appears healthy; only Shirube artifact gap-fill is required."],
};

export function buildAdoptionReport(input) {
  const blockers = [];
  const warnings = [];
  const evidence = [];
  const plan = input.adoptionPlan;
  const existingState = normalizeExistingState(input);
  const hasScan = input.hasExistingStateScan;

  if (input.adoptionPlanPath) evidence.push({ code: "adoption_plan", source: "file", detail: input.adoptionPlanPath });
  if (input.existingStatePath) evidence.push({ code: "existing_state_scan", source: "file", detail: input.existingStatePath });
  if (input.legacyInventoryPath) evidence.push({ code: "legacy_inventory", source: "file", detail: input.legacyInventoryPath });
  if (input.repoSpecPath) evidence.push({ code: "repo_spec", source: "file", detail: input.repoSpecPath });
  if (input.specReconciliationPath) evidence.push({ code: "spec_reconciliation", source: "file", detail: input.specReconciliationPath });
  if (input.handoffPath) evidence.push({ code: "control_handoff", source: "file", detail: input.handoffPath });
  if (input.changedFilesPath) evidence.push({ code: "changed_files", source: "file", detail: input.changedFilesPath });

  if (!isObject(plan) || !nonEmptyString(plan.schema_version) || !nonEmptyString(plan.adoption_id)) {
    blockers.push(finding("ADOPT-001", { path: input.adoptionPlanPath || "adoption_plan" }));
  }

  if (plan && plan.lane && plan.lane !== LANE) {
    blockers.push(finding("ADOPT-002", { path: "adoption_plan.lane" }));
  }

  if (!hasOwner(plan)) {
    blockers.push(finding("ADOPT-005", { path: "adoption_plan.owner" }));
  }

  if (!hasScan) {
    blockers.push(finding("ADOPT-008", { path: "existing_state_scan" }));
  }

  const scanIsEmpty = isExistingStateEmpty(existingState);
  const recoveryReasons = recoverySignals({ input, existingState });
  const disposition = classifyDisposition({ plan, scanIsEmpty, recoveryReasons });

  if (!DISPOSITIONS.includes(disposition)) {
    blockers.push(finding("ADOPT-003", { path: "disposition" }));
  }

  if (!scanIsEmpty && !hasOwnerConfirmedDirection({ plan, repoSpec: input.repoSpec, handoff: input.handoff }) && disposition !== "greenfield_initialize") {
    blockers.push(finding("ADOPT-007", { path: "owner_confirmation" }));
  }

  for (const reason of recoveryReasons) {
    blockers.push(recoveryFinding(reason));
  }

  const rpsPresent = hasRps(input.repoSpec, plan);
  const rpsConfirmed = hasRpsOwnerConfirmation({ plan, repoSpec: input.repoSpec, handoff: input.handoff });
  const gapPlanPresent = scanIsEmpty || hasGapFillOrReconciliationPlan({ plan, specReconciliation: input.specReconciliation });
  const handoffPresent = hasNextSafeCellOrHandoff({ plan, handoff: input.handoff, specReconciliation: input.specReconciliation });
  const artifactGapsAreExpected = disposition === "greenfield_initialize" || disposition === "retrofit_accelerate";

  if (!rpsPresent && !scanIsEmpty && !artifactGapsAreExpected) {
    blockers.push(finding("RPS-001", { path: "repo_spec" }));
  }
  if (rpsPresent && !rpsConfirmed && !artifactGapsAreExpected) {
    blockers.push(finding("RPS-002", { path: "repo_spec.confirmation" }));
  }
  if (!gapPlanPresent && !scanIsEmpty && !artifactGapsAreExpected) {
    blockers.push(finding("GAP-001", { path: "spec_reconciliation" }));
  }
  if (rpsPresent && rpsConfirmed && gapPlanPresent && !handoffPresent && !artifactGapsAreExpected) {
    blockers.push(finding("HANDOFF-001", { path: "handoff" }));
  }

  warnings.push(...warningSignals({ existingState, scanIsEmpty, rpsPresent, rpsConfirmed, gapPlanPresent, handoffPresent, input }));

  const uniqueBlockers = uniqueFindings(blockers);
  const uniqueWarnings = uniqueFindings(warnings);
  const verdict = uniqueBlockers.length > 0 ? "BLOCKED" : uniqueWarnings.length > 0 ? "PASS_WITH_WARN" : "PASS";
  const currentPhase = deriveCurrentPhase({
    plan,
    hasScan,
    scanIsEmpty,
    rpsPresent,
    rpsConfirmed,
    gapPlanPresent,
    handoffPresent,
    blockers: uniqueBlockers,
    disposition,
  });

  return {
    schema: SCHEMA,
    lane: LANE,
    disposition,
    current_phase: currentPhase,
    verdict,
    would_block: verdict === "BLOCKED",
    allowed_next_phases: allowedNextPhases(currentPhase, verdict),
    forbidden_next_phases: verdict === "BLOCKED" ? BLOCKED_NEXT : [],
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    evidence: uniqueEvidence(evidence),
    required_next_actions: requiredNextActions(uniqueBlockers, uniqueWarnings, currentPhase),
  };
}

function classifyDisposition({ plan, scanIsEmpty, recoveryReasons }) {
  if (recoveryReasons.length > 0) return "retrofit_recover";
  if (plan?.disposition && DISPOSITIONS.includes(plan.disposition)) {
    if (plan.disposition === "greenfield_initialize" && !scanIsEmpty) return "retrofit_accelerate";
    return plan.disposition;
  }
  if (scanIsEmpty) return "greenfield_initialize";
  return "retrofit_accelerate";
}

function normalizeExistingState(input) {
  const source = input.existingState ?? input.legacyInventory ?? input.adoptionPlan?.existing_state_scan ?? {};
  return isObject(source) ? source : {};
}

function isExistingStateEmpty(state) {
  const keys = [
    "specs",
    "implementation",
    "tests",
    "legacy_sources",
    "known_drift",
    "material_drift",
    "unsafe_changes",
    "llm_truth_claims",
    "unknowns",
  ];
  return keys.every((key) => !presentArray(state[key]) && !hasNestedEntries(state[key]));
}

function recoverySignals({ input, existingState }) {
  const signals = [];
  if (presentArray(existingState.material_drift) || presentArray(existingState.known_drift)) signals.push("material_drift");
  if (existingState.legacy_is_truth === true || input.adoptionPlan?.legacy_is_truth === true || hasLegacyAuthority(existingState)) signals.push("legacy_as_truth");
  if (existingState.llm_reconciliation_as_truth === true || presentArray(existingState.llm_truth_claims) || input.adoptionPlan?.llm_reconciliation_as_truth === true) signals.push("llm_as_truth");
  const changedFilesForUnsafeDetection = excludeAllowedWorkflowCaller(input.changedFiles, input.handoff);
  if (presentArray(existingState.unsafe_changes) || hasUnsafeChangedFiles(changedFilesForUnsafeDetection) || input.adoptionPlan?.unsafe_change_requested === true) signals.push("unsafe_change");
  return [...new Set(signals)];
}

function hasLegacyAuthority(state) {
  const sources = [
    ...asArray(state.legacy_sources),
    ...asArray(state.specs),
    ...asArray(state.docs),
    ...asArray(state.legacy_sources?.specs),
  ].filter(isObject);
  return sources.some((source) => source.authority === "truth" || source.authority === "canonical" || source.legacy_is_truth === true);
}

function excludeAllowedWorkflowCaller(files, handoff) {
  return files.filter((file) => !isAllowedThinWorkflowCaller(file, handoff));
}

function hasUnsafeChangedFiles(files) {
  return files.some((file) => matchesAnyGlob(file, [
    ".github/workflows/**",
    "deploy/**",
    "**/migrations/**",
    "**/migration/**",
    "**/auth/**",
    "**/permissions/**",
    "**/branch-protection/**",
    "**/ruleset/**",
  ]));
}

function isAllowedThinWorkflowCaller(file, handoff) {
  if (!file.startsWith(".github/workflows/")) return false;
  const cell = isObject(handoff?.cell) ? handoff.cell : {};
  const allowedPaths = asStringArray(cell.allowed_paths);
  if (!allowedPaths.includes(file)) return false;
  const declaredSurfaces = surfaceValues(handoff?.protected_surfaces)
    .concat(surfaceValues(cell.protected_surfaces))
    .map((value) => value.toLowerCase());
  return declaredSurfaces.includes("active workflows") || declaredSurfaces.includes("workflow");
}

function hasRps(repoSpec, plan) {
  if (isObject(repoSpec) && (nonEmptyString(repoSpec.schema_version) || nonEmptyString(repoSpec.repo) || nonEmptyString(repoSpec.repo_id))) return true;
  return nonEmptyString(plan?.repo_spec_ref) || nonEmptyString(plan?.premise_ref);
}

function hasRpsOwnerConfirmation({ plan, repoSpec, handoff }) {
  return nonEmptyString(plan?.owner_confirmation_ref) ||
    nonEmptyString(plan?.premise_confirmation_ref) ||
    nonEmptyString(handoff?.owner_confirmation_ref) ||
    nonEmptyString(handoff?.premise_confirmation_ref) ||
    repoSpec?.confirmation_evidence?.rps_readiness?.verdict === "CONFIRMED" ||
    repoSpec?.rps_confirmation?.verdict === "CONFIRMED" ||
    repoSpec?.owner_confirmation?.verdict === "CONFIRMED";
}

function hasOwnerConfirmedDirection({ plan, repoSpec, handoff }) {
  return hasRpsOwnerConfirmation({ plan, repoSpec, handoff }) ||
    nonEmptyString(plan?.owner_direction_ref) ||
    nonEmptyString(handoff?.owner_decision?.decision_ref);
}

function hasGapFillOrReconciliationPlan({ plan, specReconciliation }) {
  if (isObject(specReconciliation) && (nonEmptyString(specReconciliation.schema_version) || nonEmptyString(specReconciliation.reconciliation_id))) return true;
  return nonEmptyString(plan?.gap_fill_plan_ref) ||
    nonEmptyString(plan?.spec_reconciliation_ref) ||
    presentArray(plan?.gap_fill_plan) ||
    presentArray(plan?.reconciliation_plan);
}

function hasNextSafeCellOrHandoff({ plan, handoff, specReconciliation }) {
  if (isObject(handoff) && (nonEmptyString(handoff.control_handoff_id) || nonEmptyString(handoff.cell?.["CELL-ID"]) || nonEmptyString(handoff.cell_id))) return true;
  return nonEmptyString(plan?.control_handoff_ref) ||
    nonEmptyString(plan?.next_safe_cell_ref) ||
    nonEmptyString(plan?.next_safe_cell) ||
    nonEmptyString(specReconciliation?.next_safe_cell) ||
    nonEmptyString(specReconciliation?.control_handoff_ref) ||
    presentArray(specReconciliation?.outputs?.next_safe_cell);
}

function warningSignals({ existingState, scanIsEmpty, rpsPresent, rpsConfirmed, gapPlanPresent, handoffPresent, input }) {
  const warnings = [];
  if (isStale(existingState.observed_at, input.adoptionPlan?.stale_after_days ?? 30)) {
    warnings.push(finding("ADOPT-W001", { path: "existing_state_scan.observed_at" }, WARNINGS));
  }
  if (hasAbsentOrPartialTests(existingState)) {
    warnings.push(finding("ADOPT-W002", { path: "existing_state_scan.tests" }, WARNINGS));
  }
  if (hasPartialSpecs(existingState)) {
    warnings.push(finding("ADOPT-W003", { path: "existing_state_scan.specs" }, WARNINGS));
  }
  if (asArray(existingState.unknowns).length >= Number(input.adoptionPlan?.high_unknown_count_threshold ?? 3)) {
    warnings.push(finding("ADOPT-W004", { path: "existing_state_scan.unknowns" }, WARNINGS));
  }
  if (scanIsEmpty && (!rpsPresent || !rpsConfirmed || !handoffPresent)) {
    warnings.push(finding("GREEN-W001", { path: "adoption_intake" }, WARNINGS));
  }
  if (!scanIsEmpty && (rpsPresent === false || rpsConfirmed === false || gapPlanPresent === false || handoffPresent === false)) {
    warnings.push(finding("RETRO-W001", { path: "adoption_intake" }, WARNINGS));
  }
  return warnings;
}

function deriveCurrentPhase({ plan, hasScan, scanIsEmpty, rpsPresent, rpsConfirmed, gapPlanPresent, handoffPresent, blockers, disposition }) {
  const blockerCodes = new Set(blockers.map((blocker) => blocker.code));
  if (blockerCodes.has("missing_adoption_plan") || blockerCodes.has("invalid_adoption_intake_lane")) return "ADOPTION_INTAKE";
  if (!hasScan) return "EXISTING_STATE_SCAN";
  if (!DISPOSITIONS.includes(disposition)) return "CLASSIFICATION";
  if (!rpsPresent) return "RPS_DRAFT_FROM_CURRENT_REALITY";
  if (!rpsConfirmed) return "RPS_OWNER_CONFIRMATION";
  if (!gapPlanPresent) return scanIsEmpty ? "NEXT_SAFE_CELL_OR_CONTROL_HANDOFF" : "GAP_FILL_OR_RECONCILIATION_PLAN";
  if (!handoffPresent) return "NEXT_SAFE_CELL_OR_CONTROL_HANDOFF";
  if (blockers.length > 0) return "GAP_FILL_OR_RECONCILIATION_PLAN";
  return plan?.current_phase && FLOW.includes(plan.current_phase) ? plan.current_phase : "ADOPTION_READY";
}

function allowedNextPhases(phase, verdict) {
  if (verdict === "PASS" && phase === "ADOPTION_READY") return ["CONTROL_HANDOFF", "NEXT_SAFE_CELL"];
  const index = FLOW.indexOf(phase);
  if (index < 0 || index >= FLOW.length - 1) return [];
  return [FLOW[index + 1]];
}

function finding(itemId, overrides = {}, source = BLOCKERS) {
  const [code, message] = source[itemId];
  return {
    item_id: itemId,
    code,
    message: overrides.message ?? message,
    path: overrides.path ?? null,
  };
}

function recoveryFinding(signal) {
  const map = {
    material_drift: "RECOVER-001",
    legacy_as_truth: "RECOVER-002",
    llm_as_truth: "RECOVER-003",
    unsafe_change: "RECOVER-004",
  };
  return finding(map[signal], { path: "existing_state_scan" });
}

function requiredNextActions(blockers, warnings, currentPhase) {
  if (blockers.length === 0 && warnings.length === 0) return [];
  return [...blockers, ...warnings].map((finding) => ({
    item_id: finding.item_id,
    action: actionFor(finding, currentPhase),
  }));
}

function actionFor(finding, currentPhase) {
  const actions = {
    "ADOPT-001": "Create a single adoption intake plan before running adoption.",
    "ADOPT-002": "Set adoption plan lane to adoption_intake.",
    "ADOPT-005": "Record owner.role and owner.actor in the adoption plan.",
    "ADOPT-007": "Capture owner-confirmed direction before accelerating retrofit work.",
    "ADOPT-008": "Provide an existing-state scan; use an explicit empty scan for greenfield initialization.",
    "RPS-001": "Draft RPS from current repository reality.",
    "RPS-002": "Record owner confirmation for RPS direction.",
    "GAP-001": "Create a gap-fill or reconciliation plan.",
    "HANDOFF-001": "Create the next safe Cell or control handoff.",
    "RECOVER-001": "Reconcile material drift before execution-ready work.",
    "RECOVER-002": "Convert legacy truth claims into input-only evidence and owner-confirmed RPS.",
    "RECOVER-003": "Replace LLM-as-truth with owner-confirmed RPS/control handoff evidence.",
    "RECOVER-004": "Stop unsafe change and create recovery plan before implementation.",
    "GREEN-W001": "Initialize RPS, owner confirmation, and first control handoff.",
    "RETRO-W001": "Gap-fill Shirube artifacts from current repository reality.",
  };
  return actions[finding.item_id] ?? `Advance adoption from ${currentPhase}.`;
}

function readInput(options) {
  const adoptionPlanPath = typeof options["adoption-plan"] === "string" ? options["adoption-plan"] : null;
  const existingStatePath = typeof options["existing-state"] === "string" ? options["existing-state"] : null;
  const repoSpecPath = typeof options["repo-spec"] === "string" ? options["repo-spec"] : null;
  const legacyInventoryPath = typeof options["legacy-inventory"] === "string" ? options["legacy-inventory"] : null;
  const specReconciliationPath = typeof options["spec-reconciliation"] === "string" ? options["spec-reconciliation"] : null;
  const handoffPath = typeof options.handoff === "string" ? options.handoff : null;
  const changedFilesPath = typeof options["changed-files"] === "string" ? options["changed-files"] : null;

  const planResult = adoptionPlanPath
    ? readOptionalStructuredInput(adoptionPlanPath, "adoption_plan_parse_error", false)
    : { value: null };
  if (planResult.error) return { error: planResult.error };

  const existingStateResult = existingStatePath
    ? readOptionalStructuredInput(existingStatePath, "existing_state_parse_error", true)
    : { value: null };
  if (existingStateResult.error) return { error: existingStateResult.error };

  const repoSpecResult = repoSpecPath
    ? readOptionalStructuredInput(repoSpecPath, "repo_spec_parse_error", true)
    : { value: null };
  if (repoSpecResult.error) return { error: repoSpecResult.error };

  const legacyInventoryResult = legacyInventoryPath
    ? readOptionalStructuredInput(legacyInventoryPath, "legacy_inventory_parse_error", true)
    : { value: null };
  if (legacyInventoryResult.error) return { error: legacyInventoryResult.error };

  const reconciliationResult = specReconciliationPath
    ? readOptionalStructuredInput(specReconciliationPath, "spec_reconciliation_parse_error", true)
    : { value: null };
  if (reconciliationResult.error) return { error: reconciliationResult.error };

  const handoffResult = handoffPath
    ? readOptionalStructuredInput(handoffPath, "handoff_parse_error", true)
    : { value: null };
  if (handoffResult.error) return { error: handoffResult.error };

  return {
    input: {
      adoptionPlan: planResult.value,
      adoptionPlanPath,
      existingState: existingStateResult.value,
      existingStatePath,
      repoSpec: repoSpecResult.value,
      repoSpecPath,
      legacyInventory: legacyInventoryResult.value,
      legacyInventoryPath,
      specReconciliation: reconciliationResult.value,
      specReconciliationPath,
      handoff: handoffResult.value,
      handoffPath,
      changedFiles: readChangedFiles(changedFilesPath),
      changedFilesPath,
      hasExistingStateScan: Boolean(existingStatePath || legacyInventoryPath || planResult.value?.existing_state_scan),
    },
  };
}

function readOptionalStructuredInput(filePath, errorCode, missingAsBlock) {
  if (!existsSync(filePath)) {
    if (missingAsBlock) {
      return { value: null };
    }
    return {
      error: failureReport({ code: errorCode, message: `File not found: ${filePath}` }),
    };
  }
  try {
    return { value: readStructuredFile(filePath) };
  } catch (error) {
    return {
      error: failureReport({ code: errorCode, message: errorMessage(error) }),
    };
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

function failureReport({ code, message }) {
  return {
    schema: SCHEMA,
    lane: LANE,
    disposition: "retrofit_recover",
    current_phase: "ADOPTION_INTAKE",
    verdict: "FAILURE",
    would_block: false,
    allowed_next_phases: [],
    forbidden_next_phases: BLOCKED_NEXT,
    blockers: [],
    warnings: [],
    evidence: [],
    required_next_actions: [{ code, message }],
  };
}

function isStale(value, thresholdDays) {
  if (!nonEmptyString(value)) return false;
  const observed = Date.parse(value);
  if (Number.isNaN(observed)) return false;
  const now = Date.parse("2026-06-23T00:00:00Z");
  return now - observed > Number(thresholdDays) * 24 * 60 * 60 * 1000;
}

function hasAbsentOrPartialTests(state) {
  return asArray(state.tests).some((entry) => {
    if (isObject(entry)) return ["absent", "partial"].includes(entry.status);
    return ["absent", "partial"].includes(String(entry));
  });
}

function hasPartialSpecs(state) {
  const specs = [...asArray(state.specs), ...asArray(state.legacy_sources?.specs)];
  return specs.some((entry) => isObject(entry) && entry.status === "partial" && (entry.authority === "input_only" || entry.authority === undefined));
}

function hasNestedEntries(value) {
  if (!isObject(value)) return false;
  return Object.values(value).some((entry) => presentArray(entry) || hasNestedEntries(entry));
}

function hasOwner(plan) {
  return nonEmptyString(plan?.owner?.role) && nonEmptyString(plan?.owner?.actor);
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

function uniqueFindings(findings) {
  const seen = new Set();
  const unique = [];
  for (const finding of findings) {
    const key = `${finding.item_id}\0${finding.code}\0${finding.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique;
}

function uniqueEvidence(evidence) {
  const seen = new Set();
  const unique = [];
  for (const entry of evidence) {
    const key = `${entry.code}\0${entry.source}\0${entry.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function presentArray(value) {
  return asArray(value).some((entry) => {
    if (Array.isArray(entry)) return presentArray(entry);
    if (isObject(entry)) return Object.keys(entry).length > 0;
    return nonEmptyString(entry);
  });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function asStringArray(value) {
  return asArray(value).filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
}

function surfaceValues(value) {
  if (Array.isArray(value)) return value.flatMap(surfaceValues);
  if (isObject(value)) {
    if (Array.isArray(value.declared)) return value.declared.flatMap(surfaceValues);
    return Object.entries(value).flatMap(([key, entry]) => entry === true ? [key] : surfaceValues(entry));
  }
  if (typeof value === "string") return [value];
  return [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.format !== "json") {
    const result = failureReport({ code: "unsupported_format", message: "--format json is required." });
    writeResult(result);
    process.exitCode = 1;
    return;
  }

  const readResult = readInput(options);
  if (readResult.error) {
    writeResult(readResult.error);
    process.exitCode = 1;
    return;
  }

  const result = buildAdoptionReport(readResult.input);
  writeResult(result);
}

if (isMain(import.meta.url)) {
  main();
}
