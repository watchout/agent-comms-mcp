#!/usr/bin/env node
import { existsSync } from "node:fs";
import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";

const SCHEMA = "shirube-enforcement-policy-check/v1";
const MODES = ["report_only", "owner_block", "ci_hard_block", "required_check"];
const DETERMINISTIC_NOW = Date.parse("2026-06-23T00:00:00Z");

const FINDINGS = {
  "ENF-001": ["missing_enforcement_policy", "Enforcement policy is missing or unreadable.", "policy"],
  "ENF-002": ["invalid_enforcement_mode", "Enforcement mode must be report_only, owner_block, ci_hard_block, or required_check.", "policy.mode"],
  "ENF-003": ["missing_owner", "policy.owner.role and policy.owner.actor are required.", "policy.owner"],
  "ENF-004": ["aggregate_missing", "Rapid/Lite aggregate report is missing or unreadable.", "aggregate"],
  "ENF-005": ["aggregate_blocked_under_owner_block", "Aggregate would_block=true blocks owner_block progression without exact-head exception.", "aggregate.would_block"],
  "ENF-006": ["aggregate_blocked_under_ci_hard_block", "Aggregate would_block=true blocks CI hard-block or required-check progression.", "aggregate.would_block"],
  "ENF-007": ["required_check_mode_without_owner_approval", "required_check mode requires owner approval evidence before activation readiness.", "owner_approval"],
  "ENF-008": ["stale_policy_or_unpinned_framework", "Policy must be current and reference a pinned framework version or commit.", "policy.framework_ref"],
};

export function buildEnforcementPolicyReport(input) {
  const evidence = [];
  const blockers = [];
  const warnings = [];
  const failures = [];
  const policy = isObject(input.policy) ? input.policy : null;
  const aggregate = isObject(input.aggregate) ? input.aggregate : null;
  const ownerDecision = isObject(input.ownerDecision) ? input.ownerDecision : null;
  const mode = stringValue(policy?.mode) ?? "UNKNOWN";

  if (input.policyPath) evidence.push({ code: "policy", source: "file", detail: input.policyPath });
  if (input.aggregatePath) evidence.push({ code: "aggregate", source: "file", detail: input.aggregatePath });
  if (input.ownerDecisionPath) evidence.push({ code: "owner_decision", source: "file", detail: input.ownerDecisionPath });

  if (!policy) {
    failures.push(finding("ENF-001", { path: input.policyPath ?? "policy" }));
    return report({ mode, failures, blockers, warnings, evidence, aggregate, policy, ownerDecision });
  }

  if (!MODES.includes(mode)) {
    failures.push(finding("ENF-002", { path: "policy.mode" }));
    return report({ mode, failures, blockers, warnings, evidence, aggregate, policy, ownerDecision });
  }

  if (!hasOwner(policy)) blockers.push(finding("ENF-003"));
  if (!aggregate) blockers.push(finding("ENF-004", { path: input.aggregatePath ?? "aggregate" }));
  if (policyIsStaleOrUnpinned(policy)) blockers.push(finding("ENF-008"));

  const aggregateWouldBlock = aggregateWouldBlockValue(aggregate);
  const aggregateHasWarning = aggregateWarns(aggregate);
  const ownerException = hasOwnerException({ policy, ownerDecision, aggregate });
  const requiredCheckApproval = hasRequiredCheckApproval({ policy, ownerDecision });
  const ciWaiver = ciWaiverPermitted({ policy, ownerDecision, aggregate });

  if (aggregateWouldBlock) {
    if (mode === "report_only") {
      warnings.push(finding("ENF-005", {
        message: "Aggregate would_block=true is report-only evidence; owner must not merge without explicit pilot exception.",
      }));
    } else if (mode === "owner_block" && !ownerException) {
      blockers.push(finding("ENF-005"));
    } else if ((mode === "ci_hard_block" || mode === "required_check") && !ciWaiver) {
      blockers.push(finding("ENF-006"));
    } else {
      warnings.push(finding("ENF-005", {
        message: "Aggregate would_block=true proceeded only because structured exception evidence is present.",
      }));
    }
  } else if (aggregateHasWarning) {
    warnings.push({
      item_id: "ENF-W001",
      code: "aggregate_warned",
      message: "Aggregate report has warnings and should be owner-reviewed before promotion.",
      path: "aggregate.verdict",
    });
  }

  if (mode === "required_check" && !requiredCheckApproval) {
    blockers.push(finding("ENF-007"));
  }

  return report({ mode, failures, blockers, warnings, evidence, aggregate, policy, ownerDecision });
}

function report({ mode, failures, blockers, warnings, evidence, aggregate, policy, ownerDecision }) {
  const uniqueFailures = uniqueFindings(failures);
  const uniqueBlockers = uniqueFindings(blockers);
  const uniqueWarnings = uniqueFindings(warnings);
  const aggregateWouldBlock = aggregateWouldBlockValue(aggregate);
  const verdict = uniqueFailures.length > 0
    ? "FAILURE"
    : uniqueBlockers.length > 0
      ? "BLOCKED"
      : uniqueWarnings.length > 0
        ? "PASS_WITH_WARN"
        : "PASS";
  const ciShouldFail = computeCiShouldFail({ mode, verdict, aggregateWouldBlock, policy, ownerDecision });
  const ownerMustNotMerge = computeOwnerMustNotMerge({ mode, verdict, aggregateWouldBlock, policy, ownerDecision });

  return {
    schema: SCHEMA,
    mode,
    verdict,
    would_block: aggregateWouldBlock || verdict === "BLOCKED",
    ci_should_fail: ciShouldFail,
    owner_must_not_merge: ownerMustNotMerge,
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    failures: uniqueFailures,
    evidence: uniqueEvidence(evidence),
    required_next_actions: requiredNextActions({ failures: uniqueFailures, blockers: uniqueBlockers, warnings: uniqueWarnings, verdict }),
  };
}

function computeCiShouldFail({ mode, verdict, aggregateWouldBlock, policy, ownerDecision }) {
  if (verdict === "FAILURE") return false;
  if (mode === "ci_hard_block" && aggregateWouldBlock && !ciWaiverPermitted({ policy, ownerDecision })) return true;
  if (mode === "required_check" && verdict === "BLOCKED") return true;
  return false;
}

function computeOwnerMustNotMerge({ mode, verdict, aggregateWouldBlock, policy, ownerDecision }) {
  if (verdict === "FAILURE" || verdict === "BLOCKED") return true;
  if (!aggregateWouldBlock) return false;
  if (mode === "report_only") return !hasPilotException({ policy, ownerDecision });
  if (mode === "owner_block") return !hasOwnerException({ policy, ownerDecision });
  if (mode === "ci_hard_block") return !ciWaiverPermitted({ policy, ownerDecision });
  return true;
}

function hasOwner(policy) {
  return nonEmptyString(policy?.owner?.role) && nonEmptyString(policy?.owner?.actor);
}

function aggregateWouldBlockValue(aggregate) {
  if (!isObject(aggregate)) return false;
  return aggregate.would_block === true || aggregate.verdict === "BLOCKED" || aggregate.verdict === "BLOCK";
}

function aggregateWarns(aggregate) {
  if (!isObject(aggregate)) return false;
  return aggregate.verdict === "PASS_WITH_WARN" || aggregate.verdict === "WARN";
}

function policyIsStaleOrUnpinned(policy) {
  const frameworkRef = stringValue(policy.framework_ref ?? policy.framework_lock_ref);
  if (!isPinnedFrameworkRef(frameworkRef)) return true;
  const updatedAt = stringValue(policy.updated_at ?? policy.reviewed_at);
  if (!updatedAt) return true;
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) return true;
  const staleAfterDays = Number(policy.stale_after_days ?? 90);
  return DETERMINISTIC_NOW - parsed > staleAfterDays * 24 * 60 * 60 * 1000;
}

function hasPilotException({ policy, ownerDecision }) {
  return policy?.pilot_exception?.approved === true ||
    policy?.pilot_exception?.accepted === true ||
    decisionIs(ownerDecision, ["PILOT_EXCEPTION", "APPROVED_PILOT_EXCEPTION", "APPROVED_EXCEPTION"]);
}

function hasOwnerException({ policy, ownerDecision, aggregate } = {}) {
  if (!ownerDecisionHasHead(ownerDecision, aggregate)) return false;
  return decisionIs(ownerDecision, [
    "OWNER_EXCEPTION",
    "APPROVED_EXCEPTION",
    "APPROVED_EXACT_HEAD",
    "PILOT_EXCEPTION",
    "APPROVED_PILOT_EXCEPTION",
  ]) || policy?.owner_exception?.approved === true;
}

function hasRequiredCheckApproval({ policy, ownerDecision }) {
  return nonEmptyString(policy?.required_check?.owner_approval_ref) ||
    nonEmptyString(policy?.required_check_owner_approval_ref) ||
    policy?.required_check?.owner_approved === true ||
    decisionIs(ownerDecision, ["APPROVED_REQUIRED_CHECK", "APPROVED_ENFORCEMENT", "APPROVED_EXACT_HEAD"]);
}

function ciWaiverPermitted({ policy, ownerDecision, aggregate } = {}) {
  const permitsWaiver = policy?.waiver?.permit_ci_hard_block_owner_waiver === true ||
    policy?.ci_hard_block?.owner_waiver_allowed === true;
  if (!permitsWaiver) return false;
  return hasOwnerException({ policy, ownerDecision, aggregate });
}

function ownerDecisionHasHead(ownerDecision, aggregate) {
  if (!isObject(ownerDecision)) return false;
  const head = stringValue(ownerDecision.exact_head_sha ?? ownerDecision.head_sha ?? ownerDecision.target_head);
  if (!head) return false;
  const aggregateHead = stringValue(aggregate?.head_sha ?? aggregate?.target_head ?? aggregate?.exact_head_sha);
  return !aggregateHead || aggregateHead === head;
}

function decisionIs(ownerDecision, values) {
  if (!isObject(ownerDecision)) return false;
  const decision = String(ownerDecision.decision ?? ownerDecision.verdict ?? ownerDecision.status ?? "").toUpperCase();
  return values.includes(decision);
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

function requiredNextActions({ failures, blockers, warnings, verdict }) {
  if (verdict === "PASS") return [];
  return [...failures, ...blockers, ...warnings].map((item) => ({
    item_id: item.item_id,
    action: actionFor(item.item_id),
  }));
}

function actionFor(itemId) {
  const actions = {
    "ENF-001": "Create a shirube-enforcement-policy/v1 artifact before checking enforcement mode.",
    "ENF-002": "Set policy.mode to report_only, owner_block, ci_hard_block, or required_check.",
    "ENF-003": "Record policy.owner.role and policy.owner.actor.",
    "ENF-004": "Run run-rapid-lite-report and pass its aggregate JSON with --aggregate.",
    "ENF-005": "Stop owner merge or record an exact-head owner exception before proceeding.",
    "ENF-006": "Keep CI hard-block/required-check mode blocked until aggregate would_block=false or an allowed waiver exists.",
    "ENF-007": "Record owner approval evidence before declaring required-check readiness.",
    "ENF-008": "Refresh the policy and pin framework_ref to a commit, tag, or version.",
    "ENF-W001": "Owner-review aggregate warnings before promoting enforcement mode.",
  };
  return actions[itemId] ?? "Resolve enforcement policy finding.";
}

function readInput(options) {
  const policyPath = stringOption(options.policy);
  const aggregatePath = stringOption(options.aggregate);
  const ownerDecisionPath = stringOption(options["owner-decision"]);

  const policyResult = readOptionalStructuredInput(policyPath, "ENF-001", false);
  if (policyResult.error) return { error: failureReport(policyResult.error, policyPath, aggregatePath, ownerDecisionPath) };
  const aggregateResult = readOptionalStructuredInput(aggregatePath, "ENF-004", true);
  if (aggregateResult.error) return { error: aggregateResult.error };
  const ownerDecisionResult = readOptionalStructuredInput(ownerDecisionPath, "owner_decision_parse_error", true);
  if (ownerDecisionResult.error) return { error: ownerDecisionResult.error };

  return {
    input: {
      policyPath,
      aggregatePath,
      ownerDecisionPath,
      policy: policyResult.value,
      aggregate: aggregateResult.value,
      ownerDecision: ownerDecisionResult.value,
    },
  };
}

function readOptionalStructuredInput(filePath, missingCode, optional) {
  if (!filePath || !existsSync(filePath)) {
    if (optional) return { value: null };
    return { value: null, error: missingCode };
  }
  try {
    return { value: readStructuredFile(filePath) };
  } catch (error) {
    if (optional) {
      return {
        error: {
          schema: SCHEMA,
          mode: "UNKNOWN",
          verdict: "FAILURE",
          would_block: false,
          ci_should_fail: false,
          owner_must_not_merge: true,
          blockers: [],
          warnings: [],
          failures: [{ code: "owner_decision_parse_error", message: errorMessage(error), path: filePath }],
          evidence: [],
          required_next_actions: [{ code: "owner_decision_parse_error", action: "Fix owner decision parse error." }],
        },
      };
    }
    return { value: null, error: missingCode };
  }
}

function failureReport(code, policyPath, aggregatePath, ownerDecisionPath) {
  const itemId = code === "ENF-004" ? "ENF-004" : "ENF-001";
  return report({
    mode: "UNKNOWN",
    failures: [finding(itemId, { path: itemId === "ENF-001" ? policyPath ?? "policy" : aggregatePath ?? "aggregate" })],
    blockers: [],
    warnings: [],
    evidence: [
      policyPath ? { code: "policy", source: "file", detail: policyPath } : null,
      aggregatePath ? { code: "aggregate", source: "file", detail: aggregatePath } : null,
      ownerDecisionPath ? { code: "owner_decision", source: "file", detail: ownerDecisionPath } : null,
    ].filter(Boolean),
    aggregate: null,
    policy: null,
    ownerDecision: null,
  });
}

function uniqueFindings(findings) {
  const seen = new Set();
  const unique = [];
  for (const finding of findings) {
    const key = `${finding.item_id ?? finding.code}\0${finding.code}\0${finding.path}\0${finding.message}`;
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

function isPinnedFrameworkRef(value) {
  if (typeof value !== "string") return false;
  return /@[a-f0-9]{7,40}\b/i.test(value) || /@v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/.test(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringOption(value) {
  return typeof value === "string" ? value : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.format !== "json") {
    process.stdout.write(`${JSON.stringify({
      schema: SCHEMA,
      mode: "UNKNOWN",
      verdict: "FAILURE",
      would_block: false,
      ci_should_fail: false,
      owner_must_not_merge: true,
      blockers: [],
      warnings: [],
      failures: [{ code: "unsupported_format", message: "--format json is required.", path: "format" }],
      evidence: [],
      required_next_actions: [{ code: "unsupported_format", action: "Run with --format json." }],
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const { input, error } = readInput(options);
  const result = error ?? buildEnforcementPolicyReport(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.verdict === "FAILURE") process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main();
}
