import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERDICTS = ["PASS", "WARN", "BLOCK"];
export const REPORT_ONLY_VERDICTS = ["PASS_WITH_WARN", "BLOCKED"];
export const FAILURE_VERDICT = "FAILURE";
export const ALL_VERDICTS = [...VERDICTS, ...REPORT_ONLY_VERDICTS, FAILURE_VERDICT];

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { options, positionals };
}

export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return importMetaUrl === pathToFileURL(process.argv[1]).href;
  }
}

export function readStructuredFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const text = readFileSync(filePath, "utf8");
  if (extname(filePath) === ".json") {
    return JSON.parse(text);
  }
  const json = execFileSync("ruby", [
    "-ryaml",
    "-rjson",
    "-rdate",
    "-e",
    [
      "body = YAML.safe_load(STDIN.read, permitted_classes: [Date, Time], aliases: true)",
      "puts JSON.generate(body)",
    ].join("; "),
  ], { input: text, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(json);
}

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function isValidVerdict(verdict) {
  return ALL_VERDICTS.includes(verdict);
}

export function isWouldBlockVerdict(verdict) {
  return verdict === "BLOCK" || verdict === "BLOCKED";
}

export function isWarningVerdict(verdict) {
  return verdict === "WARN" || verdict === "PASS_WITH_WARN";
}

export function exitForVerdict(verdict) {
  const options = arguments[1] ?? {};
  const reportOnly = options.reportOnly ?? true;
  if (!isValidVerdict(verdict)) {
    process.exitCode = 1;
    return;
  }
  if (verdict === FAILURE_VERDICT) {
    process.exitCode = 1;
    return;
  }
  if (isWouldBlockVerdict(verdict) && !reportOnly) {
    process.exitCode = 1;
  }
}

export function buildResult({ gate, verdict, reasons = [], remediation, ...rest }) {
  const resolvedRemediation = remediation ?? {
    what: verdict === "PASS" ? "No remediation required." : `Resolve ${gate} finding(s).`,
    doc_ref: "docs/standards/shirube-ai-development-governance-standard-v1.md",
  };
  const remediationContract = verdict === "PASS"
    ? {}
    : { remediation_contract: buildRemediationContract({ gate, verdict, reasons, remediation: resolvedRemediation, rest }) };
  return {
    gate,
    verdict,
    would_block: isWouldBlockVerdict(verdict),
    reasons,
    remediation: resolvedRemediation,
    ...remediationContract,
    ...rest,
  };
}

export function buildRemediationContract({ gate, verdict, reasons = [], remediation = {}, rest = {} }) {
  const actionableReasons = reasons.flatMap(flattenReasons);
  const missingPrerequisites = actionableReasons
    .map((reason) => reason.code ?? reason.gate ?? reason.field ?? reason.message)
    .filter(Boolean);
  return {
    verdict,
    current_phase: currentPhase(rest),
    blocked_reason: blockedReason(actionableReasons, verdict),
    missing_prerequisites: [...new Set(missingPrerequisites)],
    required_next_actions: requiredNextActions(remediation, actionableReasons),
    responsible_role: responsibleRole(gate),
    allowed_next_phases: allowedNextPhases(gate, rest),
    forbidden_next_phases: forbiddenNextPhases(verdict),
    required_evidence: requiredEvidence(gate, actionableReasons),
    observed_evidence: observedEvidence(rest),
    reference_docs: referenceDocs(gate, remediation),
  };
}

export function verdictFromFindings(findings) {
  if (findings.some((finding) => finding.severity === "BLOCK")) return "BLOCK";
  if (findings.some((finding) => finding.severity === "WARN")) return "WARN";
  return "PASS";
}

export function combineVerdicts(verdicts) {
  if (verdicts.includes(FAILURE_VERDICT)) return FAILURE_VERDICT;
  if (verdicts.some(isWouldBlockVerdict)) return "BLOCK";
  if (verdicts.some(isWarningVerdict)) return "WARN";
  return "PASS";
}

function flattenReasons(reason) {
  if (!reason) return [];
  const nested = Array.isArray(reason.reasons) ? reason.reasons.flatMap(flattenReasons) : [];
  if (isObject(reason)) return [reason, ...nested];
  return nested;
}

function currentPhase(rest) {
  return rest.current_phase ?? rest.observed?.current_phase ?? process.env.SHIRUBE_CURRENT_PHASE ?? "UNKNOWN";
}

function blockedReason(reasons, verdict) {
  const blocking = reasons.find((reason) => reason.severity === "BLOCK") ?? reasons[0];
  return blocking?.message ?? blocking?.code ?? (verdict === "WARN" ? "Warnings require review." : "Blocking prerequisites are missing.");
}

function requiredNextActions(remediation, reasons) {
  const actions = [];
  if (remediation.what) actions.push(remediation.what);
  for (const reason of reasons) {
    if (reason.message && !actions.includes(reason.message)) actions.push(reason.message);
  }
  return actions.length > 0 ? actions : ["Resolve the reported Shirube gate findings."];
}

function responsibleRole(gate) {
  const key = String(gate).replace(/^controller:/, "");
  const roles = {
    "repo-spec": "repo_owner",
    planning: "domain_designer",
    "spec-to-cell-trace": "shirube_command_owner",
    phase: "shirube_command_owner",
    "design-conformance": "domain_designer",
    readiness: "release_owner",
    "dev-loop": "release_owner",
    "change-flow": "implementation_owner",
    "script-error": "implementation_owner",
    controller: "release_owner",
  };
  return roles[key] ?? roles[String(gate)] ?? "release_owner";
}

function allowedNextPhases(gate, rest) {
  if (Array.isArray(rest.allowed_next_phases)) return rest.allowed_next_phases;
  const key = String(gate).replace(/^controller:/, "");
  const phases = {
    "repo-spec": ["REPO_SPEC_DRAFTED", "REPO_SPEC_CONFIRMED"],
    planning: ["PREMISE_SPEC_CONFIRMED", "INVENTORY_CONFIRMED", "CELL_DRAFTED"],
    "spec-to-cell-trace": ["CELL_TRACE_PASSED"],
    phase: ["REPO_SPEC_CONFIRMED", "PREMISE_SPEC_CONFIRMED", "INVENTORY_CONFIRMED", "CELL_DRAFTED"],
    "design-conformance": ["IMPL_AUDITED", "EXECUTION_READY"],
    readiness: ["REPO_SPEC_CONFIRMED", "CELL_DRAFTED"],
    "dev-loop": ["IMPL_AUDITED", "EXECUTION_READY"],
    "change-flow": ["CELL_DRAFTED"],
  };
  return phases[key] ?? [];
}

function forbiddenNextPhases(verdict) {
  if (verdict === "PASS") return [];
  return ["EXECUTION_READY", "IMPLEMENTED", "MERGED", "RELEASED"];
}

function requiredEvidence(gate, reasons) {
  const key = String(gate).replace(/^controller:/, "");
  const defaults = {
    "repo-spec": [".shirube/repo-spec.yaml"],
    planning: ["premise_confirmation_ref", "inventory_confirmation_ref", "owner_confirmation_ref"],
    "spec-to-cell-trace": [".shirube/specs/", ".shirube/cells/"],
    phase: [".shirube/phase-state.json", "scripts/shirube/phases.config.json"],
    "design-conformance": [".shirube/design-conformance-matrix.json"],
    readiness: [".shirube/repo-spec.yaml", "planning evidence"],
    "dev-loop": ["trace evidence", "phase evidence", "design conformance evidence"],
    "change-flow": [".shirube/specs/", ".shirube/cells/"],
  };
  const fromReasons = reasons
    .map((reason) => reason.field ?? reason.requirement ?? reason.control_id ?? reason.cell)
    .filter(Boolean);
  return [...new Set([...(defaults[key] ?? []), ...fromReasons])];
}

function observedEvidence(rest) {
  const observed = [];
  if (rest.checked_file) observed.push({ kind: "checked_file", value: rest.checked_file });
  if (rest.current_phase !== undefined) observed.push({ kind: "current_phase", value: rest.current_phase });
  if (rest.target_phase !== undefined) observed.push({ kind: "target_phase", value: rest.target_phase });
  if (rest.observed !== undefined) observed.push({ kind: "observed", value: rest.observed });
  if (rest.changed_files !== undefined) observed.push({ kind: "changed_files", value: rest.changed_files });
  if (rest.matrix !== undefined) observed.push({ kind: "matrix", value: rest.matrix });
  if (rest.child_results !== undefined) observed.push({ kind: "child_results", value: rest.child_results.map((result) => ({ gate: result.gate, verdict: result.verdict })) });
  return observed;
}

function referenceDocs(gate, remediation) {
  const refs = [
    remediation.doc_ref,
    ".shirube/repo-spec.yaml",
    "docs/standards/shirube-ai-development-governance-standard-v1.md",
  ].filter(Boolean);
  if (String(gate).includes("phase")) refs.push("scripts/shirube/phases.config.json");
  return [...new Set(refs)];
}

export function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

export function asBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value !== "string") return false;
  return ["true", "yes", "required"].includes(value.trim().toLowerCase());
}

export function present(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    return value.trim() !== "" && !["null", "none", "n/a", "pending", "false"].includes(value.trim().toLowerCase());
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

export function planningFields(source) {
  const hierarchy = isObject(source?.planning_hierarchy) ? source.planning_hierarchy : {};
  return {
    ...source,
    ...hierarchy,
  };
}

export function listFiles(dir, predicate = () => true) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      files.push(...listFiles(path, predicate));
    } else if (predicate(path)) {
      files.push(path);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export function extractIds(text, prefix) {
  const pattern = new RegExp(`\\b${escapeRegExp(prefix)}-[A-Z0-9][A-Z0-9._:-]*\\b`, "g");
  return [...new Set(text.match(pattern) ?? [])]
    .filter((id) => id !== `${prefix}-ID`)
    .sort((a, b) => a.localeCompare(b));
}

export function loadFixtureOrFiles(options, loader) {
  if (options.fixture) return readStructuredFile(options.fixture);
  return loader();
}

export function buildFailureResult({ code = "script_failure", message }) {
  return {
    gate: "script-error",
    verdict: FAILURE_VERDICT,
    would_block: false,
    reasons: [{ code, message }],
    remediation: {
      what: "Fix the script invocation, malformed input, missing artifact, or invalid verdict and rerun the gate.",
      doc_ref: "docs/standards/shirube-ai-development-governance-standard-v1.md",
    },
  };
}

export function safeRun(fn) {
  const options = arguments[1] ?? {};
  try {
    const result = fn();
    if (!isObject(result)) {
      throw new Error("Gate script returned a non-object result.");
    }
    if (!isValidVerdict(result.verdict)) {
      writeResult(buildFailureResult({
        code: "unknown_verdict",
        message: `Unknown verdict: ${String(result.verdict)}`,
      }));
      process.exitCode = 1;
      return;
    }
    writeResult({ ...result, would_block: result.would_block ?? isWouldBlockVerdict(result.verdict) });
    exitForVerdict(result.verdict, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeResult(buildFailureResult({ code: "script_error", message }));
    process.exitCode = 1;
  }
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
