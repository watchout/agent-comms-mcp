#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  isMain,
  isObject,
  parseArgs,
  readStructuredFile,
} from "./lib.mjs";
import {
  normalizeControlHandoff,
} from "./normalize-control-handoff.mjs";

const SCHEMA = "shirube-design-rule-check/v1";
const DEFAULT_RULE_PACK = ".shirube/design-rule-packs/shirube-default-design-rules.yaml";
const PROTECTED_FORBIDDEN_NEXT = ["EXECUTION_READY", "IMPLEMENTED", "MERGED", "RELEASED"];

export function buildDesignRuleReport(input) {
  const rulePack = input.rulePack;
  const rules = Array.isArray(rulePack?.rules) ? rulePack.rules : [];
  const ruleResults = [];
  const evidence = [];

  if (input.rulePackPath) {
    evidence.push({ code: "rule_pack", source: "file", detail: input.rulePackPath });
  }
  if (input.changedFilesPath) {
    evidence.push({ code: "changed_files", source: "file", detail: input.changedFilesPath });
  }
  if (input.diffRoot) {
    evidence.push({ code: "diff_root", source: "filesystem", detail: input.diffRoot });
  }
  if (input.handoffPath) {
    evidence.push({ code: "handoff", source: "file", detail: input.handoffPath });
  }
  if (input.prBodyPath) {
    evidence.push({ code: "pr_body", source: "file", detail: input.prBodyPath });
  }
  if (input.evidencePath) {
    evidence.push({ code: "evidence", source: "file", detail: input.evidencePath });
  }

  if (!hasRulePackIdentity(rulePack)) {
    ruleResults.push(finding({
      ruleId: "DR-RULEPACK-001",
      code: "missing_rule_pack_or_version",
      severity: "BLOCK",
      verdict: "FAIL",
      path: input.rulePackPath || "rule_pack",
      evidence: ["schema_version and rule_pack_id are required"],
    }));
  }

  const changedFiles = input.changedFiles ?? [];
  const changedFileRecords = changedFiles.map((file) => ({
    path: file,
    content: readChangedFileContent({ diffRoot: input.diffRoot, file }),
  }));
  const textInputs = buildTextInputs(input, changedFileRecords);

  for (const rule of rules) {
    if (!isObject(rule)) continue;
    const checkType = rule.check?.type;
    if (checkType === "rule_pack_has_identity") continue;
    const results = evaluateRule({ rule, input, changedFileRecords, textInputs });
    if (results.length === 0) {
      ruleResults.push(passResult(rule));
    } else {
      ruleResults.push(...results);
    }
  }

  const blockers = ruleResults.filter((result) => result.severity === "BLOCK" && result.verdict === "FAIL");
  const warnings = ruleResults.filter((result) => result.severity === "WARN" && result.verdict === "WARN");
  const verdict = blockers.length > 0 ? "BLOCKED" : warnings.length > 0 ? "PASS_WITH_WARN" : "PASS";

  return {
    schema: SCHEMA,
    rule_pack_id: stringOrNull(rulePack?.rule_pack_id),
    verdict,
    would_block: verdict === "BLOCKED",
    rule_results: stableRuleResults(ruleResults),
    blockers: blockers.map(toSummary),
    warnings: warnings.map(toSummary),
    evidence: uniqueEvidence(evidence),
    required_next_actions: requiredNextActions(blockers, warnings),
  };
}

function evaluateRule({ rule, input, changedFileRecords, textInputs }) {
  switch (rule.check?.type) {
    case "text_pattern_absent":
      return evaluateLlmAuthorityRule({ rule, textInputs });
    case "hard_delete_requires_soft_delete_policy":
      return evaluateHardDeleteRule({ rule, input, changedFileRecords });
    case "source_generality_heuristic":
      return evaluateGeneralityRule({ rule, changedFileRecords });
    case "exact_duplicate_block":
      return evaluateDuplicateRule({ rule, changedFileRecords });
    case "source_configurable_value_heuristic":
      return evaluateConfigurableValueRule({ rule, changedFileRecords });
    case "protected_surface_requires_declaration":
      return evaluateProtectedSurfaceRule({ rule, input, changedFileRecords });
    case "business_constant_heuristic":
      return evaluateBusinessConstantRule({ rule, changedFileRecords });
    default:
      return [];
  }
}

function evaluateLlmAuthorityRule({ rule, textInputs }) {
  const patterns = asStringArray(rule.check?.forbidden_patterns);
  const results = [];
  for (const input of textInputs) {
    for (const pattern of patterns) {
      if (containsPattern(input.text, pattern)) {
        results.push(finding({
          ruleId: rule.rule_id,
          code: rule.code,
          severity: "BLOCK",
          verdict: "FAIL",
          path: input.path,
          evidence: [pattern],
        }));
      }
    }
  }
  return uniqueByKey(results, (result) => `${result.rule_id}:${result.path}:${result.evidence.join("|")}`);
}

function evaluateHardDeleteRule({ rule, input, changedFileRecords }) {
  const hardDeletePatterns = asStringArray(rule.check?.hard_delete_patterns);
  const softDeleteMarkers = asStringArray(rule.check?.soft_delete_markers);
  const results = [];
  for (const record of changedFileRecords) {
    if (!record.content || !isSourceOrMigrationLike(record.path)) continue;
    const matched = hardDeletePatterns.filter((pattern) => containsPattern(record.content, pattern));
    if (matched.length === 0) continue;
    if (hasSoftDeletePolicy(record.content, softDeleteMarkers)) continue;
    if (hasApprovedException({ input, ruleId: rule.rule_id, filePath: record.path })) continue;
    results.push(finding({
      ruleId: rule.rule_id,
      code: rule.code,
      severity: "BLOCK",
      verdict: "FAIL",
      path: record.path,
      evidence: matched,
    }));
  }
  return results;
}

function evaluateGeneralityRule({ rule, changedFileRecords }) {
  const markers = asStringArray(rule.check?.markers);
  const results = [];
  for (const record of changedFileRecords) {
    if (!record.content || !isSourcePath(record.path)) continue;
    const matched = markers.filter((marker) => containsPattern(record.content, marker));
    if (matched.length > 0 || hasEnumLikeBusinessArray(record.content) || hasRepeatedLiteralBranches(record.content)) {
      results.push(finding({
        ruleId: rule.rule_id,
        code: rule.code,
        severity: "WARN",
        verdict: "WARN",
        path: record.path,
        evidence: matched.length > 0 ? matched : ["source contains configurable-looking domain shape"],
      }));
    }
  }
  return results;
}

function evaluateDuplicateRule({ rule, changedFileRecords }) {
  const warnThreshold = Number(rule.check?.warn_threshold_lines ?? 6);
  const blockThreshold = Number(rule.check?.block_threshold_lines ?? 12);
  const ignorePaths = asStringArray(rule.check?.ignore_paths);
  const results = [];
  for (const record of changedFileRecords) {
    if (!record.content || !isSourcePath(record.path) || matchesAnyGlob(record.path, ignorePaths)) continue;
    const duplicate = longestDuplicateBlock(record.content);
    if (duplicate.length >= blockThreshold) {
      results.push(finding({
        ruleId: rule.rule_id,
        code: rule.code,
        severity: "BLOCK",
        verdict: "FAIL",
        path: record.path,
        evidence: [`duplicate block length ${duplicate.length}`],
      }));
    } else if (duplicate.length >= warnThreshold) {
      results.push(finding({
        ruleId: rule.rule_id,
        code: rule.code,
        severity: "WARN",
        verdict: "WARN",
        path: record.path,
        evidence: [`duplicate block length ${duplicate.length}`],
      }));
    }
  }
  return results;
}

function evaluateConfigurableValueRule({ rule, changedFileRecords }) {
  const allowedPaths = asStringArray(rule.check?.allowed_paths);
  const results = [];
  for (const record of changedFileRecords) {
    if (!record.content || !isSourcePath(record.path) || matchesAnyGlob(record.path, allowedPaths)) continue;
    const repeated = repeatedStringLiterals(record.content, Number(rule.check?.repeated_literal_min_count ?? 2));
    const urls = environmentSpecificValues(record.content);
    const evidence = [...repeated, ...urls];
    if (evidence.length > 0) {
      results.push(finding({
        ruleId: rule.rule_id,
        code: rule.code,
        severity: "WARN",
        verdict: "WARN",
        path: record.path,
        evidence: evidence.slice(0, 5),
      }));
    }
  }
  return results;
}

function evaluateProtectedSurfaceRule({ rule, input, changedFileRecords }) {
  if (hasProtectedDeclaration(input.handoff)) return [];
  const protectedPathPatterns = asStringArray(rule.check?.protected_path_patterns);
  const protectedContentPatterns = asStringArray(rule.check?.protected_content_patterns);
  const results = [];
  for (const record of changedFileRecords) {
    const evidence = [];
    if (matchesAnyGlob(record.path, protectedPathPatterns)) evidence.push("protected path");
    for (const pattern of protectedContentPatterns) {
      if (record.content && containsPattern(record.content, pattern)) evidence.push(pattern);
    }
    if (evidence.length > 0) {
      results.push(finding({
        ruleId: rule.rule_id,
        code: rule.code,
        severity: "BLOCK",
        verdict: "FAIL",
        path: record.path,
        evidence,
      }));
    }
  }
  return results;
}

function evaluateBusinessConstantRule({ rule, changedFileRecords }) {
  const markers = asStringArray(rule.check?.markers);
  const results = [];
  for (const record of changedFileRecords) {
    if (!record.content || !isSourcePath(record.path) || isAllowedConfigLocation(record.path)) continue;
    const matched = markers.filter((marker) => containsPattern(record.content, marker));
    if (matched.length > 0) {
      results.push(finding({
        ruleId: rule.rule_id,
        code: rule.code,
        severity: "WARN",
        verdict: "WARN",
        path: record.path,
        evidence: matched,
      }));
    }
  }
  return results;
}

function readInput(options) {
  const rulePackPath = typeof options["rule-pack"] === "string"
    ? options["rule-pack"]
    : existsSync(DEFAULT_RULE_PACK)
      ? DEFAULT_RULE_PACK
      : null;
  const changedFilesPath = typeof options["changed-files"] === "string" ? options["changed-files"] : null;
  const diffRoot = typeof options["diff-root"] === "string" ? options["diff-root"] : null;
  const handoffPath = typeof options.handoff === "string" ? options.handoff : null;
  const prBodyPath = typeof options["pr-body"] === "string" ? options["pr-body"] : null;
  const evidencePath = typeof options.evidence === "string" ? options.evidence : null;

  if (!rulePackPath) {
    return {
      input: {
        rulePack: null,
        rulePackPath: "",
        changedFiles: readChangedFiles(changedFilesPath),
        changedFilesPath,
        diffRoot,
        handoff: null,
        handoffPath,
        prBodyText: "",
        prBodyPath,
        evidenceValue: null,
        evidenceText: "",
        evidencePath,
      },
    };
  }

  if (!existsSync(rulePackPath)) {
    return {
      input: {
        rulePack: null,
        rulePackPath,
        changedFiles: readChangedFiles(changedFilesPath),
        changedFilesPath,
        diffRoot,
        handoff: null,
        handoffPath,
        prBodyText: "",
        prBodyPath,
        evidenceValue: null,
        evidenceText: "",
        evidencePath,
      },
    };
  }

  const rulePackResult = readOptionalStructuredInput(rulePackPath, "rule_pack_parse_error", true);
  if (rulePackResult.error) return { error: rulePackResult.error };
  const handoffResult = handoffPath ? readOptionalStructuredInput(handoffPath, "handoff_parse_error", true) : { value: null };
  if (handoffResult.error) return { error: handoffResult.error };
  const evidenceResult = evidencePath ? readOptionalEvidence(evidencePath) : { value: null, text: "" };
  if (evidenceResult.error) return { error: evidenceResult.error };

  return {
    input: {
      rulePack: rulePackResult.value,
      rulePackPath,
      changedFiles: readChangedFiles(changedFilesPath),
      changedFilesPath,
      diffRoot,
      handoff: normalizeControlHandoff(handoffResult.value),
      handoffPath,
      prBodyText: prBodyPath ? readTextInput(prBodyPath, "pr_body_read_error") : "",
      prBodyPath,
      evidenceValue: evidenceResult.value,
      evidenceText: evidenceResult.text,
      evidencePath,
    },
  };
}

function readOptionalStructuredInput(filePath, errorCode, required) {
  if (!existsSync(filePath)) {
    if (!required) return { value: null };
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

function readOptionalEvidence(filePath) {
  if (!existsSync(filePath)) {
    return { error: failureReport({ code: "evidence_read_error", message: `File not found: ${filePath}` }) };
  }
  const text = readFileSync(filePath, "utf8");
  try {
    return { value: readStructuredFile(filePath), text };
  } catch {
    return { value: text, text };
  }
}

function readTextInput(filePath, errorCode) {
  if (!existsSync(filePath)) {
    throw new Error(`${errorCode}: File not found: ${filePath}`);
  }
  return readFileSync(filePath, "utf8");
}

function readChangedFiles(filePath) {
  if (!filePath) return [];
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .sort((a, b) => a.localeCompare(b));
}

function readChangedFileContent({ diffRoot, file }) {
  if (!diffRoot) return "";
  const absolute = path.join(diffRoot, file);
  if (!existsSync(absolute)) return "";
  return readFileSync(absolute, "utf8");
}

function buildTextInputs(input, changedFileRecords) {
  return [
    { path: input.prBodyPath ?? "pr_body", text: input.prBodyText ?? "" },
    { path: input.handoffPath ?? "handoff", text: stringifyForSearch(input.handoff) },
    { path: input.evidencePath ?? "evidence", text: input.evidenceText || stringifyForSearch(input.evidenceValue) },
    { path: input.changedFilesPath ?? "changed_files", text: changedFileRecords.map((record) => `${record.path}\n${record.content}`).join("\n") },
  ];
}

function hasRulePackIdentity(rulePack) {
  return isObject(rulePack) && nonEmptyString(rulePack.schema_version) && nonEmptyString(rulePack.rule_pack_id);
}

function passResult(rule) {
  return {
    rule_id: String(rule.rule_id),
    code: String(rule.code),
    severity: String(rule.severity ?? "WARN"),
    verdict: "PASS",
    path: null,
    evidence: [],
  };
}

function finding({ ruleId, code, severity, verdict, path: findingPath, evidence }) {
  return {
    rule_id: ruleId,
    code,
    severity,
    verdict,
    path: findingPath,
    evidence: evidence.filter(Boolean).map(String),
  };
}

function toSummary(result) {
  return {
    rule_id: result.rule_id,
    code: result.code,
    severity: result.severity,
    path: result.path,
    evidence: result.evidence,
  };
}

function requiredNextActions(blockers, warnings) {
  if (blockers.length === 0 && warnings.length === 0) return [];
  return [...blockers, ...warnings].map((result) => ({
    rule_id: result.rule_id,
    action: actionForResult(result),
  }));
}

function actionForResult(result) {
  const actions = {
    "DR-LLM-001": "Replace LLM/model final authority claim with machine evidence and owner decision.",
    "DR-DATA-001": "Add soft-delete policy evidence or an explicit approved scoped exception.",
    "DR-ARCH-001": "Move configurable domain shape toward DB/config or document why source ownership is acceptable.",
    "DR-CODE-001": "Extract or justify duplicate code block.",
    "DR-CONFIG-001": "Move repeated configurable values to DB/config/content ownership.",
    "DR-SAFE-001": "Declare protected_stop or escalation route before touching protected surfaces.",
    "DR-CONFIG-002": "Move business constants to their declared SSOT.",
    "DR-RULEPACK-001": "Provide a design rule pack with schema_version and rule_pack_id.",
  };
  return actions[result.rule_id] ?? `Resolve ${result.code}.`;
}

function failureReport({ code, message }) {
  return {
    schema: SCHEMA,
    rule_pack_id: null,
    verdict: "FAILURE",
    would_block: false,
    rule_results: [],
    blockers: [],
    warnings: [],
    evidence: [],
    required_next_actions: [{ code, message }],
  };
}

function stableRuleResults(results) {
  return uniqueByKey(results, (result) => `${result.rule_id}\0${result.verdict}\0${result.path ?? ""}\0${result.evidence.join("|")}`)
    .sort((a, b) => [
      a.rule_id.localeCompare(b.rule_id),
      String(a.path ?? "").localeCompare(String(b.path ?? "")),
      a.verdict.localeCompare(b.verdict),
    ].find((value) => value !== 0) ?? 0);
}

function uniqueEvidence(evidence) {
  return uniqueByKey(evidence, (entry) => `${entry.code}\0${entry.source}\0${entry.detail}`);
}

function uniqueByKey(values, keyFn) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function containsPattern(text, pattern) {
  if (!text || !pattern) return false;
  return text.toLowerCase().includes(String(pattern).toLowerCase());
}

function hasSoftDeletePolicy(content, markers) {
  return markers.some((marker) => containsPattern(content, marker));
}

function hasApprovedException({ input, ruleId, filePath }) {
  const exceptions = [
    ...asArray(input.handoff?.design_rule_exceptions),
    ...asArray(input.evidenceValue?.design_rule_exceptions),
  ].filter(isObject);
  return exceptions.some((exception) => {
    if (exception.rule_id !== ruleId) return false;
    if (!nonEmptyString(exception.reason) || !nonEmptyString(exception.approved_by)) return false;
    if (isExpired(exception.expires_at)) return false;
    const scopes = asStringArray(exception.scope);
    if (scopes.length === 0) return false;
    return matchesAnyGlob(filePath, scopes);
  });
}

function isExpired(value) {
  if (!nonEmptyString(value)) return false;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return true;
  return timestamp < Date.parse("2026-06-23T00:00:00Z");
}

function isSourceOrMigrationLike(filePath) {
  return isSourcePath(filePath) ||
    /(^|\/)(migration|migrations|schema|db)\b/i.test(filePath) ||
    /\.(sql|prisma)$/.test(filePath);
}

function isSourcePath(filePath) {
  return /\.(mjs|cjs|js|jsx|ts|tsx|sql|prisma|rb|py|go|java|kt|swift)$/.test(filePath);
}

function isAllowedConfigLocation(filePath) {
  return matchesAnyGlob(filePath, ["config/**", "*.config.*", ".shirube/**", "templates/**", "test/**", "tests/**", "docs/**"]);
}

function hasEnumLikeBusinessArray(content) {
  return /\b(?:const|let|var)\s+\w*(?:plans?|types?|labels?|tiers?|ranks?)\w*\s*=\s*\[[^\]]*["'][^"']{3,}["'][^\]]*["'][^"']{3,}["']/i.test(content);
}

function hasRepeatedLiteralBranches(content) {
  const matches = [...content.matchAll(/(?:===|!==|==|!=)\s*["']([^"']{3,})["']/g)].map((match) => match[1]);
  return new Set(matches).size >= 2 && matches.length >= 3;
}

function longestDuplicateBlock(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isCommentOnly(line));
  let best = 0;
  for (let left = 0; left < lines.length; left += 1) {
    for (let right = left + 1; right < lines.length; right += 1) {
      let length = 0;
      while (lines[left + length] && lines[left + length] === lines[right + length]) {
        length += 1;
      }
      if (length > best) best = length;
    }
  }
  return { length: best };
}

function isCommentOnly(line) {
  return /^(\/\/|#|\/\*|\*|\*\/)/.test(line);
}

function repeatedStringLiterals(content, minCount) {
  const counts = new Map();
  const matches = content.matchAll(/(["'`])([^"'`\n]{3,80})\1/g);
  for (const match of matches) {
    const literal = match[2].trim();
    if (!isMeaningfulLiteral(literal)) continue;
    counts.set(literal, (counts.get(literal) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([literal, count]) => `repeated literal "${literal}" x${count}`);
}

function isMeaningfulLiteral(literal) {
  if (/^[./@_\-\w]+$/.test(literal) && !/\s/.test(literal) && literal.length < 8) return false;
  if (/^(true|false|null|undefined|GET|POST|PUT|PATCH|DELETE)$/i.test(literal)) return false;
  return true;
}

function environmentSpecificValues(content) {
  const values = [];
  if (/https?:\/\/(?:localhost|staging|prod|production|dev)\b/i.test(content)) {
    values.push("environment-specific URL");
  }
  if (/\b(?:tenant|hotel|operator|plan|rank)[A-Z_]*ID\b/.test(content)) {
    values.push("environment-specific business ID/name");
  }
  return values;
}

function hasProtectedDeclaration(handoff) {
  if (!isObject(handoff)) return false;
  const cell = isObject(handoff.cell) ? handoff.cell : {};
  return handoff.protected_stop === true ||
    cell.protected_stop === true ||
    cell.cell_type === "protected_stop" ||
    nonEmptyString(handoff.escalation_route) ||
    nonEmptyString(cell.escalation_route) ||
    presentArray(handoff.protected_surfaces) ||
    presentArray(cell.protected_surfaces);
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

function stringifyForSearch(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function stringOrNull(value) {
  return nonEmptyString(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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
    return nonEmptyString(entry);
  });
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
    const result = failureReport({
      code: "unsupported_format",
      message: "--format json is required.",
    });
    writeResult(result);
    process.exitCode = 1;
    return;
  }

  let readResult;
  try {
    readResult = readInput(options);
  } catch (error) {
    const result = failureReport({
      code: "input_read_error",
      message: errorMessage(error),
    });
    writeResult(result);
    process.exitCode = 1;
    return;
  }

  if (readResult.error) {
    writeResult(readResult.error);
    process.exitCode = 1;
    return;
  }

  const result = buildDesignRuleReport(readResult.input);
  writeResult(result);
  if (result.verdict === "FAILURE") process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main();
}
