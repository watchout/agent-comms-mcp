#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {
  isMain,
  parseArgs,
} from "./lib.mjs";

export const EXTERNAL_GATE_SUBJECT_RESOLUTION_SCHEMA = "shirube-external-gate-subject-resolution/v1";
export const EXTERNAL_GATE_SUBJECT_SOURCE_SCHEMA = "shirube-external-gate-subject-source/v1";
export const EXTERNAL_GATE_SUBJECT_SCHEMA = "shirube-external-gate-subject/v1";

const ALLOWED_WORKFLOW_PATH = ".github/workflows/shirube-external-gate-subject-request.yml";
const SUBJECT_FILENAME = "shirube-external-gate-subject.yaml";
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_SUBJECT_BYTES = 64 * 1024;
const MAX_HANDOFF_BYTES = 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const REF_PATTERN = /^github-actions-artifact:\/\/([^/]+\/[^/]+)\/(\d+)$/;
const GITHUB_API_HOST = "api.github.com";
const GITHUB_CONTENT_HOST_SUFFIX = "githubusercontent.com";
const AZURE_BLOB_HOST_SUFFIX = "blob.core.windows.net";

const FINDINGS = Object.freeze({
  "XSUBJ-001": ["unsupported_artifact_ref", "external_gate_subject_artifact_ref must be github-actions-artifact://owner/repo/<artifact_id>."],
  "XSUBJ-002": ["github_api_or_download_failure", "GitHub artifact, workflow-run, pull-request, or download transport failed."],
  "XSUBJ-003": ["artifact_missing", "The referenced GitHub Actions artifact does not exist."],
  "XSUBJ-004": ["artifact_unavailable", "The referenced artifact is expired, deleted, or otherwise unavailable."],
  "XSUBJ-005": ["artifact_repository_mismatch", "Artifact repository identity does not match the current target repository."],
  "XSUBJ-006": ["untrusted_producer_run", "Artifact producer workflow/run provenance is not trusted."],
  "XSUBJ-007": ["artifact_digest_mismatch", "Downloaded artifact bytes do not match the authenticated API digest."],
  "XSUBJ-008": ["unsafe_archive_shape", "Artifact archive must contain exactly one bounded regular subject file."],
  "XSUBJ-009": ["invalid_subject_payload", `Subject payload must use ${EXTERNAL_GATE_SUBJECT_SCHEMA} and exact typed fields.`],
  "XSUBJ-010": ["subject_identity_mismatch", "Claimed artifact subject differs from the current GitHub event identity."],
  "XSUBJ-011": ["handoff_digest_mismatch", "Claimed control_input_digest differs from the exact handoff bytes."],
  "XSUBJ-012": ["unauthenticated_or_mutable_binding", "Artifact identity, digest, or authenticated provenance is incomplete."],
  "XSUBJ-013": ["event_api_disagreement", "Trusted GitHub pull_request event identity disagrees with the current GitHub Pulls API response."],
});

export async function resolveExternalGateSubject(options = {}) {
  const refValue = stringOption(options["external-gate-subject-artifact-ref"] ?? options.ref);
  const actualRepo = stringOption(options["actual-repo"]);
  const actualPr = positiveInteger(options["actual-pr"]);
  const actualHead = lowerSha(options["actual-head"]);
  const handoffPath = stringOption(options.handoff);
  const resultDir = path.resolve(stringOption(options["result-dir"]) ?? ".shirube-rapid-lite");
  const tokenEnv = stringOption(options["github-token-env"]) ?? "GITHUB_TOKEN";
  const fixture = options.fixture ?? null;
  mkdirSync(resultDir, { recursive: true });

  const parsedRef = parseArtifactRef(refValue);
  if (!parsedRef) return blocked("XSUBJ-001", { source_ref: refValue });
  if (!actualRepo || !actualPr || !actualHead || !handoffPath) {
    return failure("XSUBJ-002", { detail: "actual repo, PR, head, and exact handoff path are required" });
  }
  if (normalizeRepo(parsedRef.repo) !== normalizeRepo(actualRepo)) {
    return blocked("XSUBJ-005", { expected: actualRepo, observed: parsedRef.repo });
  }

  let handoffBytes;
  let handoff;
  try {
    handoffBytes = fixture?.handoff_bytes !== undefined
      ? Buffer.from(String(fixture.handoff_bytes), "utf8")
      : readFileSync(handoffPath);
    if (handoffBytes.byteLength === 0 || handoffBytes.byteLength > MAX_HANDOFF_BYTES) {
      throw new Error(`exact handoff must be 1..${MAX_HANDOFF_BYTES} bytes`);
    }
    handoff = fixture?.handoff !== undefined
      ? fixture.handoff
      : parseStructuredBytes(handoffBytes);
  } catch (error) {
    return failure("XSUBJ-002", { detail: `exact handoff read failed: ${errorMessage(error)}` });
  }
  const expectedCellId = handoffCellId(handoff);
  if (!expectedCellId) return blocked("XSUBJ-009", { detail: "exact handoff does not declare cell_id" });
  const expectedHandoffDigest = sha256(handoffBytes);

  let loaded;
  try {
    loaded = fixture
      ? loadFixtureTransport(fixture)
      : await loadGitHubTransport({ parsedRef, actualRepo, actualPr, tokenEnv });
  } catch (error) {
    const status = Number(error?.statusCode ?? 0);
    if (status === 404) return blocked("XSUBJ-003", { status_code: status });
    return failure("XSUBJ-002", { status_code: status || null, detail: errorMessage(error) });
  }

  const artifact = loaded.artifact;
  if (!artifact) return blocked("XSUBJ-003");
  if (artifact.expired === true || loaded.deleted === true) {
    return blocked("XSUBJ-004", { expired: artifact.expired === true, deleted: loaded.deleted === true });
  }
  if (!positiveInteger(artifact.size_in_bytes) || Number(artifact.size_in_bytes) > MAX_ARCHIVE_BYTES) {
    return blocked("XSUBJ-012", { artifact_size_in_bytes: artifact.size_in_bytes ?? null });
  }
  if (Number(artifact.id) !== Number(parsedRef.artifactId)) {
    return blocked("XSUBJ-012", { expected_artifact_id: parsedRef.artifactId, observed_artifact_id: artifact.id ?? null });
  }
  const expectedArtifactName = `shirube-external-gate-subject-pr-${actualPr}-${actualHead}`;
  if (artifact.name !== expectedArtifactName) {
    return blocked("XSUBJ-012", { expected_artifact_name: expectedArtifactName, observed_artifact_name: artifact.name ?? null });
  }

  const repositoryId = positiveInteger(artifact?.workflow_run?.repository_id);
  const artifactDigest = digestValue(artifact.digest);
  const artifactNodeId = stringOption(artifact.node_id);
  if (!repositoryId || !artifactNodeId || !artifactDigest || !stringOption(artifact.created_at) || !stringOption(artifact.expires_at)) {
    return blocked("XSUBJ-012", { detail: "artifact API identity/digest/timestamps are incomplete" });
  }

  const run = loaded.run;
  const runRepo = run?.repository?.full_name;
  const runRepoId = positiveInteger(run?.repository?.id);
  const repository = loaded.repository;
  const canonicalRepo = repository?.full_name;
  const canonicalRepoId = positiveInteger(repository?.id);
  if (
    normalizeRepo(runRepo) !== normalizeRepo(actualRepo)
    || runRepoId !== repositoryId
    || normalizeRepo(canonicalRepo) !== normalizeRepo(actualRepo)
    || canonicalRepoId !== repositoryId
  ) {
    return blocked("XSUBJ-005", {
      expected: actualRepo,
      observed: runRepo ?? null,
      canonical_repository: canonicalRepo ?? null,
      repository_id: runRepoId,
      canonical_repository_id: canonicalRepoId,
    });
  }
  const provenanceFinding = validateRunProvenance({ artifact, run, repository });
  if (provenanceFinding) return blocked("XSUBJ-006", provenanceFinding);

  const prApi = loaded.pullRequest;
  const apiRepo = prApi?.base?.repo?.full_name ?? prApi?.head?.repo?.full_name;
  const apiPr = positiveInteger(prApi?.number);
  const apiHead = lowerSha(prApi?.head?.sha);
  if (normalizeRepo(apiRepo) !== normalizeRepo(actualRepo) || apiPr !== actualPr || apiHead !== actualHead) {
    return failure("XSUBJ-013", {
      event: { repo: actualRepo, PR: actualPr, head: actualHead },
      api: { repo: apiRepo ?? null, PR: apiPr, head: apiHead },
    });
  }

  const archiveBytes = loaded.archive_bytes;
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.byteLength === 0 || archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
    return blocked("XSUBJ-008", { archive_bytes: archiveBytes?.byteLength ?? null });
  }
  if (sha256(archiveBytes) !== artifactDigest) {
    return blocked("XSUBJ-007", { expected: artifactDigest, observed: sha256(archiveBytes) });
  }

  let subjectBytes;
  try {
    subjectBytes = loaded.archive_entries
      ? subjectFromFixtureArchive(loaded.archive_entries)
      : subjectFromZipArchive(archiveBytes);
  } catch (error) {
    return blocked("XSUBJ-008", { detail: errorMessage(error) });
  }
  if (subjectBytes.byteLength === 0 || subjectBytes.byteLength > MAX_SUBJECT_BYTES) {
    return blocked("XSUBJ-008", { subject_bytes: subjectBytes.byteLength });
  }

  let subject;
  try {
    subject = parseStructuredBytes(subjectBytes);
  } catch (error) {
    return blocked("XSUBJ-009", { detail: errorMessage(error) });
  }
  const invalidFields = validateSubject(subject);
  if (invalidFields.length > 0) return blocked("XSUBJ-009", { invalid_fields: invalidFields });

  const identityMismatches = [];
  if (subject.cell_id !== expectedCellId) identityMismatches.push("cell_id");
  if (normalizeRepo(subject.repo) !== normalizeRepo(actualRepo)) identityMismatches.push("repo");
  if (Number(subject.PR) !== actualPr) identityMismatches.push("PR");
  if (String(subject.head).toLowerCase() !== actualHead) identityMismatches.push("head");
  if (subject.gate_type !== "PR_exact_head_audit") identityMismatches.push("gate_type");
  if (identityMismatches.length > 0) {
    return blocked("XSUBJ-010", { mismatch_fields: identityMismatches });
  }
  if (String(subject.control_input_digest).toLowerCase() !== expectedHandoffDigest) {
    return blocked("XSUBJ-011", { expected: expectedHandoffDigest, observed: subject.control_input_digest });
  }

  const subjectPath = path.join(resultDir, SUBJECT_FILENAME);
  const sourcePath = path.join(resultDir, "external-gate-subject-source.json");
  writeFileSync(subjectPath, subjectBytes);
  const source = {
    schema_version: EXTERNAL_GATE_SUBJECT_SOURCE_SCHEMA,
    resolver_schema: EXTERNAL_GATE_SUBJECT_RESOLUTION_SCHEMA,
    verdict: "PASS",
    source_type: "github_actions_artifact",
    source_ref: refValue,
    claimed_subject_source: "external_artifact_bytes",
    expected_subject_sources: ["github_pull_request_event", "github_pulls_api", "exact_handoff_bytes"],
    source_independence_verified: true,
    subject_path: subjectPath,
    subject_sha256: sha256(subjectBytes),
    subject_utf8_bytes: subjectBytes.byteLength,
    exact_subject: pickSubject(subject),
    immutable_artifact_identity: {
      repository_id: repositoryId,
      artifact_id: Number(artifact.id),
      artifact_node_id: artifactNodeId,
      artifact_digest: `sha256:${artifactDigest}`,
      workflow_run_id: Number(run.id),
      producer_workflow_id: Number(run.workflow_id),
      producer_workflow_path: run.path,
      producer_head_sha: String(run.head_sha).toLowerCase(),
    },
    authenticated_provenance: {
      api_origin: "api.github.com",
      api_version: "2022-11-28",
      token_env_name: tokenEnv,
      artifact_get_status: loaded.artifact_status ?? 200,
      workflow_run_get_status: loaded.run_status ?? 200,
      pull_request_get_status: loaded.pr_status ?? 200,
      repository_get_status: loaded.repository_status ?? 200,
      producer_event: run.event,
      producer_actor: run.actor.login,
      producer_run_conclusion: run.conclusion,
      producer_default_branch: repository.default_branch,
      artifact_created_at: artifact.created_at,
      artifact_expires_at: artifact.expires_at,
      artifact_expired: false,
    },
    binding: {
      event_subject: { repo: actualRepo, PR: actualPr, head: actualHead },
      api_subject: { repo: apiRepo, PR: apiPr, head: apiHead },
      handoff_cell_id: expectedCellId,
      handoff_sha256: expectedHandoffDigest,
      all_six_fields_equal: true,
    },
    target_branch_mutated: false,
    owner_approval_synthesized: false,
  };
  writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);

  return {
    schema_version: EXTERNAL_GATE_SUBJECT_RESOLUTION_SCHEMA,
    verdict: "PASS",
    would_block: false,
    blockers: [],
    subject: pickSubject(subject),
    materialized_path: subjectPath,
    source_metadata_path: sourcePath,
    source,
  };
}

export async function runFixtureMatrix(matrixDir) {
  const cases = readdirSync(matrixDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const results = [];
  for (const name of cases) {
    const fixturePath = path.join(matrixDir, name, "fixture.json");
    const descriptor = JSON.parse(readFileSync(fixturePath, "utf8"));
    const fixture = buildFixture(descriptor);
    const resultDir = mkdtempSync(path.join(os.tmpdir(), `shirube-xsubject-${name}-`));
    try {
      const report = await resolveExternalGateSubject({
        "external-gate-subject-artifact-ref": fixture.ref,
        "actual-repo": fixture.actual_repo,
        "actual-pr": String(fixture.actual_pr),
        "actual-head": fixture.actual_head,
        handoff: path.join(matrixDir, name, "handoff.yaml"),
        "result-dir": resultDir,
        fixture,
      });
      const expectedVerdict = descriptor.expected_verdict;
      const expectedCode = descriptor.expected_code ?? null;
      const observedCode = report.blockers?.[0]?.item_id ?? null;
      results.push({
        id: descriptor.id ?? name,
        scenario: descriptor.scenario,
        expected_verdict: expectedVerdict,
        observed_verdict: report.verdict,
        expected_code: expectedCode,
        observed_code: observedCode,
        pass: report.verdict === expectedVerdict && (!expectedCode || observedCode === expectedCode),
        report,
      });
    } finally {
      rmSync(resultDir, { recursive: true, force: true });
    }
  }
  const pass = results.length > 0 && results.every((entry) => entry.pass);
  return {
    schema_version: "shirube-external-gate-subject-fixture-matrix/v1",
    verdict: pass ? "PASS" : "FAILURE",
    fixture_count: results.length,
    passed_count: results.filter((entry) => entry.pass).length,
    results,
  };
}

export function parseArtifactRef(value) {
  const match = String(value ?? "").trim().match(REF_PATTERN);
  return match ? { repo: match[1], artifactId: Number(match[2]) } : null;
}

export function inspectExternalSubjectArchive(archiveBytes) {
  return subjectFromZipArchive(Buffer.from(archiveBytes));
}

export function artifactDownloadRequestPolicy(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { allowed: false, sendAuthorization: false };
  }
  const hostname = parsed.hostname.toLowerCase();
  const hasSafeAuthority = parsed.protocol === "https:"
    && !parsed.username
    && !parsed.password
    && !parsed.port;
  const isGitHubApi = hostname === GITHUB_API_HOST;
  const isGitHubContent = isStrictSubdomain(hostname, GITHUB_CONTENT_HOST_SUFFIX);
  const isAzureBlob = isStrictSubdomain(hostname, AZURE_BLOB_HOST_SUFFIX);
  return {
    allowed: hasSafeAuthority && (isGitHubApi || isGitHubContent || isAzureBlob),
    sendAuthorization: hasSafeAuthority && isGitHubApi,
  };
}

async function loadGitHubTransport({ parsedRef, actualRepo, actualPr, tokenEnv }) {
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`${tokenEnv} is not set`);
  const artifactResponse = await fetchJsonResponse({
    apiPath: `/repos/${parsedRef.repo}/actions/artifacts/${parsedRef.artifactId}`,
    token,
  });
  const artifact = artifactResponse.body;
  if (artifact?.expired === true) {
    return { artifact, artifact_status: artifactResponse.status };
  }
  if (!positiveInteger(artifact?.size_in_bytes) || Number(artifact.size_in_bytes) > MAX_ARCHIVE_BYTES) {
    return { artifact, artifact_status: artifactResponse.status };
  }
  const runId = positiveInteger(artifact?.workflow_run?.id);
  if (!runId) return { artifact, artifact_status: artifactResponse.status, run: null };
  const [runResponse, prResponse, repositoryResponse, archiveBytes] = await Promise.all([
    fetchJsonResponse({ apiPath: `/repos/${parsedRef.repo}/actions/runs/${runId}`, token }),
    fetchJsonResponse({ apiPath: `/repos/${actualRepo}/pulls/${actualPr}`, token }),
    fetchJsonResponse({ apiPath: `/repos/${parsedRef.repo}`, token }),
    downloadBuffer({
      url: `https://api.github.com/repos/${parsedRef.repo}/actions/artifacts/${parsedRef.artifactId}/zip`,
      token,
    }),
  ]);
  return {
    artifact,
    artifact_status: artifactResponse.status,
    run: runResponse.body,
    run_status: runResponse.status,
    pullRequest: prResponse.body,
    pr_status: prResponse.status,
    repository: repositoryResponse.body,
    repository_status: repositoryResponse.status,
    archive_bytes: archiveBytes,
  };
}

function loadFixtureTransport(fixture) {
  if (fixture.artifact_status === 404) {
    const error = new Error("fixture artifact missing");
    error.statusCode = 404;
    throw error;
  }
  if (fixture.transport_error) throw new Error(fixture.transport_error);
  return {
    artifact: fixture.artifact,
    artifact_status: fixture.artifact_status ?? 200,
    run: fixture.run,
    run_status: fixture.run_status ?? 200,
    pullRequest: fixture.pull_request,
    pr_status: fixture.pr_status ?? 200,
    repository: fixture.repository,
    repository_status: fixture.repository_status ?? 200,
    archive_bytes: fixture.archive_bytes,
    archive_entries: fixture.archive_entries,
    deleted: fixture.deleted,
  };
}

function validateRunProvenance({ artifact, run, repository }) {
  if (!run || Number(run.id) !== Number(artifact?.workflow_run?.id)) return { detail: "workflow run identity mismatch" };
  if (!positiveInteger(run.workflow_id) || run.path !== ALLOWED_WORKFLOW_PATH) return { detail: "producer workflow is not allowlisted", path: run.path ?? null };
  if (run.event !== "workflow_dispatch" || run.conclusion !== "success") return { event: run.event ?? null, conclusion: run.conclusion ?? null };
  if (!stringOption(run.actor?.login) || !lowerSha(run.head_sha)) return { detail: "producer actor or head SHA missing" };
  if (String(artifact?.workflow_run?.head_sha ?? "").toLowerCase() !== String(run.head_sha).toLowerCase()) return { detail: "artifact and producer run head SHA mismatch" };
  if (!stringOption(repository?.default_branch) || run.head_branch !== repository.default_branch) return { detail: "producer did not run from the repository default branch" };
  const startedAt = Date.parse(run.run_started_at ?? run.created_at ?? "");
  const artifactCreatedAt = Date.parse(artifact.created_at ?? "");
  if (!Number.isFinite(startedAt) || !Number.isFinite(artifactCreatedAt) || artifactCreatedAt < startedAt) {
    return { detail: "artifact timestamp precedes or cannot bind to producer run" };
  }
  return null;
}

function subjectFromZipArchive(archiveBytes) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "shirube-xsubject-zip-"));
  const zipPath = path.join(tempDir, "artifact.zip");
  try {
    writeFileSync(zipPath, archiveBytes);
    const list = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (list.status !== 0) throw new Error(list.stderr || "unzip listing failed");
    const names = list.stdout.split(/\r?\n/).filter(Boolean);
    validateArchiveNames(names);
    const details = spawnSync("zipinfo", ["-l", zipPath], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (details.status !== 0) throw new Error(details.stderr || "zipinfo failed");
    if (details.stdout.split(/\r?\n/).some((line) => /^l[rwx-]{9}\s/.test(line.trim()))) {
      throw new Error("symlink entry is forbidden");
    }
    const extracted = spawnSync("unzip", ["-p", zipPath, SUBJECT_FILENAME], {
      encoding: null,
      maxBuffer: MAX_SUBJECT_BYTES + 1,
    });
    if (extracted.status !== 0) throw new Error(extracted.stderr?.toString("utf8") || "subject extraction failed");
    return Buffer.from(extracted.stdout);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function subjectFromFixtureArchive(entries) {
  const names = entries.map((entry) => entry.path);
  validateArchiveNames(names);
  const entry = entries[0];
  if (entry.type !== "file") throw new Error(`${entry.type ?? "unknown"} entry is forbidden`);
  return Buffer.from(String(entry.content ?? ""), "utf8");
}

function validateArchiveNames(names) {
  if (names.length !== 1 || names[0] !== SUBJECT_FILENAME) {
    throw new Error(`expected exactly ${SUBJECT_FILENAME}; observed ${names.join(",") || "none"}`);
  }
  for (const name of names) {
    const normalized = name.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.endsWith("/")) {
      throw new Error(`unsafe archive path: ${name}`);
    }
  }
}

function parseStructuredBytes(bytes) {
  const text = bytes.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    const json = execFileSync("ruby", [
      "-ryaml",
      "-rjson",
      "-rdate",
      "-e",
      "body=YAML.safe_load(STDIN.read, permitted_classes:[Date,Time], aliases:false); puts JSON.generate(body)",
    ], { input: text, encoding: "utf8", maxBuffer: MAX_SUBJECT_BYTES * 2 });
    return JSON.parse(json);
  }
}

function validateSubject(subject) {
  if (!isObject(subject) || subject.schema_version !== EXTERNAL_GATE_SUBJECT_SCHEMA) return ["schema_version"];
  const invalid = [];
  if (!stringOption(subject.cell_id)) invalid.push("cell_id");
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(String(subject.repo ?? ""))) invalid.push("repo");
  if (!positiveInteger(subject.PR)) invalid.push("PR");
  if (!lowerSha(subject.head)) invalid.push("head");
  if (subject.gate_type !== "PR_exact_head_audit") invalid.push("gate_type");
  if (!SHA256_PATTERN.test(String(subject.control_input_digest ?? ""))) invalid.push("control_input_digest");
  return invalid;
}

function pickSubject(subject) {
  return {
    cell_id: subject.cell_id,
    repo: subject.repo,
    PR: Number(subject.PR),
    head: String(subject.head).toLowerCase(),
    gate_type: subject.gate_type,
    control_input_digest: String(subject.control_input_digest).toLowerCase(),
  };
}

function buildFixture(descriptor) {
  const actualRepo = "watchout/agent-comms-mcp";
  const actualPr = 999;
  const actualHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const cellId = "CELL-AUN-RAPID-LITE-EXTERNAL-SUBJECT-BINDING-001";
  const handoffBytes = `schema_version: shirube-control-handoff/rapid-lite/v1\ncell_id: ${cellId}\n`;
  const handoff = { schema_version: "shirube-control-handoff/rapid-lite/v1", cell_id: cellId };
  const subject = {
    schema_version: EXTERNAL_GATE_SUBJECT_SCHEMA,
    cell_id: cellId,
    repo: actualRepo,
    PR: actualPr,
    head: actualHead,
    gate_type: "PR_exact_head_audit",
    control_input_digest: sha256(Buffer.from(handoffBytes)),
  };
  const fixture = {
    ref: `github-actions-artifact://${actualRepo}/4242`,
    actual_repo: actualRepo,
    actual_pr: actualPr,
    actual_head: actualHead,
    handoff_bytes: handoffBytes,
    handoff,
    artifact_status: 200,
    run_status: 200,
    pr_status: 200,
    artifact: {
      id: 4242,
      name: `shirube-external-gate-subject-pr-${actualPr}-${actualHead}`,
      size_in_bytes: 512,
      node_id: "MDg6QXJ0aWZhY3Q0MjQy",
      expired: false,
      created_at: "2026-08-04T00:01:00Z",
      expires_at: "2026-08-18T00:01:00Z",
      workflow_run: { id: 7001, repository_id: 1001, head_sha: "dddddddddddddddddddddddddddddddddddddddd" },
    },
    run: {
      id: 7001,
      workflow_id: 8001,
      path: ALLOWED_WORKFLOW_PATH,
      event: "workflow_dispatch",
      conclusion: "success",
      actor: { login: "watchout" },
      head_sha: "dddddddddddddddddddddddddddddddddddddddd",
      head_branch: "main",
      run_started_at: "2026-08-04T00:00:00Z",
      repository: { id: 1001, full_name: actualRepo },
    },
    repository: { id: 1001, full_name: actualRepo, default_branch: "main" },
    pull_request: {
      number: actualPr,
      head: { sha: actualHead, repo: { full_name: actualRepo } },
      base: { repo: { full_name: actualRepo } },
    },
    archive_entries: [{ path: SUBJECT_FILENAME, type: "file", content: `${JSON.stringify(subject, null, 2)}\n` }],
  };

  switch (descriptor.scenario) {
    case "positive": break;
    case "predecessor_head": fixture.archive_entries[0].content = subjectContent(subject, { head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }); break;
    case "successor_head": fixture.archive_entries[0].content = subjectContent(subject, { head: "cccccccccccccccccccccccccccccccccccccccc" }); break;
    case "wrong_repo_pr_cell": fixture.archive_entries[0].content = subjectContent(subject, { repo: "watchout/other", PR: 1000, cell_id: "CELL-WRONG" }); break;
    case "handoff_digest_mismatch": fixture.archive_entries[0].content = subjectContent(subject, { control_input_digest: "f".repeat(64) }); break;
    case "mutable_or_unauthenticated": fixture.artifact.digest = null; break;
    case "missing_artifact": fixture.artifact_status = 404; fixture.artifact = null; break;
    case "expired_or_deleted": fixture.artifact.expired = true; break;
    case "wrong_workflow_or_event": fixture.run.path = ".github/workflows/untrusted.yml"; fixture.run.event = "push"; break;
    case "event_api_disagreement": fixture.pull_request.head.sha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; break;
    case "archive_shape_attack": fixture.archive_entries = [
      { path: SUBJECT_FILENAME, type: "file", content: fixture.archive_entries[0].content },
      { path: "../shadow.yaml", type: "file", content: "{}\n" },
    ]; break;
    default: throw new Error(`Unknown fixture scenario: ${descriptor.scenario}`);
  }
  fixture.archive_bytes = fixtureArchiveBytes(fixture.archive_entries);
  if (fixture.artifact && fixture.artifact.digest === undefined) fixture.artifact.digest = `sha256:${sha256(fixture.archive_bytes)}`;
  return fixture;
}

function subjectContent(base, overrides) {
  return `${JSON.stringify({ ...base, ...overrides }, null, 2)}\n`;
}

function fixtureArchiveBytes(entries) {
  return Buffer.from(JSON.stringify(entries), "utf8");
}

function fetchJsonResponse({ apiPath, token }) {
  return requestBuffer({
    url: `https://api.github.com${apiPath}`,
    token,
    accept: "application/vnd.github+json",
  }).then(({ status, body }) => {
    if (status < 200 || status >= 300) {
      const error = new Error(body.toString("utf8") || `GitHub API ${status}`);
      error.statusCode = status;
      throw error;
    }
    try {
      return { status, body: JSON.parse(body.toString("utf8")) };
    } catch (error) {
      throw new Error(`GitHub API returned invalid JSON: ${errorMessage(error)}`);
    }
  });
}

async function downloadBuffer({ url, token }) {
  let current = url;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const policy = artifactDownloadRequestPolicy(current);
    if (!policy.allowed) {
      throw new Error(`Refusing artifact download from ${safeHostname(current)}`);
    }
    const response = await requestBuffer({
      url: current,
      token: policy.sendAuthorization ? token : null,
      accept: "application/vnd.github+json",
      maxBytes: MAX_ARCHIVE_BYTES,
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      const next = new URL(response.location, current);
      if (!artifactDownloadRequestPolicy(next).allowed) {
        throw new Error(`Refusing artifact redirect to ${next.hostname}`);
      }
      current = next.toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(response.body.toString("utf8") || `artifact download ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return response.body;
  }
  throw new Error("Too many artifact download redirects");
}

function isStrictSubdomain(hostname, suffix) {
  return hostname.length > suffix.length + 1 && hostname.endsWith(`.${suffix}`);
}

function safeHostname(value) {
  try {
    return new URL(value).hostname || "invalid URL";
  } catch {
    return "invalid URL";
  }
}

function requestBuffer({ url, token, accept, maxBytes = 2 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers = {
      Accept: accept,
      "User-Agent": "shirube-external-gate-subject-resolver",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = https.request(parsed, { method: "GET", headers }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          request.destroy(new Error(`response exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode,
        location: response.headers.location,
        body: Buffer.concat(chunks),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

function blocked(itemId, extra = {}) {
  return report("BLOCKED", itemId, extra);
}

function failure(itemId, extra = {}) {
  return report("FAILURE", itemId, extra);
}

function report(verdict, itemId, extra) {
  const [code, message] = FINDINGS[itemId];
  return {
    schema_version: EXTERNAL_GATE_SUBJECT_RESOLUTION_SCHEMA,
    verdict,
    would_block: true,
    blockers: [{ item_id: itemId, code, severity: "BLOCK", message, ...extra }],
    materialized_path: null,
    source_metadata_path: null,
  };
}

function digestValue(value) {
  const match = String(value ?? "").trim().match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

function handoffCellId(handoff) {
  return firstPresent(
    handoff?.cell?.id,
    handoff?.cell?.["CELL-ID"],
    handoff?.cell?.cell_id,
    handoff?.cell_id,
    handoff?.CELL_ID,
    handoff?.control_handoff?.cell_id,
  );
}

function firstPresent(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function lowerSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SHA_PATTERN.test(normalized) ? normalized : null;
}

function stringOption(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRepo(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  process.stderr.write("Usage: node resolve-external-gate-subject-ref.mjs --external-gate-subject-artifact-ref <github-actions-artifact://owner/repo/id> --actual-repo <owner/repo> --actual-pr <number> --actual-head <sha> --handoff <path> --result-dir <path> [--github-token-env <name>] --format json\n       node resolve-external-gate-subject-ref.mjs --fixture-matrix <dir> --format json\n");
}

if (isMain(import.meta.url)) {
  const { options } = parseArgs(process.argv.slice(2));
  const matrixDir = stringOption(options["fixture-matrix"]);
  const operation = matrixDir
    ? runFixtureMatrix(matrixDir)
    : resolveExternalGateSubject(options);
  operation
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.verdict !== "PASS") process.exitCode = 1;
    })
    .catch((error) => {
      usage();
      process.stderr.write(`${errorMessage(error)}\n`);
      process.exitCode = 2;
    });
}
