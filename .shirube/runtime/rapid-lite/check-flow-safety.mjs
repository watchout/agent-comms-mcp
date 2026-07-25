#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  isMain,
  parseArgs,
  readStructuredFile,
  writeResult,
} from "./lib.mjs";

export const FLOW_SAFETY_INPUT_SCHEMA = "shirube-flow-safety-input/v1";
export const FLOW_SAFETY_REPORT_SCHEMA = "shirube-flow-safety-report/v1";

export const FLOW_SAFETY_GATE_TYPES = Object.freeze([
  "control_artifact_review",
  "PR_exact_head_audit",
  "Cell_completion_gate",
]);

const SUBJECT_FIELDS = Object.freeze({
  control_artifact_review: ["artifact_id", "version", "SHA256", "gate_type"],
  PR_exact_head_audit: ["cell_id", "repo", "PR", "head", "gate_type", "control_input_digest"],
  Cell_completion_gate: ["cell_id", "completion_evidence_digest", "gate_type"],
});

const ACTIVE_WORK_STATUSES = new Set(["pending", "queued", "received", "in_progress"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;

export function evaluateFlowSafety(input = {}) {
  const findings = [];
  if (input.schema_version !== FLOW_SAFETY_INPUT_SCHEMA) {
    findings.push(finding("FLOW-SAFETY-001", "INVALID_INPUT_SCHEMA", "schema_version", `Expected ${FLOW_SAFETY_INPUT_SCHEMA}.`));
  }

  const subjectResult = validateSubject(input.subject);
  findings.push(...subjectResult.findings);
  const expectedSubjectResult = validateExpectedSubject(input.expected_subject);
  findings.push(...expectedSubjectResult.findings);
  const bindingFindings = subjectBindingFindings(subjectResult.subject, expectedSubjectResult.subject);
  findings.push(...bindingFindings);

  const auditWorkKey = subjectResult.subject && expectedSubjectResult.subject && bindingFindings.length === 0
    ? buildAuditWorkKey(subjectResult.subject)
    : null;

  if (auditWorkKey && hasDuplicateActiveWork(input.active_work, auditWorkKey)) {
    findings.push(finding(
      "FLOW-SAFETY-004",
      "DUPLICATE_ACTIVE_AUDIT_WORK",
      "active_work",
      `Nonterminal work already exists for audit_work_key ${auditWorkKey}.`,
    ));
  }

  findings.push(...artifactVersionFindings(input, subjectResult.subject));
  const coordination = evaluateCoordinationForward(input.coordination_forward);
  findings.push(...coordination.findings);

  if (input.gate_result === "BLOCK") {
    findings.push(finding("FLOW-SAFETY-006", "UPSTREAM_GATE_BLOCK", "gate_result", "The affected Cell remains blocked by its gate result."));
  }

  const transition = evaluateTransition(input.transition, subjectResult.subject?.gate_type);
  findings.push(...transition.findings);

  const cellEffects = buildCellEffects({
    cells: input.cells,
    affectedCellId: input.affected_cell_id ??
      input.transition?.cell_id ??
      subjectResult.subject?.cell_id ??
      (isObject(input.subject) && nonEmpty(input.subject.cell_id) ? input.subject.cell_id : undefined),
    blocking: findings.length > 0,
    transition: transition.transition,
  });

  const uniqueFindings = dedupeFindings(findings);
  const verdict = uniqueFindings.length === 0 ? "PASS" : "BLOCK";

  return {
    schema_version: FLOW_SAFETY_REPORT_SCHEMA,
    gate: "flow-safety",
    verdict,
    would_block: verdict === "BLOCK",
    subject: subjectResult.subject,
    audit_work_key: auditWorkKey,
    findings: uniqueFindings,
    cell_effects: cellEffects,
    coordination_forward: coordination.result,
    transition: transition.transition,
    next_action: verdict === "PASS"
      ? transition.transition?.to === "implementation_handoff_ready"
        ? { action: "deliver_implementation_handoff", blocking: false }
        : { action: "continue_current_cell", blocking: false }
      : { action: "resolve_flow_safety_findings", blocking: true },
  };
}

export function buildAuditWorkKey(subject) {
  const fields = SUBJECT_FIELDS[subject.gate_type];
  if (!fields) throw new Error(`Unknown gate_type: ${String(subject.gate_type)}`);
  const semanticSubject = Object.fromEntries(fields.map((field) => [field, normalizeSubjectValue(field, subject[field])]));
  return createHash("sha256")
    .update("shirube-audit-work/v1\n", "utf8")
    .update(JSON.stringify(semanticSubject), "utf8")
    .digest("hex");
}

function validateSubject(value) {
  if (!isObject(value)) {
    return {
      subject: null,
      findings: [finding("FLOW-SAFETY-002", "INVALID_GATE_SUBJECT", "subject", "A typed gate subject is required.")],
    };
  }

  const gateType = value.gate_type;
  if (!FLOW_SAFETY_GATE_TYPES.includes(gateType)) {
    return {
      subject: null,
      findings: [finding("FLOW-SAFETY-002", "UNKNOWN_GATE_TYPE", "subject.gate_type", "gate_type is not recognized.")],
    };
  }

  const required = SUBJECT_FIELDS[gateType];
  const missing = required.filter((field) => !validSubjectField(field, value[field]));
  const foreignGateFields = Object.entries(SUBJECT_FIELDS)
    .filter(([type]) => type !== gateType)
    .flatMap(([, fields]) => fields)
    .filter((field) => !required.includes(field) && Object.hasOwn(value, field));
  const findings = [];

  if (missing.length > 0) {
    findings.push(finding(
      "FLOW-SAFETY-003",
      "MISSING_GATE_SUBJECT_FIELDS",
      "subject",
      `Missing or invalid fields for ${gateType}: ${missing.join(", ")}.`,
      { missing_fields: missing },
    ));
  }
  if (foreignGateFields.length > 0) {
    findings.push(finding(
      "FLOW-SAFETY-002",
      "GATE_SUBJECT_TYPE_CONFUSION",
      "subject",
      `Subject contains fields owned by another gate type: ${[...new Set(foreignGateFields)].join(", ")}.`,
    ));
  }
  if (findings.length > 0) return { subject: null, findings };

  return {
    subject: Object.fromEntries(required.map((field) => [field, normalizeSubjectValue(field, value[field])])),
    findings: [],
  };
}

function validateExpectedSubject(value) {
  if (value === undefined) {
    return {
      subject: null,
      findings: [finding(
        "FLOW-SAFETY-001",
        "MISSING_TRUSTED_EXPECTED_SUBJECT",
        "expected_subject",
        "An independently supplied trusted expected gate subject is required.",
      )],
    };
  }

  const result = validateSubject(value);
  return {
    subject: result.subject,
    findings: result.findings.map((entry) => ({
      ...entry,
      code: "INVALID_TRUSTED_EXPECTED_SUBJECT",
      cause_code: entry.code,
      path: entry.path.replace(/^subject/, "expected_subject"),
      message: `Trusted expected subject is invalid: ${entry.message}`,
    })),
  };
}

function subjectBindingFindings(subject, expectedSubject) {
  if (!subject || !expectedSubject) return [];
  if (subject.gate_type !== expectedSubject.gate_type) {
    return [finding(
      "FLOW-SAFETY-001",
      "GATE_SUBJECT_BINDING_TYPE_MISMATCH",
      "subject.gate_type",
      `Claimed gate type ${subject.gate_type} does not match trusted gate type ${expectedSubject.gate_type}.`,
      { expected_gate_type: expectedSubject.gate_type, actual_gate_type: subject.gate_type },
    )];
  }

  const fields = SUBJECT_FIELDS[subject.gate_type];
  const mismatchFields = fields.filter((field) => subject[field] !== expectedSubject[field]);
  if (mismatchFields.length === 0) return [];

  const mismatch = {
    control_artifact_review: ["AC-556-FLOW-003", "CONTROL_ARTIFACT_GATE_SUBJECT_MISMATCH"],
    PR_exact_head_audit: ["AC-556-FLOW-002", "PR_GATE_SUBJECT_MISMATCH"],
    Cell_completion_gate: ["FLOW-SAFETY-001", "CELL_GATE_SUBJECT_MISMATCH"],
  }[subject.gate_type];
  return [finding(
    mismatch[0],
    mismatch[1],
    "subject",
    `Claimed ${subject.gate_type} subject differs from its trusted expected identity: ${mismatchFields.join(", ")}.`,
    { mismatch_fields: mismatchFields },
  )];
}

function validSubjectField(field, value) {
  if (field === "PR") return Number.isInteger(Number(value)) && Number(value) > 0;
  if (field === "head") return typeof value === "string" && SHA_PATTERN.test(value);
  if (["SHA256", "control_input_digest", "completion_evidence_digest"].includes(field)) {
    return typeof value === "string" && SHA256_PATTERN.test(value);
  }
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSubjectValue(field, value) {
  if (field === "PR") return Number(value);
  if (["head", "SHA256", "control_input_digest", "completion_evidence_digest"].includes(field)) {
    return String(value).toLowerCase();
  }
  return String(value);
}

function hasDuplicateActiveWork(activeWork, key) {
  return asArray(activeWork).some((work) =>
    work?.audit_work_key === key && ACTIVE_WORK_STATUSES.has(String(work?.status)),
  );
}

function artifactVersionFindings(input, subject) {
  const artifact = isObject(input.artifact)
    ? input.artifact
    : subject?.gate_type === "control_artifact_review"
      ? { artifact_id: subject.artifact_id, version: subject.version, SHA256: subject.SHA256 }
      : null;
  if (!artifact) return [];
  if (!validSubjectField("artifact_id", artifact.artifact_id) ||
      !validSubjectField("version", artifact.version) ||
      !validSubjectField("SHA256", artifact.SHA256)) {
    return [finding("FLOW-SAFETY-005", "INVALID_ARTIFACT_IDENTITY", "artifact", "artifact_id, version, and SHA256 are required.")];
  }

  const conflict = asArray(input.artifact_history).find((record) =>
    record?.artifact_id === artifact.artifact_id &&
    String(record?.version) === String(artifact.version) &&
    typeof record?.SHA256 === "string" &&
    record.SHA256.toLowerCase() !== artifact.SHA256.toLowerCase(),
  );
  return conflict
    ? [finding(
        "FLOW-SAFETY-005",
        "VERSION_REUSE_CONFLICT",
        "artifact",
        `${artifact.artifact_id}@${artifact.version} is already bound to a different SHA256.`,
      )]
    : [];
}

function evaluateCoordinationForward(value) {
  if (value === undefined) return { findings: [], result: null };
  if (!isObject(value) || value.actor_function !== "coordination_recorder") {
    return {
      findings: [finding("FLOW-SAFETY-007", "INVALID_COORDINATION_FORWARD", "coordination_forward", "coordination_recorder forwarding evidence is invalid.")],
      result: { exact_forward: false, authority_preserved: false },
    };
  }

  const sourceDigest = contentDigest(value.source_content, value.source_digest);
  const forwardedDigest = contentDigest(value.forwarded_content, value.forwarded_digest);
  const findings = [];
  if (!sourceDigest || !forwardedDigest || sourceDigest !== forwardedDigest) {
    findings.push(finding("FLOW-SAFETY-007", "COORDINATION_CONTENT_MUTATION", "coordination_forward", "Forwarded content must match the source bytes exactly."));
  }
  if (nonEmpty(value.authored_content) || nonEmpty(value.authored_verdict)) {
    findings.push(finding("FLOW-SAFETY-007", "COORDINATION_AUTHORITY_VIOLATION", "coordination_forward", "coordination_recorder cannot author design, audit content, or verdicts."));
  }
  return {
    findings,
    result: {
      source_digest: sourceDigest,
      forwarded_digest: forwardedDigest,
      exact_forward: Boolean(sourceDigest && sourceDigest === forwardedDigest),
      authority_preserved: !nonEmpty(value.authored_content) && !nonEmpty(value.authored_verdict),
    },
  };
}

function contentDigest(content, declaredDigest) {
  if (typeof content === "string") {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }
  return typeof declaredDigest === "string" && SHA256_PATTERN.test(declaredDigest)
    ? declaredDigest.toLowerCase()
    : null;
}

function evaluateTransition(value, subjectGateType) {
  if (value === undefined) return { findings: [], transition: null };
  if (!isObject(value) || !FLOW_SAFETY_GATE_TYPES.includes(value.gate_type)) {
    return {
      findings: [finding("FLOW-SAFETY-008", "INVALID_GATE_TRANSITION", "transition", "A recognized gate_type is required for a transition.")],
      transition: null,
    };
  }
  if (subjectGateType && value.gate_type !== subjectGateType) {
    return {
      findings: [finding("FLOW-SAFETY-001", "GATE_RESULT_TYPE_MISMATCH", "transition.gate_type", "A gate result cannot advance a different gate subject type.")],
      transition: null,
    };
  }
  if (value.result !== "PASS" || value.gate_type !== "control_artifact_review") {
    return { findings: [], transition: null };
  }
  if (!nonEmpty(value.cell_id)) {
    return {
      findings: [finding("FLOW-SAFETY-008", "MISSING_TRANSITION_CELL", "transition.cell_id", "Design PASS transition requires cell_id.")],
      transition: null,
    };
  }

  const target = "implementation_handoff_ready";
  return {
    findings: [],
    transition: {
      cell_id: value.cell_id,
      from: value.current_state ?? null,
      to: target,
      idempotent: value.current_state === target,
      new_design_work_items: 0,
    },
  };
}

function buildCellEffects({ cells, affectedCellId, blocking, transition }) {
  if (!affectedCellId) return [];
  const inventory = asArray(cells);
  const existing = inventory.find((cell) => cell?.cell_id === affectedCellId);
  const affectedState = blocking ? "blocked" : transition?.to ?? existing?.state ?? "unchanged";
  const effects = inventory.map((cell) => ({
    cell_id: cell?.cell_id,
    before: cell?.state ?? null,
    after: cell?.cell_id === affectedCellId ? affectedState : cell?.state ?? null,
    changed: cell?.cell_id === affectedCellId && (cell?.state ?? null) !== affectedState,
  }));
  if (!existing) {
    effects.push({ cell_id: affectedCellId, before: null, after: affectedState, changed: true });
  }
  return effects;
}

function finding(itemId, code, path, message, extra = {}) {
  return { item_id: itemId, code, severity: "BLOCK", path, message, ...extra };
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((entry) => {
    const key = `${entry.code}\0${entry.path}\0${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function usage() {
  process.stderr.write("Usage: node scripts/shirube/check-flow-safety.mjs --input <yaml-or-json> [--report-only]\n");
}

if (isMain(import.meta.url)) {
  const { options } = parseArgs(process.argv.slice(2));
  if (typeof options.input !== "string") {
    usage();
    process.exitCode = 2;
  } else {
    try {
      const result = evaluateFlowSafety(readStructuredFile(options.input));
      writeResult(result);
      if (result.verdict === "BLOCK" && options["report-only"] !== true) process.exitCode = 1;
    } catch (error) {
      writeResult({
        schema_version: FLOW_SAFETY_REPORT_SCHEMA,
        gate: "flow-safety",
        verdict: "BLOCK",
        would_block: true,
        findings: [finding("FLOW-SAFETY-001", "INPUT_READ_ERROR", "input", error instanceof Error ? error.message : String(error))],
      });
      process.exitCode = 2;
    }
  }
}
