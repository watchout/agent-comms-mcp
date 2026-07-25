#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  evaluateFlowSafety,
} from "./check-flow-safety.mjs";
import {
  buildAuditChecklist,
} from "./generate-audit-checklist.mjs";

const SCHEMA = "shirube-rapid-lite-report/v1";
const MARKER = "<!-- shirube-rapid-lite-gates-report/v1 -->";
const DEFAULT_RESULT_DIR = ".shirube-rapid-lite";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export function buildRapidLiteReport(options) {
  const resultDir = stringOption(options["result-dir"]) ?? DEFAULT_RESULT_DIR;
  mkdirSync(resultDir, { recursive: true });

  const changedFilesPath = stringOption(options["changed-files"]);
  const inputFailurePath = stringOption(options["input-failure"]);
  const prBodyPath = stringOption(options["pr-body"]);
  const diffRoot = stringOption(options["diff-root"]) ?? ".";
  const changedFilesResult = readChangedFiles(changedFilesPath);
  const changedFiles = changedFilesResult.files;
  const prBody = prBodyPath && existsSync(prBodyPath) ? readFileSync(prBodyPath, "utf8") : "";
  const discovery = discoverRefs({ prBody, changedFiles });
  const refs = { ...discovery.refs };
  const actual = actualContextFromOptions(options);
  ensureRuntimeAuditChecklist({ resultDir, refs, actual });
  ensureRuntimeValidationEvidence({ resultDir, refs, changedFiles, changedFilesPath, actual });
  refs.structuredAuditSourceTrusted = isCurrentRunAuditSource(refs.structuredAuditSource, resultDir);
  refs.additionalReviewSourceTrusted = isCurrentRunAdditionalReviewSource(refs.additionalReviewSource, resultDir);
  const records = [];

  if (changedFilesResult.failure) records.push(failureRecord("input-collection", changedFilesResult.failure));
  if (inputFailurePath) records.push(readInputFailureRecord(inputFailurePath));
  records.push(...discovery.records);

  const executionContext = runExecutionContext({ resultDir, refs, changedFilesPath, prBodyPath, actual });
  records.push(executionContext);

  const adoption = runAdoption({ resultDir, refs, changedFilesPath });
  records.push(adoption);

  const gateContract = runGateContract({ resultDir, refs, changedFilesPath, actual });
  records.push(gateContract);

  const designRules = runDesignRules({ resultDir, refs, changedFilesPath, prBodyPath, diffRoot });
  records.push(designRules);

  const flowSafety = runFlowSafety({ resultDir, refs, actual });
  records.push(flowSafety);

  const auditChecklist = runAuditChecklist({ resultDir, refs, actual });
  records.push(auditChecklist);

  const reviewPlan = runReviewPlan({
    resultDir,
    refs,
    changedFilesPath,
    auditChecklistReportPath: auditChecklist.status === "ran" ? auditChecklist.output_path : refs.auditChecklistReport,
    actual,
  });
  records.push(reviewPlan);

  const lifecycle = runLifecycle({
    resultDir,
    refs,
    changedFilesPath,
    adoptionReportPath: adoption.status === "ran" ? adoption.output_path : refs.adoptionReport,
    gateContractReportPath: gateContract.status === "ran" ? gateContract.output_path : refs.gateContractReport,
    designRuleReportPath: designRules.status === "ran" ? designRules.output_path : refs.designRuleReport,
    auditChecklistReportPath: auditChecklist.status === "ran" ? auditChecklist.output_path : refs.auditChecklistReport,
    reviewPlanReportPath: reviewPlan.status === "ran" ? reviewPlan.output_path : refs.reviewPlanReport,
    actual,
  });
  records.push(lifecycle);

  const preEnforcementAggregatePath = writeInterimAggregate({ resultDir, refs, records, changedFiles, filename: "pre-enforcement-aggregate.json" });
  const enforcementPolicy = runEnforcementPolicy({ resultDir, refs, aggregatePath: preEnforcementAggregatePath });
  if (enforcementPolicy) records.push(enforcementPolicy);

  const preControlStateAggregatePath = writeInterimAggregate({ resultDir, refs, records, changedFiles, filename: "pre-control-state-aggregate.json" });
  const designRuleReportPath = materializeSkippedReport({
    record: designRules,
    resultDir,
    filename: "design-rules.json",
  });

  const controlState = runControlStateCompleteness({
    resultDir,
    refs,
    changedFilesPath,
    aggregatePath: preControlStateAggregatePath,
    executionContextReportPath: executionContext.status === "ran" ? executionContext.output_path : refs.executionContextReport,
    adoptionReportPath: adoption.status === "ran" ? adoption.output_path : refs.adoptionReport,
    lifecycleReportPath: lifecycle.status === "ran" ? lifecycle.output_path : refs.lifecycleReport,
    gateContractReportPath: gateContract.status === "ran" ? gateContract.output_path : refs.gateContractReport,
    designRuleReportPath: designRuleReportPath ?? refs.designRuleReport,
    auditChecklistReportPath: auditChecklist.status === "ran" ? auditChecklist.output_path : refs.auditChecklistReport,
    reviewPlanReportPath: reviewPlan.status === "ran" ? reviewPlan.output_path : refs.reviewPlanReport,
    enforcementPolicyReportPath: enforcementPolicy?.status === "ran" ? enforcementPolicy.output_path : refs.enforcementPolicyReport,
    actual,
  });
  records.push(controlState);

  const aggregate = aggregateReport({ resultDir, refs, records, changedFiles });
  writeFileSync(path.join(resultDir, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
  writeFileSync(path.join(resultDir, "summary.md"), renderSummary(aggregate));
  return aggregate;
}

function runExecutionContext({ resultDir, refs, changedFilesPath, prBodyPath, actual }) {
  const args = [
    gateScript("check-execution-context.mjs"),
  ];
  addArg(args, "--context", refs.executionContext);
  addArg(args, "--pr-body", prBodyPath);
  addArg(args, "--changed-files", changedFilesPath);
  addArg(args, "--actual-repo", actual.actualRepo);
  addArg(args, "--actual-branch", actual.actualBranch);
  addArg(args, "--actual-head", actual.actualHead);
  args.push("--format", "json");
  return runGate({ gate: "execution-context", args, outputPath: path.join(resultDir, "execution-context.json") });
}

function runAdoption({ resultDir, refs, changedFilesPath }) {
  if (!refs.adoptionPlan) return skipped("adoption", "No adoption intake plan was found.");
  const args = [
    gateScript("check-adoption.mjs"),
    "--adoption-plan",
    refs.adoptionPlan,
  ];
  addArg(args, "--existing-state", refs.existingState);
  addArg(args, "--legacy-inventory", refs.legacyInventory);
  addArg(args, "--repo-spec", refs.repoSpec);
  addArg(args, "--spec-reconciliation", refs.specReconciliation);
  addArg(args, "--handoff", refs.handoff);
  addArg(args, "--changed-files", changedFilesPath);
  args.push("--format", "json");
  return runGate({ gate: "adoption", args, outputPath: path.join(resultDir, "adoption.json") });
}

function runGateContract({ resultDir, refs, changedFilesPath, actual }) {
  if (!refs.handoff) return skipped("gate-contract", "No Rapid/Lite control handoff was found.");
  const args = [
    gateScript("check-gate-contract.mjs"),
  ];
  addArg(args, "--matrix", refs.matrix);
  addArg(args, "--repo-spec", refs.repoSpec);
  addArg(args, "--framework-lock", refs.frameworkLock);
  args.push("--handoff", refs.handoff);
  addArg(args, "--changed-files", changedFilesPath);
  addArg(args, "--validation", refs.validation);
  addArg(args, "--owner-decision", refs.ownerDecision);
  addArg(args, "--actual-head", actual.actualHead);
  args.push("--format", "json");
  return runGate({ gate: "gate-contract", args, outputPath: path.join(resultDir, "gate-contract.json") });
}

function runDesignRules({ resultDir, refs, changedFilesPath, prBodyPath, diffRoot }) {
  if (!refs.rulePack) return skipped("design-rules", "No design rule pack was found.");
  const args = [
    gateScript("check-design-rules.mjs"),
    "--rule-pack",
    refs.rulePack,
  ];
  addArg(args, "--changed-files", changedFilesPath);
  addArg(args, "--diff-root", diffRoot);
  addArg(args, "--handoff", refs.handoff);
  addArg(args, "--pr-body", prBodyPath);
  args.push("--format", "json");
  return runGate({ gate: "design-rules", args, outputPath: path.join(resultDir, "design-rules.json") });
}

function runFlowSafety({ resultDir, refs, actual }) {
  const relevant = Boolean(refs.auditChecklist) || reviewPlanRuntimeRelevant(refs.handoff);
  if (!relevant) return skipped("flow-safety", "No audit request or audit-relevant handoff requires flow-safety binding.");

  const outputPath = path.join(resultDir, "flow-safety.json");
  const inputPath = path.join(resultDir, "flow-safety-input.json");
  try {
    const handoff = refs.handoff ? readStructuredFile(refs.handoff) : null;
    const checklist = refs.auditChecklist ? readStructuredFile(refs.auditChecklist) : null;
    const subject = checklist?.source?.gate_subject ?? null;
    const expectedSubject = expectedFlowSafetySubject({ handoff, handoffRef: refs.handoff, actual });
    const input = {
      schema_version: "shirube-flow-safety-input/v1",
      subject,
      expected_subject: expectedSubject,
      active_work: asArray(handoff?.flow_safety?.active_work),
      cells: asArray(handoff?.flow_safety?.cells),
      affected_cell_id: expectedSubject.cell_id,
    };
    writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);

    const checkerReport = evaluateFlowSafety(input);
    const report = {
      ...checkerReport,
      checker_verdict: checkerReport.verdict,
      verdict: checkerReport.verdict === "PASS" ? "PASS" : "BLOCKED",
      blockers: checkerReport.findings,
      warnings: [],
      required_next_actions: checkerReport.findings.map((entry) => ({
        item_id: entry.item_id,
        action: entry.message,
      })),
      input_path: inputPath,
      trusted_expected_subject_sources: ["control_handoff", "github_pr_event"],
    };
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return gateRecordFromReport({
      gate: "flow-safety",
      command: "evaluateFlowSafety(derived audit request binding)",
      outputPath,
      exitCode: 0,
      report,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report = {
      schema_version: "shirube-flow-safety-report/v1",
      gate: "flow-safety",
      verdict: "FAILURE",
      report_failed: true,
      would_block: true,
      blockers: [{
        item_id: "FLOW-SAFETY-INTEGRATION-001",
        code: "FLOW_SAFETY_INTEGRATION_INPUT_ERROR",
        path: refs.auditChecklist ?? refs.handoff ?? "flow-safety-input",
        message,
      }],
      warnings: [],
      required_next_actions: [{
        item_id: "FLOW-SAFETY-INTEGRATION-001",
        action: "Repair the audit request or handoff input before requesting audit.",
      }],
    };
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return gateRecordFromReport({
      gate: "flow-safety",
      command: "evaluateFlowSafety(derived audit request binding)",
      outputPath,
      exitCode: 1,
      report,
    });
  }
}

function ensureRuntimeAuditChecklist({ resultDir, refs, actual }) {
  if (refs.auditChecklist || refs.auditChecklistReport || !reviewPlanRuntimeRelevant(refs.handoff)) return;

  const handoff = readStructuredFile(refs.handoff);
  const checklist = buildAuditChecklist({ handoff, handoffRef: refs.handoff });
  checklist.source.gate_subject = expectedFlowSafetySubject({ handoff, handoffRef: refs.handoff, actual });
  checklist.source.runtime_binding = {
    generated_by: "scripts/shirube/run-rapid-lite-report.mjs",
    trusted_sources: ["control_handoff", "github_pr_event"],
    target_branch_mutated: false,
    owner_approval_synthesized: false,
  };

  const outputPath = path.join(resultDir, "runtime-audit-checklist.json");
  writeFileSync(outputPath, `${JSON.stringify(checklist, null, 2)}\n`);
  refs.auditChecklist = outputPath;
}

function expectedFlowSafetySubject({ handoff, handoffRef, actual }) {
  const flowSafety = isObject(handoff?.flow_safety) ? handoff.flow_safety : {};
  return {
    cell_id: handoffCellId(handoff),
    repo: actual.actualRepo,
    PR: prNumber(actual.actualPr),
    head: actual.actualHead,
    gate_type: "PR_exact_head_audit",
    control_input_digest: firstPresent(
      handoff?.control_input_digest,
      flowSafety.control_input_digest,
      digestFile(handoffRef),
    ) ?? null,
  };
}

function digestFile(file) {
  if (typeof file !== "string" || file.trim().length === 0) return null;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function handoffCellId(handoff) {
  return firstPresent(handoff?.cell?.id, handoff?.cell?.["CELL-ID"], handoff?.cell?.cell_id, handoff?.cell_id, handoff?.CELL_ID) ?? null;
}

function prNumber(value) {
  if (Number.isInteger(Number(value)) && Number(value) > 0) return Number(value);
  const match = String(value ?? "").match(/(?:#|\/pull\/)(\d+)(?:\b|$)/);
  return match ? Number(match[1]) : null;
}

function runAuditChecklist({ resultDir, refs, actual }) {
  const outputPath = path.join(resultDir, "audit-checklist.json");
  if (refs.auditChecklist) {
    const args = [
      gateScript("check-audit-checklist.mjs"),
      "--checklist",
      refs.auditChecklist,
    ];
    addArg(args, "--audit", refs.structuredAudit);
    addArg(args, "--audit-source", refs.structuredAuditSource);
    addFlag(args, "--trusted-audit-source", refs.structuredAuditSourceTrusted);
    addArg(args, "--machine-evidence", refs.auditMachineEvidence);
    addArg(args, "--expected-head", actual.actualHead);
    addArg(args, "--expected-repo", actual.actualRepo);
    addArg(args, "--expected-pr", actual.actualPr);
    args.push("--format", "json");
    return runGate({ gate: "audit-checklist", args, outputPath });
  }
  if (refs.structuredAudit || refs.auditMachineEvidence) {
    const args = [
      gateScript("check-audit-checklist.mjs"),
    ];
    addArg(args, "--audit", refs.structuredAudit);
    addArg(args, "--audit-source", refs.structuredAuditSource);
    addFlag(args, "--trusted-audit-source", refs.structuredAuditSourceTrusted);
    addArg(args, "--machine-evidence", refs.auditMachineEvidence);
    addArg(args, "--expected-head", actual.actualHead);
    addArg(args, "--expected-repo", actual.actualRepo);
    addArg(args, "--expected-pr", actual.actualPr);
    args.push("--format", "json");
    return runGate({ gate: "audit-checklist", args, outputPath });
  }
  if (refs.auditChecklistReport) {
    return readExistingGateReport({ gate: "audit-checklist", reportPath: refs.auditChecklistReport, outputPath });
  }
  return skipped("audit-checklist", "No audit checklist refs were found; audit checklist is conditional unless required by handoff/profile.");
}

function runReviewPlan({ resultDir, refs, changedFilesPath, auditChecklistReportPath, actual }) {
  if (!refs.handoff && !refs.reviewPlan) return skipped("review-plan", "No handoff or review plan was found.");
  if (!refs.reviewPlan && !reviewPlanRuntimeRelevant(refs.handoff)) {
    return skipped("review-plan", "Review plan is not required for this non-operational report-only handoff.");
  }
  const args = [
    gateScript("check-review-plan.mjs"),
  ];
  addArg(args, "--handoff", refs.handoff);
  addArg(args, "--repo-spec", refs.repoSpec);
  addArg(args, "--review-plan", refs.reviewPlan);
  addArg(args, "--changed-files", changedFilesPath);
  addArg(args, "--audit-checklist-report", auditChecklistReportPath);
  addArg(args, "--structured-audit", refs.structuredAudit);
  addArg(args, "--audit-source", refs.structuredAuditSource);
  addFlag(args, "--trusted-audit-source", refs.structuredAuditSourceTrusted);
  addArg(args, "--owner-decision", refs.ownerDecision);
  addArg(args, "--additional-review", refs.additionalReview);
  addArg(args, "--additional-review-source", refs.additionalReviewSource);
  addFlag(args, "--trusted-additional-review-source", refs.additionalReviewSourceTrusted);
  addArg(args, "--actual-repo", actual.actualRepo);
  addArg(args, "--actual-pr", actual.actualPr);
  addArg(args, "--actual-head", actual.actualHead);
  args.push("--format", "json");
  return runGate({ gate: "review-plan", args, outputPath: path.join(resultDir, "review-plan.json") });
}

function runEnforcementPolicy({ resultDir, refs, aggregatePath }) {
  if (!refs.enforcementPolicy) return null;
  const args = [
    gateScript("check-enforcement-policy.mjs"),
    "--policy",
    refs.enforcementPolicy,
    "--aggregate",
    aggregatePath,
  ];
  addArg(args, "--owner-decision", refs.ownerDecision);
  args.push("--format", "json");
  return runGate({ gate: "enforcement-policy", args, outputPath: path.join(resultDir, "enforcement-policy.json") });
}

function reviewPlanRuntimeRelevant(handoffPath) {
  if (!handoffPath || !existsSync(handoffPath)) return false;
  try {
    const handoff = readStructuredFile(handoffPath);
    const cell = isObject(handoff.cell) ? handoff.cell : {};
    const risk = String(cell.risk_class ?? cell.risk_tier ?? handoff.risk_class ?? handoff.risk_tier ?? "").toUpperCase();
    const flow = String(handoff.flow ?? handoff.merge_flow ?? handoff.development_flow ?? "").toLowerCase();
    return handoff.audit_required === true ||
      handoff.formal_audit_required === true ||
      handoff.independent_audit_required === true ||
      handoff.review_plan_required === true ||
      isObject(handoff.review_plan) ||
      /full_operational|operational/.test(flow) ||
      ["R3", "R4"].includes(risk);
  } catch {
    return true;
  }
}

function runControlStateCompleteness({
  resultDir,
  refs,
  changedFilesPath,
  aggregatePath,
  executionContextReportPath,
  adoptionReportPath,
  lifecycleReportPath,
  gateContractReportPath,
  designRuleReportPath,
  auditChecklistReportPath,
  reviewPlanReportPath,
  enforcementPolicyReportPath,
  actual,
}) {
  const args = [
    gateScript("check-control-state-completeness.mjs"),
  ];
  addArg(args, "--control-state", refs.controlState);
  addArg(args, "--execution-context-report", executionContextReportPath);
  addArg(args, "--repo-spec", refs.repoSpec);
  addArg(args, "--source-mirror", refs.sourceMirror);
  addArg(args, "--adoption-report", adoptionReportPath);
  addArg(args, "--lifecycle-report", lifecycleReportPath);
  addArg(args, "--gate-contract-report", gateContractReportPath);
  addArg(args, "--design-rule-report", designRuleReportPath);
  addArg(args, "--audit-checklist-report", auditChecklistReportPath);
  addArg(args, "--review-plan-report", reviewPlanReportPath);
  addArg(args, "--enforcement-policy-report", enforcementPolicyReportPath);
  addArg(args, "--readiness-report", refs.readinessReport);
  addArg(args, "--handoff", refs.handoff);
  addArg(args, "--matrix", refs.matrix);
  addArg(args, "--changed-files", changedFilesPath);
  addArg(args, "--validation", refs.validation);
  addArg(args, "--owner-decision", refs.ownerDecision);
  addArg(args, "--audit-checklist", refs.auditChecklist);
  addArg(args, "--structured-audit", refs.structuredAudit);
  addArg(args, "--audit-source", refs.structuredAuditSource);
  addFlag(args, "--trusted-audit-source", refs.structuredAuditSourceTrusted);
  addArg(args, "--additional-review", refs.additionalReview);
  addArg(args, "--additional-review-source", refs.additionalReviewSource);
  addFlag(args, "--trusted-additional-review-source", refs.additionalReviewSourceTrusted);
  addArg(args, "--audit-record", refs.auditRecord);
  addArg(args, "--audit-item-set", refs.auditItemSet);
  addArg(args, "--post-merge", refs.postMerge);
  addArg(args, "--aggregate", aggregatePath);
  addArg(args, "--actual-repo", actual.actualRepo);
  addArg(args, "--actual-pr", actual.actualPr);
  addArg(args, "--actual-head", actual.actualHead);
  args.push("--format", "json");
  return runGate({ gate: "control-state-completeness", args, outputPath: path.join(resultDir, "control-state-completeness.json") });
}

function runLifecycle({ resultDir, refs, changedFilesPath, adoptionReportPath, gateContractReportPath, designRuleReportPath }) {
  const options = arguments[0] ?? {};
  const auditChecklistReportPath = options.auditChecklistReportPath;
  const reviewPlanReportPath = options.reviewPlanReportPath;
  const actual = options.actual ?? {};
  if (!refs.lifecycleState) return skipped("lifecycle", "No lifecycle state was found.");
  const args = [
    gateScript("check-lifecycle.mjs"),
    "--state",
    refs.lifecycleState,
  ];
  addArg(args, "--adoption-report", adoptionReportPath);
  addArg(args, "--repo-spec", refs.repoSpec);
  addArg(args, "--framework-lock", refs.frameworkLock);
  addArg(args, "--handoff", refs.handoff);
  addArg(args, "--gate-contract-report", gateContractReportPath);
  addArg(args, "--design-rule-report", designRuleReportPath);
  addArg(args, "--audit-checklist-report", auditChecklistReportPath);
  addArg(args, "--review-plan-report", reviewPlanReportPath);
  addArg(args, "--structured-audit", refs.structuredAudit);
  addArg(args, "--audit-source", refs.structuredAuditSource);
  addFlag(args, "--trusted-audit-source", refs.structuredAuditSourceTrusted);
  addArg(args, "--additional-review", refs.additionalReview);
  addArg(args, "--additional-review-source", refs.additionalReviewSource);
  addFlag(args, "--trusted-additional-review-source", refs.additionalReviewSourceTrusted);
  addArg(args, "--owner-decision", refs.ownerDecision);
  addArg(args, "--post-merge", refs.postMerge);
  addArg(args, "--changed-files", changedFilesPath);
  addArg(args, "--actual-repo", actual.actualRepo);
  addArg(args, "--actual-pr", actual.actualPr);
  addArg(args, "--actual-head", actual.actualHead);
  args.push("--format", "json");
  return runGate({ gate: "lifecycle", args, outputPath: path.join(resultDir, "lifecycle.json") });
}

function runGate({ gate, args, outputPath }) {
  const command = ["node", ...args].join(" ");
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  writeFileSync(outputPath, stdout.trim() ? `${stdout.trim()}\n` : "{}\n");
  if (stderr.trim()) writeFileSync(`${outputPath}.stderr.txt`, `${stderr.trim()}\n`);

  let report = null;
  let parseError = null;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  if (!report) {
    const finding = {
      code: "malformed_gate_json",
      message: parseError ?? "Gate command did not produce JSON.",
    };
    report = {
      schema: "shirube-rapid-lite-gate-run/v1",
      verdict: "FAILURE",
      report_failed: true,
      would_block: true,
      blockers: [finding],
      warnings: [],
      required_next_actions: [finding],
    };
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return gateRecordFromReport({
    gate,
    command,
    outputPath,
    exitCode: result.status ?? 1,
    report,
  });
}

function readExistingGateReport({ gate, reportPath, outputPath }) {
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (gate === "audit-checklist") {
      report.trusted_checker = false;
      report.trust_downgraded = true;
      report.trust_downgrade_reason = "Existing audit checklist reports are display evidence only; run check-audit-checklist in the current report path for audit completion.";
    }
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return gateRecordFromReport({
      gate,
      command: `read ${reportPath}`,
      outputPath,
      exitCode: 0,
      report,
    });
  } catch (error) {
    const finding = {
      code: "unreadable_gate_report",
      message: error instanceof Error ? error.message : String(error),
      path: reportPath,
    };
    const report = {
      schema: "shirube-rapid-lite-gate-run/v1",
      verdict: "FAILURE",
      report_failed: true,
      would_block: true,
      blockers: [finding],
      warnings: [],
      required_next_actions: [finding],
    };
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return gateRecordFromReport({
      gate,
      command: `read ${reportPath}`,
      outputPath,
      exitCode: 1,
      report,
    });
  }
}

function gateRecordFromReport({ gate, command, outputPath, exitCode, report }) {
  const reportFailed = report.report_failed === true || report.verdict === "FAILURE" || exitCode !== 0;
  return {
    gate,
    status: "ran",
    command,
    output_path: outputPath,
    exit_code: exitCode,
    verdict: report.verdict ?? "UNKNOWN",
    report_failed: reportFailed,
    current_phase: report.current_phase ?? null,
    next_action: report.next_action ?? null,
    operation_code: report.operation_code ?? report.authority?.operation_code ?? null,
    approval_class: report.approval_class ?? report.authority?.approval_class ?? null,
    protected_surface_refs: report.protected_surface_refs ?? report.authority?.protected_surface_refs ?? [],
    authority_result_code: report.authority_result_code ?? report.result_code ?? report.authority?.result_code ?? null,
    owner_approval_allowed: report.owner_approval_allowed ?? null,
    merge_ready_allowed: report.merge_ready_allowed ?? null,
    forbidden_next_actions: Array.isArray(report.forbidden_next_actions) ? report.forbidden_next_actions : [],
    audit_required: report.audit_required ?? null,
    audit_completion: report.audit_completion ?? null,
    additional_review_completion: report.additional_review_completion ?? null,
    owner_decision_status: report.owner_decision_status ?? null,
    head_change: report.head_change ?? null,
    disposition: report.disposition ?? report.adoption?.disposition ?? null,
    would_block: reportFailed || report.would_block === true || report.verdict === "BLOCKED",
    blockers: findings(report, "blockers"),
    warnings: findings(report, "warnings"),
    required_next_actions: Array.isArray(report.required_next_actions) ? report.required_next_actions : [],
    deferred_next_actions: Array.isArray(report.deferred_next_actions) ? report.deferred_next_actions : [],
    report,
  };
}

function skipped(gate, reason) {
  return {
    gate,
    status: "skipped",
    reason,
    output_path: null,
    exit_code: null,
    verdict: "SKIPPED",
    report_failed: false,
    current_phase: null,
    next_action: null,
    owner_approval_allowed: null,
    merge_ready_allowed: null,
    forbidden_next_actions: [],
    audit_required: null,
    audit_completion: null,
    additional_review_completion: null,
    owner_decision_status: null,
    head_change: null,
    disposition: null,
    would_block: false,
    blockers: [],
    warnings: [],
    required_next_actions: [],
    deferred_next_actions: [],
  };
}

function materializeSkippedReport({ record, resultDir, filename }) {
  if (!record) return null;
  if (record.status === "ran") return record.output_path;
  if (record.status !== "skipped") return null;

  const outputPath = path.join(resultDir, filename);
  const report = {
    schema: "shirube-skipped-gate-report/v1",
    gate: record.gate,
    verdict: "SKIPPED",
    report_failed: false,
    would_block: false,
    skipped: true,
    reason: record.reason,
    blockers: [],
    warnings: [],
    required_next_actions: [],
    deferred_next_actions: [],
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

function aggregateReport({ resultDir, refs, records, changedFiles }) {
  const ran = records.filter((record) => record.status === "ran");
  const verdict = aggregateVerdict(ran.map((record) => record.verdict));
  const reportFailed = ran.some((record) => record.report_failed || record.verdict === "FAILURE");
  const wouldBlock = reportFailed || ran.some((record) => record.would_block || record.verdict === "BLOCKED");
  const sequencing = aggregateSequencing(records);
  const outputRecords = outputGateRecords({ records, sequencing });
  return {
    schema: SCHEMA,
    report_only: true,
    generated_at: new Date().toISOString(),
    result_dir: resultDir,
    verdict,
    current_phase: sequencing.current_phase,
    next_action: sequencing.next_action,
    operation_code: sequencing.operation_code,
    approval_class: sequencing.approval_class,
    protected_surface_refs: sequencing.protected_surface_refs,
    authority_result_code: sequencing.authority_result_code,
    owner_approval_allowed: sequencing.owner_approval_allowed,
    merge_ready_allowed: sequencing.merge_ready_allowed,
    forbidden_next_actions: sequencing.forbidden_next_actions,
    audit_required: sequencing.audit_required,
    audit_completion: sequencing.audit_completion,
    additional_review_completion: sequencing.additional_review_completion,
    owner_decision_status: sequencing.owner_decision_status,
    head_change: sequencing.head_change ?? null,
    report_failed: reportFailed,
    would_block: wouldBlock,
    owner_must_not_merge: wouldBlock,
    required_next_actions: aggregateRequiredActions(sequencing, outputRecords),
    deferred_next_actions: outputRecords.flatMap((record) => record.deferred_next_actions ?? []),
    gates: outputRecords.map((record) => ({
      gate: record.gate,
      status: record.status,
      reason: record.reason ?? null,
      command: record.command ?? null,
      output_path: record.output_path,
      exit_code: record.exit_code,
      verdict: record.verdict,
      report_failed: record.report_failed,
      current_phase: record.current_phase,
      next_action: record.next_action,
      operation_code: record.operation_code,
      approval_class: record.approval_class,
      protected_surface_refs: record.protected_surface_refs,
      authority_result_code: record.authority_result_code,
      owner_approval_allowed: record.owner_approval_allowed,
      merge_ready_allowed: record.merge_ready_allowed,
      forbidden_next_actions: record.forbidden_next_actions,
      audit_required: record.audit_required,
      audit_completion: record.audit_completion,
      additional_review_completion: record.additional_review_completion,
      owner_decision_status: record.owner_decision_status,
      head_change: record.head_change ?? null,
      disposition: record.disposition,
      would_block: record.would_block,
      blockers: record.blockers,
      warnings: record.warnings,
      required_next_actions: record.required_next_actions,
      deferred_next_actions: record.deferred_next_actions,
    })),
    discovered_inputs: refs,
    changed_files_count: changedFiles.length,
    changed_files: changedFiles,
  };
}

function aggregateSequencing(records) {
  const preferred = [
    "control-state-completeness",
    "lifecycle",
    "review-plan",
    "audit-checklist",
    "gate-contract",
  ]
    .map((gate) => records.find((record) => record.gate === gate && record.next_action))
    .find(Boolean);

  if (preferred) {
    return {
      current_phase: preferred.current_phase,
      next_action: preferred.next_action,
      operation_code: preferred.operation_code ?? null,
      approval_class: preferred.approval_class ?? null,
      protected_surface_refs: preferred.protected_surface_refs ?? [],
      authority_result_code: preferred.authority_result_code ?? null,
      owner_approval_allowed: preferred.owner_approval_allowed,
      merge_ready_allowed: preferred.merge_ready_allowed,
      forbidden_next_actions: preferred.forbidden_next_actions,
      audit_required: preferred.audit_required,
      audit_completion: preferred.audit_completion,
      additional_review_completion: preferred.additional_review_completion ?? null,
      owner_decision_status: preferred.owner_decision_status,
      head_change: preferred.head_change ?? null,
    };
  }

  const blockers = records.flatMap((record) => record.would_block ? record.blockers : []).filter(Boolean);
  if (blockers.length > 0) {
    const sequencing = buildNextActionSequencing({
      auditRequired: false,
      blockingFindings: blockers,
    });
    return {
      current_phase: "BLOCKED",
      next_action: sequencing.next_action,
      operation_code: sequencing.operation_code,
      approval_class: sequencing.approval_class,
      protected_surface_refs: sequencing.protected_surface_refs,
      authority_result_code: sequencing.result_code,
      owner_approval_allowed: sequencing.owner_approval_allowed,
      merge_ready_allowed: sequencing.merge_ready_allowed,
      forbidden_next_actions: sequencing.forbidden_next_actions,
      audit_required: false,
      audit_completion: null,
      additional_review_completion: null,
      owner_decision_status: null,
      head_change: sequencing.head_change ?? null,
    };
  }

  return {
    current_phase: "IMPLEMENTED",
    next_action: {
      action: "review_gate_report",
      responsible_role: "lead",
      allowed_actor_role: "lead",
      reason: "No blocking machine next action was produced by the gate pack.",
    },
    operation_code: null,
    approval_class: null,
    protected_surface_refs: [],
    authority_result_code: null,
    owner_approval_allowed: null,
    merge_ready_allowed: null,
    forbidden_next_actions: [],
    audit_required: null,
    audit_completion: null,
    additional_review_completion: null,
    owner_decision_status: null,
    head_change: null,
  };
}

function outputGateRecords({ records, sequencing }) {
  if (!ownerDecisionDeferred(sequencing)) return records;
  return records.map((record) => deferOwnerDecisionActions(record, sequencing));
}

function ownerDecisionDeferred(sequencing) {
  return sequencing?.owner_approval_allowed === false ||
    asArray(sequencing?.forbidden_next_actions).includes("owner_exact_head_approval") ||
    asArray(sequencing?.forbidden_next_actions).includes("request_owner_exact_head_decision");
}

function deferOwnerDecisionActions(record, sequencing) {
  const deferredUntil = sequencing?.current_phase === "ADDITIONAL_REVIEW_REQUIRED"
    ? "required_additional_reviews_complete"
    : "independent_audit_complete";
  const message = deferredUntil === "required_additional_reviews_complete"
    ? "Owner exact-head decision remains required before merge, but it is not actionable until required additional reviews complete."
    : "Owner exact-head decision remains required before merge, but it is not actionable until independent audit completion.";
  const actions = asArray(record.required_next_actions);
  const deferred = actions.filter(isOwnerDecisionAction).map((action) => ({
    ...action,
    actionable: false,
    deferred_until: deferredUntil,
    message,
  }));
  if (deferred.length === 0) return record;
  return {
    ...record,
    required_next_actions: actions.filter((action) => !isOwnerDecisionAction(action)),
    deferred_next_actions: [
      ...asArray(record.deferred_next_actions),
      ...deferred,
    ],
  };
}

function isOwnerDecisionAction(action) {
  if (!action) return false;
  const text = typeof action === "string"
    ? action
    : [
        action.item_id,
        action.code,
        action.action,
        action.message,
        action.path,
      ].filter(Boolean).join(" ");
  return /\bRL-MERGE-\w+/i.test(text) ||
    /owner[_ -]?decision|owner exact-head|owner_exact_head|request_owner_exact_head/i.test(text);
}

function aggregateRequiredActions(sequencing, records) {
  if (sequencing?.next_action?.action) {
    return [
      {
        action: sequencing.next_action.action,
        responsible_role: sequencing.next_action.responsible_role,
        allowed_actor_role: sequencing.next_action.allowed_actor_role,
        message: sequencing.next_action.reason,
      },
    ];
  }
  return records.flatMap((record) => Array.isArray(record.required_next_actions) ? record.required_next_actions : []);
}

function writeInterimAggregate({ resultDir, refs, records, changedFiles, filename }) {
  const aggregate = aggregateReport({ resultDir, refs, records, changedFiles });
  const outputPath = path.join(resultDir, filename);
  writeFileSync(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  return outputPath;
}

function ensureRuntimeValidationEvidence({ resultDir, refs, changedFiles, changedFilesPath, actual }) {
  if (refs.validation || !actual.actualHead) return;
  const outputPath = path.join(resultDir, "runtime-validation-evidence.json");
  const evidenceRefs = [
    changedFilesPath,
    path.join(resultDir, "input-collection.json"),
  ].filter(Boolean);
  const validation = {
    schema_version: "shirube-validation-evidence/v1",
    evidence_id: "SHIRUBE-RAPID-LITE-RUNTIME-VALIDATION",
    target_repo: actual.actualRepo ?? null,
    pr_head_sha: actual.actualHead,
    commands: [
      "collect changed files",
      "run-rapid-lite-report",
    ],
    results: [
      { command: "collect changed files", result: changedFiles.length > 0 ? "PASS" : "PASS_EMPTY" },
      { command: "run-rapid-lite-report", result: "IN_PROGRESS" },
    ],
    validation_results: ["PASS"],
    required_evidence: [
      "PR_head_SHA",
      "changed_files",
      "validation_commands",
      "validation_results",
    ],
    pending_required_evidence: [
      "owner_decision",
      "control_state_completeness_report",
    ],
    evidence_refs: evidenceRefs,
    changed_files_count: changedFiles.length,
    generated_by: "run-rapid-lite-report",
    external_only: true,
    not_committed_to_attested_head: true,
  };
  writeFileSync(outputPath, `${JSON.stringify(validation, null, 2)}\n`);
  refs.validation = outputPath;
}

function renderSummary(report) {
  const lines = [
    MARKER,
    "",
    "## Shirube Rapid/Lite Gates Report",
    "",
    `- Verdict: \`${report.verdict}\``,
    `- Report failed: \`${String(report.report_failed)}\``,
    `- Would block: \`${String(report.would_block)}\``,
    `- Owner must not merge: \`${String(report.owner_must_not_merge)}\``,
    `- Current phase: \`${report.current_phase ?? ""}\``,
    `- Next action: \`${report.next_action?.action ?? ""}\``,
    `- Owner approval allowed: \`${String(report.owner_approval_allowed)}\``,
    `- Merge ready allowed: \`${String(report.merge_ready_allowed)}\``,
    `- Report-only: \`${String(report.report_only)}\``,
    `- Changed files: \`${report.changed_files_count}\``,
    "",
    "This workflow is report-only. `BLOCKED` findings are recorded as PR-visible evidence and uploaded JSON artifacts; they do not fail this workflow or change required checks.",
    "",
    "### Gate Summary",
    "",
    "| Gate | Status | Verdict | Report failed | Current phase | Disposition | Would block |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.gates.map((gate) => `| ${gate.gate} | ${gate.status}${gate.reason ? `<br>${escapeTable(gate.reason)}` : ""} | ${gate.verdict ?? ""} | ${String(gate.report_failed)} | ${gate.current_phase ?? ""} | ${gate.disposition ?? ""} | ${String(gate.would_block)} |`),
    "",
    "### Findings",
    "",
  ];

  for (const gate of report.gates) {
    lines.push(`#### ${gate.gate}`);
    lines.push("");
    if (gate.next_action?.action) {
      lines.push(`Next action: \`${gate.next_action.action}\` - ${gate.next_action.reason ?? ""}`);
      lines.push("");
    }
    appendFindingList(lines, "Blockers", gate.blockers);
    appendFindingList(lines, "Warnings", gate.warnings);
    appendActions(lines, gate.required_next_actions);
    appendDeferredActions(lines, gate.deferred_next_actions);
  }

  lines.push("### Artifact Outputs");
  lines.push("");
  for (const gate of report.gates) {
    if (gate.output_path) lines.push(`- ${gate.gate}: \`${gate.output_path}\``);
  }
  lines.push("");
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

function appendFindingList(lines, title, findingsList) {
  lines.push(`**${title}**`);
  lines.push("");
  if (!Array.isArray(findingsList) || findingsList.length === 0) {
    lines.push("- none");
    lines.push("");
    return;
  }
  for (const item of findingsList.slice(0, 20)) {
    const id = item.item_id ?? item.rule_id ?? item.code ?? "finding";
    const message = item.message ?? item.action ?? "";
    const location = item.path ? ` (${item.path})` : "";
    lines.push(`- \`${id}\`${location}: ${message}`);
  }
  if (findingsList.length > 20) lines.push(`- ... ${findingsList.length - 20} more`);
  lines.push("");
}

function appendActions(lines, actions) {
  lines.push("**Required next actions**");
  lines.push("");
  if (!Array.isArray(actions) || actions.length === 0) {
    lines.push("- none");
    lines.push("");
    return;
  }
  for (const action of actions.slice(0, 20)) {
    if (typeof action === "string") {
      lines.push(`- ${action}`);
    } else {
      const id = action.item_id ?? action.code ?? "action";
      lines.push(`- \`${id}\`: ${action.action ?? action.message ?? ""}`);
    }
  }
  if (actions.length > 20) lines.push(`- ... ${actions.length - 20} more`);
  lines.push("");
}

function appendDeferredActions(lines, actions) {
  if (!Array.isArray(actions) || actions.length === 0) return;
  lines.push("**Deferred next actions**");
  lines.push("");
  for (const action of actions.slice(0, 20)) {
    if (typeof action === "string") {
      lines.push(`- ${action}`);
    } else {
      const id = action.item_id ?? action.code ?? "action";
      const deferredUntil = action.deferred_until ? ` deferred until \`${action.deferred_until}\`` : "";
      lines.push(`- \`${id}\`${deferredUntil}: ${action.message ?? action.action ?? ""}`);
    }
  }
  if (actions.length > 20) lines.push(`- ... ${actions.length - 20} more`);
  lines.push("");
}

function discoverRefs({ prBody, changedFiles }) {
  const explicit = {
    executionContext: refFromBody(prBody, ["execution_context_ref", "execution_context", "context_ref", "context"]),
    executionContextReport: refFromBody(prBody, ["execution_context_report_ref", "execution_context_report", "context_report_ref"]),
    adoptionPlan: refFromBody(prBody, ["adoption_plan_ref", "adoption_plan", "adoption-plan", "adoption plan"]),
    existingState: refFromBody(prBody, ["existing_state_ref", "existing_state", "existing-state", "existing state"]),
    legacyInventory: refFromBody(prBody, ["legacy_inventory_ref", "legacy_inventory", "legacy-inventory"]),
    specReconciliation: refFromBody(prBody, ["spec_reconciliation_ref", "spec_reconciliation", "spec-reconciliation"]),
    lifecycleState: refFromBody(prBody, ["lifecycle_state_ref", "lifecycle_state", "lifecycle-state"]),
    adoptionReport: refFromBody(prBody, ["adoption_report_ref", "adoption_report", "adoption-report"]),
    gateContractReport: refFromBody(prBody, ["gate_contract_report_ref", "gate_contract_report", "gate-contract-report"]),
    designRuleReport: refFromBody(prBody, ["design_rule_report_ref", "design_rule_report", "design-rule-report"]),
    repoSpec: refFromBody(prBody, ["repo_spec_ref", "repo_spec", "repo-spec", "premise_ref"]),
    frameworkLock: refFromBody(prBody, ["framework_lock_ref", "framework_lock", "framework-lock"]),
    handoff: refFromBody(prBody, ["handoff_ref", "handoff", "control_handoff_ref", "control_handoff", "control-handoff"]),
    validation: refFromBody(prBody, ["validation_ref", "validation_evidence_ref", "validation_evidence", "validation-evidence"]),
    ownerDecision: refFromBody(prBody, ["owner_decision_ref", "owner_decision", "owner-decision"]),
    postMerge: refFromBody(prBody, ["post_merge_ref", "post_merge", "post-merge"]),
    matrix: refFromBody(prBody, ["matrix_ref", "gate_contract_matrix_ref", "gate_contract_matrix"]),
    rulePack: refFromBody(prBody, ["rule_pack_ref", "rule_pack", "rule-pack", "design_rule_pack_ref"]),
    sourceMirror: refFromBody(prBody, ["source_mirror_ref", "source_mirror", "source-mirror"]),
    enforcementPolicy: refFromBody(prBody, ["enforcement_policy_ref", "enforcement_policy", "enforcement-policy"]),
    enforcementPolicyReport: refFromBody(prBody, ["enforcement_policy_report_ref", "enforcement_policy_report", "enforcement-policy-report"]),
    readinessReport: refFromBody(prBody, ["readiness_report_ref", "readiness_report", "full_adoption_report_ref", "full_adoption_report"]),
    auditChecklist: refFromBody(prBody, ["audit_checklist_ref", "audit_checklist", "audit-checklist"]),
    structuredAudit: refFromBody(prBody, ["structured_audit_ref", "structured_audit", "structured-audit"]),
    structuredAuditSource: refFromBody(prBody, ["structured_audit_source_ref", "structured_audit_source", "audit_source_ref", "audit_source"]),
    auditMachineEvidence: refFromBody(prBody, ["audit_machine_evidence_ref", "audit_machine_evidence", "audit-machine-evidence", "machine_evidence_ref", "machine_evidence"]),
    auditChecklistReport: refFromBody(prBody, ["audit_checklist_report_ref", "audit_checklist_report", "audit-checklist-report"]),
    reviewPlan: refFromBody(prBody, ["review_plan_ref", "review_plan", "review-plan"]),
    reviewPlanReport: refFromBody(prBody, ["review_plan_report_ref", "review_plan_report", "review-plan-report"]),
    additionalReview: refFromBody(prBody, ["additional_review_ref", "additional_review", "additional-review", "protected_review_ref", "protected_review"]),
    additionalReviewSource: refFromBody(prBody, ["additional_review_source_ref", "additional_review_source", "additional-review-source", "protected_review_source_ref", "protected_review_source"]),
    auditRecord: refFromBody(prBody, ["audit_record_ref", "audit_record", "audit-ref", "reviewer_audit_ref"]),
    auditItemSet: refFromBody(prBody, ["audit_item_set_ref", "audit_item_set", "audit-item-set"]),
    controlState: refFromBody(prBody, ["control_state_ref", "control_state", "control-state", "control_state_completeness_ref"]),
  };

  const schemaMatches = schemasFromFiles(walkFiles(changedFiles));
  const records = [];
  const refs = {
    executionContext: resolveRef({ name: "execution_context", explicit: explicit.executionContext, candidates: bySchema(schemaMatches, "shirube-execution-context/v1"), defaults: [".shirube/execution-context.yaml"], records }),
    executionContextReport: resolveRef({ name: "execution_context_report", explicit: explicit.executionContextReport, defaults: [".shirube/reports/execution-context.json"], records }),
    adoptionPlan: resolveRef({ name: "adoption_plan", explicit: explicit.adoptionPlan, candidates: bySchema(schemaMatches, "shirube-adoption-intake/v1"), defaults: [".shirube/adoption-intake.yaml", ".shirube/adoption/intake.yaml"], records }),
    existingState: resolveRef({ name: "existing_state", explicit: explicit.existingState, candidates: bySchema(schemaMatches, "shirube-existing-state-scan/v1"), defaults: [".shirube/existing-state-scan.yaml", ".shirube/adoption/existing-state-scan.yaml"], records }),
    legacyInventory: resolveRef({ name: "legacy_inventory", explicit: explicit.legacyInventory, defaults: [".shirube/legacy-inventory.yaml"], records }),
    specReconciliation: resolveRef({ name: "spec_reconciliation", explicit: explicit.specReconciliation, candidates: bySchema(schemaMatches, "shirube-spec-reconciliation-plan/v1"), defaults: [".shirube/spec-reconciliation-plan.yaml"], records }),
    lifecycleState: resolveRef({ name: "lifecycle_state", explicit: explicit.lifecycleState, candidates: bySchema(schemaMatches, "shirube-lifecycle-state/rapid-lite/v1"), defaults: [".shirube/lifecycle-state.yaml", ".shirube/lifecycle-state.rapid-lite.yaml"], records }),
    adoptionReport: resolveRef({ name: "adoption_report", explicit: explicit.adoptionReport, defaults: [".shirube/reports/adoption.json"], records }),
    gateContractReport: resolveRef({ name: "gate_contract_report", explicit: explicit.gateContractReport, defaults: [".shirube/reports/gate-contract.json"], records }),
    designRuleReport: resolveRef({ name: "design_rule_report", explicit: explicit.designRuleReport, defaults: [".shirube/reports/design-rules.json"], records }),
    repoSpec: resolveRef({ name: "repo_spec", explicit: explicit.repoSpec, defaults: [".shirube/repo-spec.yaml"], records }),
    frameworkLock: resolveRef({ name: "framework_lock", explicit: explicit.frameworkLock, defaults: [".shirube/shirube-framework-lock.yaml"], records }),
    handoff: resolveRef({ name: "handoff", explicit: explicit.handoff, candidates: bySchema(schemaMatches, "shirube-control-handoff/rapid-lite/v1"), defaults: [".shirube/control-handoff.yaml"], records }),
    validation: resolveRef({ name: "validation", explicit: explicit.validation, defaults: [".shirube/evidence/validation.yaml", ".shirube/evidence/validation-evidence.yaml"], records }),
    ownerDecision: resolveRef({ name: "owner_decision", explicit: explicit.ownerDecision, defaults: [".shirube/evidence/owner-decision.yaml"], records }),
    postMerge: resolveRef({ name: "post_merge", explicit: explicit.postMerge, defaults: [".shirube/evidence/post-merge.yaml"], records }),
    matrix: resolveRef({ name: "matrix", explicit: explicit.matrix, defaults: [".shirube/gate-contracts/shirube-v3-rapid-lite-gate-contract-matrix.yaml"], records }),
    rulePack: firstExisting(explicit.rulePack, ".shirube/design-rule-packs/shirube-default-design-rules.yaml"),
    sourceMirror: resolveRef({ name: "source_mirror", explicit: explicit.sourceMirror, candidates: bySchema(schemaMatches, "shirube-source-mirror/v1"), defaults: [".shirube/source-mirrors/control-issue.yaml"], records }),
    enforcementPolicy: resolveRef({ name: "enforcement_policy", explicit: explicit.enforcementPolicy, candidates: bySchema(schemaMatches, "shirube-enforcement-policy/v1"), defaults: [".shirube/enforcement-policy.yaml"], records }),
    enforcementPolicyReport: resolveRef({ name: "enforcement_policy_report", explicit: explicit.enforcementPolicyReport, defaults: [".shirube/reports/enforcement-policy.json"], records }),
    readinessReport: resolveRef({ name: "readiness_report", explicit: explicit.readinessReport, defaults: [".shirube/reports/readiness.json", ".shirube/readiness.yaml"], records }),
    auditChecklist: resolveRef({ name: "audit_checklist", explicit: explicit.auditChecklist, candidates: bySchema(schemaMatches, "shirube-audit-checklist/v1").filter(notFixturePath), defaults: [], records }),
    structuredAudit: resolveRef({ name: "structured_audit", explicit: explicit.structuredAudit, candidates: bySchema(schemaMatches, "shirube-structured-audit/v1").filter(notFixturePath), defaults: [], records }),
    structuredAuditSource: resolveRef({ name: "structured_audit_source", explicit: explicit.structuredAuditSource, candidates: bySchema(schemaMatches, "shirube-comment-backed-audit-source/v1").filter(notFixturePath), defaults: [], records }),
    auditMachineEvidence: resolveRef({ name: "audit_machine_evidence", explicit: explicit.auditMachineEvidence, candidates: bySchema(schemaMatches, "shirube-machine-evidence/v1").filter(notFixturePath), defaults: [], records }),
    auditChecklistReport: resolveRef({ name: "audit_checklist_report", explicit: explicit.auditChecklistReport, candidates: bySchema(schemaMatches, "shirube-audit-checklist-check/v1").filter(notFixturePath), defaults: [], records }),
    reviewPlan: resolveRef({ name: "review_plan", explicit: explicit.reviewPlan, candidates: bySchema(schemaMatches, "shirube-review-plan/v1"), defaults: [], records }),
    reviewPlanReport: resolveRef({ name: "review_plan_report", explicit: explicit.reviewPlanReport, candidates: bySchema(schemaMatches, "shirube-review-plan-check/v1"), defaults: [], records }),
    additionalReview: resolveRef({ name: "additional_review", explicit: explicit.additionalReview, candidates: bySchema(schemaMatches, "shirube-additional-review/v1").filter(notFixturePath), defaults: [], records }),
    additionalReviewSource: resolveRef({ name: "additional_review_source", explicit: explicit.additionalReviewSource, candidates: bySchema(schemaMatches, "shirube-comment-backed-additional-review-source/v1").filter(notFixturePath), defaults: [], records }),
    auditRecord: resolveRef({ name: "audit_record", explicit: explicit.auditRecord, candidates: [...bySchema(schemaMatches, "shirube-audit/v1"), ...bySchema(schemaMatches, "shirube-audit-record/v1")], defaults: [], records }),
    auditItemSet: resolveRef({ name: "audit_item_set", explicit: explicit.auditItemSet, candidates: bySchema(schemaMatches, "shirube-audit-item-set/v1"), defaults: [], records }),
    controlState: resolveRef({ name: "control_state", explicit: explicit.controlState, candidates: bySchema(schemaMatches, "shirube-control-state-completeness-config/v1"), defaults: [".shirube/control-state-completeness.yaml"], records }),
  };
  return { refs, records };
}

function refFromBody(body, keys) {
  if (!body) return null;
  for (const key of keys) {
    const pattern = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:${escapeRegExp(key)})\\s*:\\s*([^\\n]+?)\\s*(?=\\n|$)`, "i");
    const match = body.match(pattern);
    const value = sanitizeRef(match?.[1]);
    if (value) return value;
  }
  return null;
}

function sanitizeRef(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/^["'`]|["'`]$/g, "");
  if (!cleaned || /^https?:\/\//i.test(cleaned) || cleaned === "null") return null;
  return cleaned.split(/\s+/)[0];
}

function schemasFromFiles(files) {
  const matches = [];
  for (const file of [...new Set(files)].sort((a, b) => a.localeCompare(b))) {
    if (!existsSync(file) || !/\.(ya?ml|json)$/i.test(file)) continue;
    try {
      const body = readStructuredFile(file);
      const schema = isObject(body) ? body.schema_version : null;
      if (schema) matches.push({ file, schema });
    } catch {
      // Input discovery must not fail the report-only workflow.
    }
  }
  return matches;
}

function bySchema(matches, schema) {
  return matches.filter((entry) => entry.schema === schema).map((entry) => entry.file);
}

function notFixturePath(file) {
  return !/^test\/fixtures\//.test(String(file ?? "").replace(/\\/g, "/"));
}

function firstExisting(...values) {
  return values.flat().filter(Boolean).find((value) => existsSync(value)) ?? null;
}

function firstPresent(...values) {
  return values.find((value) => {
    if (value === undefined || value === null) return false;
    const text = String(value).trim();
    return text.length > 0 && !/^(pending|todo|tbd|null|none)$/i.test(text) && !/^<.*>$/.test(text);
  });
}

function walkFiles(root) {
  return Array.isArray(root) ? root.filter(Boolean) : [];
}

function resolveRef({ name, explicit, candidates = [], defaults = [], records }) {
  if (explicit) return explicit;
  const currentPrCandidates = [...new Set(candidates.flat().filter(Boolean).filter((value) => existsSync(value)))]
    .sort((a, b) => a.localeCompare(b));
  if (currentPrCandidates.length > 1) {
    records.push(discoveryAmbiguityRecord(name, currentPrCandidates));
    return null;
  }
  if (currentPrCandidates.length === 1) return currentPrCandidates[0];
  return firstExisting(...defaults);
}

function discoveryAmbiguityRecord(name, candidates) {
  const finding = {
    item_id: "RL-DISC-001",
    code: "ambiguous_current_pr_artifact",
    message: `Multiple current-PR ${name} candidates were found; use an explicit PR body ref.`,
    path: name,
    candidates,
  };
  return {
    gate: "discovery",
    status: "ran",
    reason: null,
    output_path: null,
    exit_code: 0,
    verdict: "BLOCKED",
    report_failed: false,
    current_phase: null,
    next_action: {
      action: "add_explicit_artifact_reference",
      responsible_role: "dev",
      allowed_actor_role: "dev",
      reason: finding.message,
    },
    owner_approval_allowed: false,
    merge_ready_allowed: false,
    forbidden_next_actions: [
      "owner_exact_head_approval",
      "mark_merge_ready",
      "merge",
    ],
    audit_required: null,
    audit_completion: null,
    additional_review_completion: null,
    owner_decision_status: null,
    head_change: null,
    disposition: null,
    would_block: true,
    blockers: [finding],
    warnings: [],
    required_next_actions: [
      {
        item_id: finding.item_id,
        action: finding.message,
      },
    ],
    deferred_next_actions: [],
  };
}

function readChangedFiles(filePath) {
  if (!filePath) return { files: [], failure: null };
  if (!existsSync(filePath)) {
    return {
      files: [],
      failure: {
        code: "changed_files_missing",
        message: `Changed-files input does not exist: ${filePath}`,
        path: filePath,
      },
    };
  }
  try {
    return {
      files: readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .sort((a, b) => a.localeCompare(b)),
      failure: null,
    };
  } catch (error) {
    return {
      files: [],
      failure: {
        code: "changed_files_unreadable",
        message: error instanceof Error ? error.message : String(error),
        path: filePath,
      },
    };
  }
}

function findings(report, key) {
  const primary = Array.isArray(report[key]) ? report[key] : [];
  if (key === "blockers" && Array.isArray(report.hard_blocks)) return [...primary, ...report.hard_blocks];
  return primary;
}

function aggregateVerdict(verdicts) {
  if (verdicts.includes("FAILURE")) return "FAILURE";
  if (verdicts.includes("BLOCKED")) return "BLOCKED";
  if (verdicts.includes("PASS_WITH_WARN")) return "PASS_WITH_WARN";
  if (verdicts.includes("PASS")) return "PASS";
  return "SKIPPED";
}

function failureRecord(gate, finding) {
  return {
    gate,
    status: "ran",
    reason: null,
    output_path: null,
    exit_code: 1,
    verdict: "FAILURE",
    report_failed: true,
    current_phase: null,
    next_action: null,
    owner_approval_allowed: null,
    merge_ready_allowed: null,
    forbidden_next_actions: [],
    audit_required: null,
    audit_completion: null,
    additional_review_completion: null,
    owner_decision_status: null,
    head_change: null,
    disposition: null,
    would_block: true,
    blockers: [finding],
    warnings: [],
    required_next_actions: [
      {
        code: finding.code,
        message: finding.message,
      },
    ],
    deferred_next_actions: [],
  };
}

function readInputFailureRecord(filePath) {
  if (!existsSync(filePath)) {
    return failureRecord("input-collection", {
      code: "input_failure_missing",
      message: `Input failure artifact does not exist: ${filePath}`,
      path: filePath,
    });
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return failureRecord("input-collection", {
      code: parsed.code ?? "input_collection_failed",
      message: parsed.message ?? parsed.error ?? "Input collection failed.",
      path: parsed.path ?? filePath,
    });
  } catch (error) {
    return failureRecord("input-collection", {
      code: "input_failure_unreadable",
      message: error instanceof Error ? error.message : String(error),
      path: filePath,
    });
  }
}

function actualContextFromOptions(options) {
  const fromEvent = actualFromGithubEvent();
  return {
    actualRepo: stringOption(options["actual-repo"]) ?? process.env.GITHUB_REPOSITORY ?? fromEvent.actualRepo ?? null,
    actualPr: stringOption(options["actual-pr"]) ?? fromEvent.actualPr ?? null,
    actualBranch: stringOption(options["actual-branch"]) ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? fromEvent.actualBranch ?? null,
    actualHead: stringOption(options["actual-head"]) ?? fromEvent.actualHead ?? process.env.GITHUB_SHA ?? null,
  };
}

function actualFromGithubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return {};
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    return {
      actualRepo: event.repository?.full_name ?? null,
      actualPr: event.pull_request?.number ? String(event.pull_request.number) : null,
      actualBranch: event.pull_request?.head?.ref ?? event.ref_name ?? null,
      actualHead: event.pull_request?.head?.sha ?? event.after ?? null,
    };
  } catch {
    return {};
  }
}

function addArg(args, key, value) {
  if (value) args.push(key, value);
}

function addFlag(args, key, enabled) {
  if (enabled) args.push(key);
}

function isCurrentRunAuditSource(sourcePath, resultDir) {
  if (!sourcePath || !resultDir) return false;
  const expectedPath = path.resolve(resultDir, "structured-audit-source.json");
  return path.resolve(sourcePath) === expectedPath && existsSync(sourcePath);
}

function isCurrentRunAdditionalReviewSource(sourcePath, resultDir) {
  if (!sourcePath || !resultDir) return false;
  const expectedPath = path.resolve(resultDir, "additional-review-source.json");
  return path.resolve(sourcePath) === expectedPath && existsSync(sourcePath);
}

function gateScript(filename) {
  return path.join(SCRIPT_DIR, filename);
}

function stringOption(value) {
  return typeof value === "string" ? value : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTable(value) {
  return String(value).replace(/\|/g, "\\|");
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.format !== "json") {
    process.stdout.write(`${JSON.stringify({
      schema: SCHEMA,
      verdict: "FAILURE",
      would_block: false,
      required_next_actions: [{ code: "unsupported_format", message: "--format json is required." }],
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const report = buildRapidLiteReport(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (isMain(import.meta.url)) {
  main();
}
