#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function collectChangedFiles(baseSha, headSha, baseRef) {
  const attempts = [
    { label: "base-head-sha-three-dot", args: ["diff", "--name-only", `${baseSha}...${headSha}`] },
    { label: "base-head-sha-two-dot", args: ["diff", "--name-only", baseSha, headSha] },
    {
      label: "origin-base-three-dot",
      before: ["fetch", "--no-tags", "--prune", "origin", baseRef],
      args: ["diff", "--name-only", `origin/${baseRef}...HEAD`],
    },
    { label: "head-parent", args: ["diff", "--name-only", "HEAD^", "HEAD"] },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      if (attempt.before) execFileSync("git", attempt.before, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const files = execFileSync("git", attempt.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: "PASS", method: attempt.label, files, errors };
    } catch (error) {
      errors.push({ method: attempt.label, message: error.stderr?.toString?.().trim() || error.message });
    }
  }
  return { status: "FAILURE", method: null, files: "", errors };
}

function refFromBody(body, keys) {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const value = body.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${escaped}\\s*:\\s*([^\\n]+?)\\s*(?=\\n|$)`, "i"))?.[1]
      ?.trim().replace(/^["'`]|["'`]$/g, "");
    if (value && value !== "null") return value.split(/\s+/)[0];
  }
  return "";
}

function runResolver(script, args, outputPath) {
  const result = spawnSync(process.execPath, [path.join(RUNTIME_DIR, script), ...args], {
    encoding: "utf8",
    env: process.env,
  });
  writeNewResultFile(outputPath, result.stdout || "{}\n");
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return { verdict: "FAILURE", message: result.stderr || `${script} returned invalid JSON` };
  }
}

function appendResolvedRefs(bodyPath, marker, report, valueKey, sourceKey) {
  const values = Array.isArray(report.materialized_paths) && report.materialized_paths.length > 0
    ? report.materialized_paths.join(",")
    : report.materialized_path;
  const lines = [];
  if (values) lines.push(`${valueKey}: ${values}`);
  if (report.source_metadata_path) lines.push(`${sourceKey}: ${report.source_metadata_path}`);
  if (lines.length > 0) appendResultFile(bodyPath, `\n${marker}\n${lines.join("\n")}\n`);
}

export function prepareWorkflowDirectories({ workspaceRoot, targetDir, resultDir }) {
  const workspacePath = path.resolve(workspaceRoot);
  const workspaceStat = lstatSync(workspacePath);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    throw new Error("workspace-root must be a real directory, not a symlink");
  }
  const trustedWorkspace = realpathSync(workspacePath);

  const targetPath = path.resolve(targetDir);
  const targetStat = lstatSync(targetPath);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error("target-dir must be a real directory, not a symlink");
  }
  const trustedTarget = realpathSync(targetPath);
  if (!isStrictDescendant(trustedWorkspace, trustedTarget)) {
    throw new Error("target-dir must be inside workspace-root");
  }

  const unresolvedResult = path.isAbsolute(resultDir)
    ? path.resolve(resultDir)
    : path.resolve(workspacePath, resultDir);
  const requestedResult = path.resolve(trustedWorkspace, path.relative(workspacePath, unresolvedResult));
  if (requestedResult === trustedTarget || isStrictDescendant(trustedTarget, requestedResult)) {
    throw new Error("result-dir must be outside target-dir");
  }
  if (path.dirname(requestedResult) !== trustedWorkspace) {
    throw new Error("result-dir must be a direct workflow-owned child of workspace-root");
  }
  if (existsSync(requestedResult)) {
    const resultStat = lstatSync(requestedResult);
    const kind = resultStat.isSymbolicLink() ? "symlink" : "pre-existing path";
    throw new Error(`result-dir must not be a ${kind}`);
  }

  mkdirSync(requestedResult, { mode: 0o700 });
  const createdStat = lstatSync(requestedResult);
  if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
    throw new Error("result-dir creation did not produce a real directory");
  }
  return {
    workspaceRoot: trustedWorkspace,
    targetDir: trustedTarget,
    resultDir: realpathSync(requestedResult),
  };
}

export function writeNewResultFile(filePath, contents) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(filePath, flags, 0o600);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`result output is not a regular file: ${filePath}`);
    writeFileSync(descriptor, contents);
  } finally {
    closeSync(descriptor);
  }
}

function appendResultFile(filePath, contents) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`refusing to append to non-regular result file: ${filePath}`);
  }
  const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(filePath, flags);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`result output is not a regular file: ${filePath}`);
    writeFileSync(descriptor, contents);
  } finally {
    closeSync(descriptor);
  }
}

function isStrictDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const requestedTargetDir = path.resolve(options["target-dir"] ?? ".");
  const workspaceRoot = path.resolve(options["workspace-root"] ?? path.dirname(requestedTargetDir));
  const resultDirName = options["result-dir"] ?? ".shirube-rapid-lite";
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pullRequest = event.pull_request;
  if (!pullRequest) throw new Error("Rapid/Lite workflow requires a pull_request event");
  const { targetDir, resultDir } = prepareWorkflowDirectories({
    workspaceRoot,
    targetDir: requestedTargetDir,
    resultDir: resultDirName,
  });
  process.chdir(targetDir);

  const collection = collectChangedFiles(
    process.env.BASE_SHA || pullRequest.base.sha,
    process.env.HEAD_SHA || pullRequest.head.sha,
    process.env.BASE_REF || pullRequest.base.ref,
  );
  const changedFilesPath = path.join(resultDir, "changed-files.txt");
  const inputCollectionPath = path.join(resultDir, "input-collection.json");
  writeNewResultFile(changedFilesPath, collection.files);
  writeNewResultFile(inputCollectionPath, `${JSON.stringify({
    schema: "shirube-rapid-lite-input-collection/v1",
    status: collection.status,
    method: collection.method,
    attempts: collection.errors,
  }, null, 2)}\n`);
  let inputFailure = null;
  if (collection.status !== "PASS") {
    inputFailure = {
      schema: "shirube-rapid-lite-input-collection/v1",
      status: "FAILURE",
      code: "changed_files_collection_failed",
      message: "Unable to collect PR changed files from available merge-base strategies.",
      attempts: collection.errors,
    };
  }

  const prBodyPath = path.join(resultDir, "pr-body.md");
  const trustedMatrix = path.join(RUNTIME_DIR, "shirube-v3-rapid-lite-gate-contract-matrix.yaml");
  const trustedRules = path.join(RUNTIME_DIR, "shirube-default-design-rules.yaml");
  const suppliedControlRefs = [
    ["matrix_ref", refFromBody(pullRequest.body ?? "", ["matrix_ref", "matrix"])],
    ["rule_pack_ref", refFromBody(pullRequest.body ?? "", ["rule_pack_ref", "rule_pack", "rules_ref"])],
  ].filter(([, value]) => value);
  if (suppliedControlRefs.length > 0) {
    inputFailure = {
      schema: "shirube-rapid-lite-input-collection/v1",
      status: "FAILURE",
      code: "untrusted_control_input_override",
      message: "PR body must not supply matrix_ref or rule_pack_ref; both are bound to the manifest-verified exact-base runtime.",
      supplied_refs: Object.fromEntries(suppliedControlRefs),
      changed_files_collection: collection.status,
    };
  }
  const inputFailurePath = inputFailure ? path.join(resultDir, "input-failure.json") : "";
  if (inputFailure) writeNewResultFile(inputFailurePath, `${JSON.stringify(inputFailure, null, 2)}\n`);
  const defaultRefs = [
    ["execution_context_ref", ".shirube/execution-context.yaml"],
    ["adoption_plan_ref", ".shirube/adoption-intake.yaml"],
    ["lifecycle_state_ref", ".shirube/lifecycle-state.yaml"],
    ["handoff_ref", ".shirube/control-handoffs/CH-001.yaml"],
    ["enforcement_policy_ref", ".shirube/enforcement-policy.yaml"],
  ].filter(([, value]) => existsSync(value));
  const body = [
    "<!-- shirube:trusted-runtime-inputs/v1 -->",
    `matrix_ref: ${trustedMatrix}`,
    `rule_pack_ref: ${trustedRules}`,
    "",
    pullRequest.body ?? "",
    "",
    "<!-- shirube:local-runtime-inputs/v1 -->",
    ...defaultRefs.map(([key, value]) => `${key}: ${value}`),
    "",
  ].join("\n");
  writeNewResultFile(prBodyPath, body);

  const actualRepo = process.env.GITHUB_REPOSITORY;
  const actualPr = String(pullRequest.number);
  const actualHead = process.env.HEAD_SHA || pullRequest.head.sha;
  const tokenArg = ["--github-token-env", "GITHUB_TOKEN", "--format", "json"];

  const handoffRef = refFromBody(body, ["handoff_ref", "handoff", "control_handoff_ref", "control_handoff"]);
  const handoffCommentRef = refFromBody(body, ["control_handoff_comment_ref", "control_handoff_comment"])
    || (/^https?:\/\//i.test(handoffRef) ? handoffRef : "");
  if (handoffCommentRef) {
    const output = path.join(resultDir, "control-handoff-ref-resolution.json");
    const report = runResolver("resolve-control-handoff-ref.mjs", [
      "--control-handoff-comment-ref", handoffCommentRef,
      "--actual-repo", actualRepo,
      "--actual-head", actualHead,
      "--result-dir", resultDir,
      ...tokenArg,
    ], output);
    appendResolvedRefs(prBodyPath, "<!-- shirube:control-handoff-resolution/v1 -->", report, "control_handoff_ref", "control_handoff_source_ref");
  }

  const structuredRef = refFromBody(body, ["structured_audit_ref", "structured_audit", "structured-audit"]);
  const structuredCommentRef = refFromBody(body, ["structured_audit_comment_ref", "structured_audit_comment", "structured-audit-comment"]);
  if (structuredRef || structuredCommentRef) {
    const output = path.join(resultDir, "structured-audit-ref-resolution.json");
    const report = runResolver("resolve-structured-audit-ref.mjs", [
      "--structured-audit-ref", structuredRef,
      "--structured-audit-comment-ref", structuredCommentRef,
      "--actual-repo", actualRepo,
      "--actual-pr", actualPr,
      "--actual-head", actualHead,
      "--result-dir", resultDir,
      ...tokenArg,
    ], output);
    appendResolvedRefs(prBodyPath, "<!-- shirube:structured-audit-resolution/v1 -->", report, "structured_audit_ref", "structured_audit_source_ref");
  }

  const additionalRef = refFromBody(body, ["additional_review_ref", "additional_review", "protected_review_ref"]);
  const additionalCommentRef = refFromBody(body, ["additional_review_comment_ref", "additional_review_comment", "protected_review_comment_ref"]);
  if (additionalRef || additionalCommentRef) {
    const output = path.join(resultDir, "additional-review-ref-resolution.json");
    const report = runResolver("resolve-additional-review-ref.mjs", [
      "--additional-review-ref", additionalRef,
      "--additional-review-comment-ref", additionalCommentRef,
      "--actual-repo", actualRepo,
      "--actual-pr", actualPr,
      "--actual-head", actualHead,
      "--result-dir", resultDir,
      ...tokenArg,
    ], output);
    appendResolvedRefs(prBodyPath, "<!-- shirube:additional-review-resolution/v1 -->", report, "additional_review_ref", "additional_review_source_ref");
  }

  const externalSubjectArtifactRef = refFromBody(
    readFileSync(prBodyPath, "utf8"),
    ["external_gate_subject_artifact_ref", "external_gate_subject_artifact"],
  );
  if (externalSubjectArtifactRef) {
    const resolvedHandoffRef = refFromBody(
      readFileSync(prBodyPath, "utf8"),
      ["handoff_ref", "handoff", "control_handoff_ref", "control_handoff"],
    );
    const output = path.join(resultDir, "external-gate-subject-ref-resolution.json");
    const resolverArgs = [
      "--external-gate-subject-artifact-ref", externalSubjectArtifactRef,
      "--actual-repo", actualRepo,
      "--actual-pr", actualPr,
      "--actual-head", actualHead,
      "--result-dir", resultDir,
      ...tokenArg,
    ];
    if (resolvedHandoffRef) resolverArgs.push("--handoff", resolvedHandoffRef);
    const report = runResolver("resolve-external-gate-subject-ref.mjs", resolverArgs, output);
    appendResultFile(prBodyPath, `\n<!-- shirube:external-gate-subject-resolution/v1 -->\nexternal_gate_subject_resolution_ref: ${output}\n`);
    appendResolvedRefs(
      prBodyPath,
      "<!-- shirube:external-gate-subject-materialization/v1 -->",
      report,
      "external_gate_subject_ref",
      "external_gate_subject_source_ref",
    );
  }

  const reportArgs = [
    path.join(RUNTIME_DIR, "run-rapid-lite-report.mjs"),
    "--result-dir", resultDir,
    "--changed-files", changedFilesPath,
    "--pr-body", prBodyPath,
    "--diff-root", ".",
    "--actual-repo", actualRepo,
    "--actual-pr", actualPr,
    "--actual-branch", pullRequest.head.ref,
    "--actual-head", actualHead,
  ];
  if (inputFailurePath) reportArgs.push("--input-failure", inputFailurePath);
  reportArgs.push("--format", "json");
  const report = spawnSync(process.execPath, reportArgs, { encoding: "utf8", env: process.env });
  writeNewResultFile(path.join(resultDir, "workflow-output.json"), report.stdout || "{}\n");
  if (report.stderr) process.stderr.write(report.stderr);
  if (report.status !== 0) process.exitCode = report.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
