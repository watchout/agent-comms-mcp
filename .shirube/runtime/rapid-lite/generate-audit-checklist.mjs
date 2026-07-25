#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";

const SCHEMA = "shirube-audit-checklist/v1";
const REPORT_SCHEMA = "shirube-audit-checklist-generate/v1";

export function buildAuditChecklist({ handoff, handoffRef, actual = {} }) {
  const cell = isObject(handoff?.cell) ? handoff.cell : {};
  const validation = isObject(handoff?.validation) ? handoff.validation : {};
  const cellId = firstPresent(cell["CELL-ID"], cell.cell_id, handoff?.cell_id, handoff?.CELL_ID) ?? "UNKNOWN-CELL";
  const flowSafety = isObject(handoff?.flow_safety) ? handoff.flow_safety : {};
  const controlInputDigest = firstPresent(
    actual.control_input_digest,
    handoff?.control_input_digest,
    flowSafety.control_input_digest,
    digestFile(handoffRef),
  ) ?? null;
  const items = [];

  for (const criterion of uniqueStrings([
    ...asArray(cell.acceptance_criteria),
    ...asArray(handoff?.acceptance_criteria),
    ...asArray(validation.acceptance_tests),
  ])) {
    addItem(items, {
      source: "acceptance_criteria",
      verification_method: "semantic",
      prompt: `Verify acceptance criterion: ${criterion}`,
      expected_evidence: ["structured_reviewer_rationale"],
    });
  }

  for (const stopCondition of uniqueStrings([
    ...asArray(cell.stop_conditions),
    ...asArray(handoff?.stop_conditions),
  ])) {
    addItem(items, {
      source: "stop_condition",
      verification_method: "semantic",
      prompt: `Verify stop condition did not occur: ${stopCondition}`,
      expected_evidence: ["changed_files", "structured_reviewer_rationale"],
    });
  }

  const allowedPaths = uniqueStrings(asArray(cell.allowed_paths));
  if (allowedPaths.length > 0) {
    addItem(items, {
      source: "allowed_paths",
      verification_method: "executable",
      prompt: `Verify changed files are inside allowed_paths: ${allowedPaths.join(", ")}`,
      expected_evidence: ["changed_files", "diff_scope_report"],
    });
  }

  const forbiddenPaths = uniqueStrings(asArray(cell.forbidden_paths));
  if (forbiddenPaths.length > 0) {
    addItem(items, {
      source: "forbidden_paths",
      verification_method: "executable",
      prompt: `Verify no changed file matches forbidden_paths: ${forbiddenPaths.join(", ")}`,
      expected_evidence: ["changed_files", "diff_scope_report"],
    });
  }

  for (const surface of uniqueSurfaceStrings([
    ...protectedSurfaceValues(handoff?.protected_surfaces),
    ...protectedSurfaceValues(cell.protected_surfaces),
  ])) {
    addItem(items, {
      source: "protected_surface",
      verification_method: "semantic",
      prompt: `Verify protected surface declaration and authority handling for: ${surface}`,
      expected_evidence: ["protected_surface_declaration", "authority_boundary_review"],
    });
  }

  for (const command of uniqueStrings(asArray(validation.required_commands))) {
    addItem(items, {
      source: "validation_command",
      verification_method: "executable",
      prompt: `Verify required validation command passed: ${command}`,
      expected_evidence: [`command_result:${command}`],
    });
  }

  for (const evidence of uniqueStrings(asArray(validation.required_evidence))) {
    addItem(items, {
      source: "required_evidence",
      verification_method: "executable",
      prompt: `Verify required evidence is concrete and current: ${evidence}`,
      expected_evidence: [evidence],
    });
  }

  addItem(items, {
    source: "role_boundary",
    verification_method: "semantic",
    prompt: "Verify lead/dev/owner/auditor authority boundaries and maker-checker separation.",
    expected_evidence: ["execution_context_report", "maker_checker_review"],
  });

  if (ownerDecisionRequired(handoff)) {
    addItem(items, {
      source: "owner_decision",
      verification_method: "executable",
      prompt: "Verify owner exact-head decision policy and evidence are present before merge.",
      expected_evidence: ["owner_decision", "pr_head_sha"],
    });
  }

  if (postMergeRequired(handoff)) {
    addItem(items, {
      source: "post_merge",
      verification_method: "executable",
      prompt: "Verify post-merge evidence is required before completion is claimed.",
      expected_evidence: ["post_merge_evidence"],
    });
  }

  return {
    schema_version: SCHEMA,
    audit_checklist_id: `AUDIT-CHECKLIST-${sanitizeId(cellId)}`,
    source: {
      handoff_ref: handoffRef,
      cell_id: cellId,
      pr: firstPresent(handoff?.pr, handoff?.pr_url, handoff?.pull_request, handoff?.source_pr) ?? null,
      work_order: firstPresent(handoff?.work_order, handoff?.work_order_ref, handoff?.repo_local_issue, handoff?.issue_ref) ?? null,
      implementation_actor: firstPresent(handoff?.implementation_actor, handoff?.implementation?.actor, handoff?.executor?.actor) ?? null,
      gate_subject: {
        cell_id: cellId,
        repo: firstPresent(actual.repo, handoff?.repo, flowSafety.repo) ?? null,
        PR: prNumber(firstPresent(actual.PR, handoff?.pr, handoff?.pr_url, handoff?.pull_request, handoff?.source_pr)),
        head: firstPresent(actual.head, handoff?.pr_head_sha, handoff?.exact_head_sha, handoff?.target_head, handoff?.head_sha, flowSafety.head) ?? null,
        gate_type: "PR_exact_head_audit",
        control_input_digest: controlInputDigest,
      },
    },
    items: items.map((item, index) => ({
      item_id: `AUDIT-${String(index + 1).padStart(3, "0")}`,
      ...item,
    })),
  };
}

function prNumber(value) {
  if (Number.isInteger(Number(value)) && Number(value) > 0) return Number(value);
  const match = String(value ?? "").match(/(?:#|\/pull\/)(\d+)(?:\b|$)/);
  return match ? Number(match[1]) : null;
}

function digestFile(file) {
  if (typeof file !== "string" || file.trim().length === 0) return null;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function addItem(items, item) {
  items.push({
    source: item.source,
    verification_method: item.verification_method,
    required: true,
    prompt: item.prompt,
    expected_evidence: uniqueStrings(item.expected_evidence),
  });
}

function ownerDecisionRequired(handoff) {
  return handoff?.owner_decision?.required_before_merge === true ||
    handoff?.owner_decision_required === true ||
    handoff?.required_owner_decision_for_merge === true ||
    !isPlaceholder(firstPresent(handoff?.owner_decision?.exact_head_sha, handoff?.owner_decision?.decision_ref));
}

function postMergeRequired(handoff) {
  return handoff?.post_merge?.required === true ||
    handoff?.post_merge_evidence_required === true ||
    handoff?.cell?.post_merge_evidence_required === true ||
    asArray(handoff?.validation?.required_evidence).some((entry) => /post[-_ ]?merge/i.test(String(entry)));
}

function protectedSurfaceValues(value) {
  if (Array.isArray(value)) return value.flatMap(protectedSurfaceValues);
  if (isObject(value)) {
    if (Array.isArray(value.declared)) return value.declared;
    return Object.entries(value).flatMap(([key, entry]) => entry === true ? [key] : protectedSurfaceValues(entry));
  }
  if (typeof value === "string") return [value];
  return [];
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter((value) => value.length > 0 && !isPlaceholder(value)))];
}

function uniqueSurfaceStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter((value) => value.length > 0 && !/^<.*>$/.test(value) && !/^(pending|todo|tbd|null)$/i.test(value)))];
}

function firstPresent(...values) {
  return values.find((value) => !isPlaceholder(value));
}

function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return text.length === 0 || /^<.*>$/.test(text) || /^(pending|todo|tbd|null|none)$/i.test(text);
}

function sanitizeId(value) {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "UNKNOWN-CELL";
}

function toYaml(value, indent = 0) {
  const space = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((entry) => {
      if (isObject(entry) || Array.isArray(entry)) {
        return `${space}- ${toYaml(entry, indent + 2).trimStart()}`;
      }
      return `${space}- ${scalar(entry)}`;
    }).join("\n");
  }
  if (isObject(value)) {
    return Object.entries(value).map(([key, entry]) => {
      if (Array.isArray(entry)) {
        if (entry.length === 0) return `${space}${key}: []`;
        return `${space}${key}:\n${toYaml(entry, indent + 2)}`;
      }
      if (isObject(entry)) {
        return `${space}${key}:\n${toYaml(entry, indent + 2)}`;
      }
      return `${space}${key}: ${scalar(entry)}`;
    }).join("\n");
  }
  return `${space}${scalar(value)}`;
}

function scalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const handoffPath = typeof options.handoff === "string" ? options.handoff : null;
  const outPath = typeof options.out === "string" ? options.out : null;
  const format = typeof options.format === "string" ? options.format : "yaml";
  const actual = {
    repo: typeof options["actual-repo"] === "string" ? options["actual-repo"] : null,
    PR: typeof options["actual-pr"] === "string" ? options["actual-pr"] : null,
    head: typeof options["actual-head"] === "string" ? options["actual-head"] : null,
    control_input_digest: typeof options["control-input-digest"] === "string" ? options["control-input-digest"] : null,
  };
  if (!handoffPath) {
    const result = {
      schema: REPORT_SCHEMA,
      verdict: "FAILURE",
      message: "--handoff is required.",
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const handoff = readStructuredFile(handoffPath);
    const checklist = buildAuditChecklist({ handoff, handoffRef: handoffPath, actual });
    const yaml = `${toYaml(checklist)}\n`;
    if (outPath) writeFileSync(outPath, yaml);
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({
        schema: REPORT_SCHEMA,
        verdict: "PASS",
        out: outPath,
        item_count: checklist.items.length,
        audit_checklist_id: checklist.audit_checklist_id,
        checklist,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(yaml);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schema: REPORT_SCHEMA,
      verdict: "FAILURE",
      message: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  main();
}
