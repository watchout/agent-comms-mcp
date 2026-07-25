import {
  isObject,
} from "./lib.mjs";

export const CANONICAL_CONTROL_HANDOFF_SCHEMA = "shirube-v3/control_handoff/v1";

export function isCanonicalControlHandoff(value) {
  return isObject(value) && value.schema_version === CANONICAL_CONTROL_HANDOFF_SCHEMA;
}

/**
 * Return a runtime-only compatibility view for existing Rapid/Lite consumers.
 * The canonical object remains the source of every mapped value and is never
 * rewritten or committed by this adapter.
 */
export function normalizeControlHandoff(value) {
  if (!isCanonicalControlHandoff(value)) return value;

  const cell = isObject(value.cell) ? value.cell : {};
  const executionTarget = isObject(value.execution_context?.to) ? value.execution_context.to : {};
  const validation = isObject(value.validation) ? value.validation : {};
  const canonicalAllowedPaths = stringArray(value.allowed_paths);
  const canonicalForbiddenPaths = stringArray(value.forbidden_paths);
  const canonicalStopConditions = array(value.stop_conditions);
  const canonicalRequiredEvidence = array(value.required_evidence);
  const canonicalRequiredChecks = array(value.required_checks ?? value.required_commands);
  const canonicalAcceptance = array(value.acceptance ?? value.acceptance_fixtures);

  return {
    ...value,
    mode: first(value.mode, "rapid-lite"),
    profile: first(value.profile, "hotel-lite"),
    repo_local_issue: first(value.repo_local_issue, value.control_source),
    premise_ref: first(value.premise_ref, value.control_source),
    owner: isObject(value.owner)
      ? value.owner
      : {
          role: executionTarget.active_function ?? null,
          actor: executionTarget.agent_id ?? null,
        },
    next_role: first(value.next_role, executionTarget.active_function),
    spec_review_state: first(value.spec_review_state, value.lifecycle_state),
    handoff_ready_for_implementation: value.handoff_ready_for_implementation === true ||
      String(value.lifecycle_state ?? "").toUpperCase() === "READY_FOR_IMPLEMENTATION",
    acceptance_criteria: array(value.acceptance_criteria).length > 0
      ? value.acceptance_criteria
      : canonicalAcceptance,
    validation: {
      ...validation,
      required_commands: array(validation.required_commands).length > 0
        ? validation.required_commands
        : canonicalRequiredChecks,
      required_evidence: array(validation.required_evidence).length > 0
        ? validation.required_evidence
        : canonicalRequiredEvidence,
    },
    cell: {
      ...cell,
      "CELL-ID": first(cell["CELL-ID"], cell.cell_id, cell.id),
      cell_id: first(cell.cell_id, cell.id),
      non_scope: array(cell.non_scope).length > 0
        ? cell.non_scope
        : array(value.forbidden_operations),
      allowed_paths: canonicalAllowedPaths,
      forbidden_paths: canonicalForbiddenPaths,
      stop_conditions: canonicalStopConditions,
    },
    canonical_control_handoff: {
      schema_version: value.schema_version,
      cell_id_source: "cell.id",
      allowed_paths_source: "allowed_paths",
      forbidden_paths_source: "forbidden_paths",
      stop_conditions_source: "stop_conditions",
      required_evidence_source: "required_evidence",
      source_ref: value.control_source ?? null,
    },
  };
}

export function canonicalControlHandoffMissingFields(value) {
  if (!isCanonicalControlHandoff(value)) return ["schema_version"];
  const required = [
    ["cell.id", value.cell?.id],
    ["repository.name", value.repository?.name],
    ["allowed_paths", value.allowed_paths],
    ["forbidden_paths", value.forbidden_paths],
    ["stop_conditions", value.stop_conditions],
    ["required_evidence", value.required_evidence],
  ];
  const missing = required
    .filter(([path, entry]) => path.endsWith(".id") || path.endsWith(".name")
      ? !nonEmptyString(entry)
      : array(entry).length === 0)
    .map(([path]) => path);
  const nextAction = isObject(value.next_action) ? value.next_action : {};
  const requiredNextAction = [
    ["next_action.blocking", nextAction.blocking === true],
    ["next_action.owner_agent", nonEmptyString(nextAction.owner_agent)],
    ["next_action.owner_function", nonEmptyString(nextAction.owner_function)],
    ["next_action.action", nonEmptyString(nextAction.action)],
    ["next_action.handoff_method", nonEmptyString(nextAction.handoff_method)],
    ["next_action.input_refs", durableInputRefArray(nextAction.input_refs)],
    ["next_action.scope", nonEmptyString(nextAction.scope)],
    ["next_action.deliverable", nonEmptyString(nextAction.deliverable)],
    ["next_action.completion_evidence", nonEmptyString(nextAction.completion_evidence)],
    ["next_action.stop_reason", nonEmptyString(nextAction.stop_reason)],
  ];
  return [
    ...missing,
    ...requiredNextAction.filter(([, valid]) => !valid).map(([path]) => path),
  ];
}

function array(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function stringArray(value) {
  return array(value).filter(nonEmptyString).map((entry) => entry.trim());
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function durableInputRefArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(durableInputRef);
}

function durableInputRef(value) {
  if (!nonEmptyString(value)) return false;
  const ref = value.trim();
  if (/^(?:pending|tbd|todo|unknown|none|null|n\/?a|placeholder)$/i.test(ref)) return false;
  if (/<[^>]+>|\{\{[^}]+\}\}|\$\{[^}]+\}/.test(ref)) return false;

  return isExactGithubRef(ref) ||
    /^github-comment:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[1-9]\d*$/.test(ref) ||
    /^(?:cell(?:_id)?[:/])?CELL-[A-Z0-9][A-Z0-9._-]*$/.test(ref) ||
    /^(?:exact_(?:head|base|sha)|commit):[0-9a-f]{40}$/i.test(ref) ||
    /^(?:sha256|evidence_sha256):[0-9a-f]{64}$/i.test(ref) ||
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref) ||
    isRepositoryArtifactRef(ref);
}

function isExactGithubRef(ref) {
  const repo = "https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
  return new RegExp(`^${repo}/(?:issues|pull)/[1-9]\\d*(?:#issuecomment-[1-9]\\d*)?$`).test(ref) ||
    new RegExp(`^${repo}/issues/comments/[1-9]\\d*$`).test(ref) ||
    new RegExp(`^${repo}/commit/[0-9a-f]{40}$`, "i").test(ref) ||
    new RegExp(`^${repo}/actions/runs/[1-9]\\d*(?:/job/[1-9]\\d*)?$`).test(ref) ||
    new RegExp(`^${repo}/blob/[0-9a-f]{40}/[^\\s#]+(?:#L[1-9]\\d*(?:-L[1-9]\\d*)?)?$`, "i").test(ref);
}

function isRepositoryArtifactRef(ref) {
  if (!/^(?:\.?[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+[A-Za-z0-9_-][A-Za-z0-9._-]*(?::[1-9]\d*|#L[1-9]\d*)?$/.test(ref)) {
    return false;
  }
  return !ref.split("/").includes("..");
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim().length > 0) ?? null;
}
