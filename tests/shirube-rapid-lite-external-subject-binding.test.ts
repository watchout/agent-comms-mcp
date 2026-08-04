import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateFlowSafety } from "../.shirube/runtime/rapid-lite/check-flow-safety.mjs";
import { generateExternalGateSubject } from "../.shirube/runtime/rapid-lite/generate-external-gate-subject.mjs";
import { runFlowSafety } from "../.shirube/runtime/rapid-lite/run-rapid-lite-report.mjs";
import {
  prepareWorkflowDirectories,
  writeNewResultFile,
} from "../.shirube/runtime/rapid-lite/run-rapid-lite-workflow.mjs";
import {
  downloadArtifactBuffer,
  inspectExternalSubjectArchive,
  isAllowedArtifactDownloadUrl,
  parseArtifactRef,
  runFixtureMatrix,
  shouldSendArtifactAuthorization,
} from "../.shirube/runtime/rapid-lite/resolve-external-gate-subject-ref.mjs";

const fixtureMatrix = path.join(
  import.meta.dir,
  "fixtures/shirube-rapid-lite-external-subject-binding",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("external exact-head subject producer", () => {
  test("derives all six fields from the authenticated PR observation and exact handoff bytes", async () => {
    const directory = tempDirectory();
    const handoff = path.join(directory, "handoff.yaml");
    const prFixture = path.join(directory, "pull-request.json");
    const output = path.join(directory, "subject.yaml");
    writeFileSync(handoff, "schema_version: shirube-control-handoff/rapid-lite/v1\ncell_id: CELL-EXTERNAL-001\n");
    writeFileSync(prFixture, `${JSON.stringify({
      number: 42,
      url: "https://api.github.com/repos/watchout/agent-comms-mcp/pulls/42",
      head: {
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        repo: { full_name: "watchout/agent-comms-mcp" },
      },
      base: { repo: { full_name: "watchout/agent-comms-mcp" } },
    })}\n`);

    const report = await generateExternalGateSubject({
      repo: "watchout/agent-comms-mcp",
      pr: "42",
      handoff,
      output,
      "checked-out-head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "pr-fixture": prFixture,
    });
    const subject = JSON.parse(readFileSync(output, "utf8"));
    expect(report.verdict).toBe("PASS");
    expect(report.caller_overrides_accepted).toBe(false);
    expect(subject).toMatchObject({
      schema_version: "shirube-external-gate-subject/v1",
      cell_id: "CELL-EXTERNAL-001",
      repo: "watchout/agent-comms-mcp",
      PR: 42,
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      gate_type: "PR_exact_head_audit",
    });
    expect(subject.control_input_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.target_branch_mutated).toBe(false);
  });

  test("fails instead of overwriting an existing subject payload", async () => {
    const directory = tempDirectory();
    const handoff = path.join(directory, "handoff.yaml");
    const prFixture = path.join(directory, "pull-request.json");
    const output = path.join(directory, "subject.yaml");
    writeFileSync(handoff, "cell_id: CELL-EXTERNAL-001\n");
    writeFileSync(prFixture, `${JSON.stringify({
      number: 42,
      head: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", repo: { full_name: "watchout/agent-comms-mcp" } },
      base: { repo: { full_name: "watchout/agent-comms-mcp" } },
    })}\n`);
    const options = {
      repo: "watchout/agent-comms-mcp",
      pr: "42",
      handoff,
      output,
      "pr-fixture": prFixture,
    };
    await generateExternalGateSubject(options);
    expect(generateExternalGateSubject(options)).rejects.toThrow();
  });
});

describe("external subject resolver fixture matrix", () => {
  test("allows only canonical HTTPS artifact download hosts and contains authorization to the GitHub API", () => {
    const allowed = [
      "https://api.github.com/repos/watchout/agent-comms-mcp/actions/artifacts/4242/zip",
      "https://results-receiver.actions.githubusercontent.com/results/abc",
      "https://productionresultssa0.blob.core.windows.net/actions-results/abc",
      "https://raw.githubusercontent.com/watchout/agent-comms-mcp/main/subject.yaml",
    ];
    const rejected = [
      "http://productionresultssa0.blob.core.windows.net/actions-results/abc",
      "https://token@productionresultssa0.blob.core.windows.net/actions-results/abc",
      "https://productionresultssa0.blob.core.windows.net.evil.example/actions-results/abc",
      "https://nested.productionresultssa0.blob.core.windows.net/actions-results/abc",
      "https://results-receiver.actions.githubusercontent.com.evil.example/results/abc",
      "https://blob.core.windows.net/actions-results/abc",
      "https://api.github.com:444/repos/watchout/agent-comms-mcp/actions/artifacts/4242/zip",
    ];

    for (const url of allowed) expect(isAllowedArtifactDownloadUrl(url)).toBe(true);
    for (const url of rejected) expect(isAllowedArtifactDownloadUrl(url)).toBe(false);
    expect(shouldSendArtifactAuthorization(allowed[0])).toBe(true);
    for (const url of allowed.slice(1)) expect(shouldSendArtifactAuthorization(url)).toBe(false);
  });

  test("drops authorization after the API redirect and rejects excessive redirects", async () => {
    const requests: Array<{ url: string; token: string | null }> = [];
    const archive = await downloadArtifactBuffer({
      url: "https://api.github.com/repos/watchout/agent-comms-mcp/actions/artifacts/4242/zip",
      token: "secret",
      request: async ({ url, token }: { url: string; token: string | null }) => {
        requests.push({ url, token });
        if (requests.length === 1) {
          return {
            status: 302,
            location: "https://productionresultssa0.blob.core.windows.net/actions-results/subject.zip",
            body: Buffer.alloc(0),
          };
        }
        return { status: 200, location: undefined, body: Buffer.from("archive") };
      },
    });
    expect(archive.toString("utf8")).toBe("archive");
    expect(requests.map(({ token }) => token)).toEqual(["secret", null]);

    let redirectRequests = 0;
    await expect(downloadArtifactBuffer({
      url: "https://api.github.com/repos/watchout/agent-comms-mcp/actions/artifacts/4242/zip",
      token: "secret",
      request: async () => {
        redirectRequests += 1;
        return {
          status: 302,
          location: "https://results-receiver.actions.githubusercontent.com/results/next",
          body: Buffer.alloc(0),
        };
      },
    })).rejects.toThrow("Too many artifact download redirects");
    expect(redirectRequests).toBe(4);
  });

  test("accepts the canonical artifact ref shape only", () => {
    expect(parseArtifactRef("github-actions-artifact://watchout/agent-comms-mcp/4242")).toEqual({
      repo: "watchout/agent-comms-mcp",
      artifactId: 4242,
    });
    expect(parseArtifactRef("https://github.com/watchout/agent-comms-mcp/issues/602")).toBeNull();
  });

  test("inspects real zip bytes and rejects a second payload", () => {
    const directory = tempDirectory();
    const subjectPath = path.join(directory, "shirube-external-gate-subject.yaml");
    const zipPath = path.join(directory, "subject.zip");
    writeFileSync(subjectPath, "{\"schema_version\":\"shirube-external-gate-subject/v1\"}\n");
    const zipped = spawnSync("zip", ["-j", "-q", zipPath, subjectPath], { encoding: "utf8" });
    expect(zipped.status).toBe(0);
    expect(inspectExternalSubjectArchive(readFileSync(zipPath)).toString("utf8")).toContain("shirube-external-gate-subject/v1");

    const shadow = path.join(directory, "shadow.yaml");
    writeFileSync(shadow, "{}\n");
    const appended = spawnSync("zip", ["-j", "-q", zipPath, shadow], { encoding: "utf8" });
    expect(appended.status).toBe(0);
    expect(() => inspectExternalSubjectArchive(readFileSync(zipPath))).toThrow("expected exactly");
  });

  test("passes the positive fixture and all ten fail-closed negative classes", async () => {
    const matrix = await runFixtureMatrix(fixtureMatrix);
    expect(matrix.verdict).toBe("PASS");
    expect(matrix.fixture_count).toBe(11);
    expect(matrix.passed_count).toBe(11);
    expect(matrix.results.map((entry) => entry.id).sort()).toEqual([
      "archive_shape_attack_negative",
      "event_api_disagreement_negative",
      "expired_or_deleted_artifact_negative",
      "external_exact_subject_positive",
      "handoff_digest_mismatch_negative",
      "missing_artifact_negative",
      "mutable_or_unauthenticated_binding_negative",
      "predecessor_head_negative",
      "successor_head_negative",
      "wrong_repo_pr_cell_negative",
      "wrong_workflow_or_event_negative",
    ]);
  });

  test("provides independently authenticated source metadata to flow-safety", async () => {
    const matrix = await runFixtureMatrix(fixtureMatrix);
    const positive = matrix.results.find((entry) => entry.id === "external_exact_subject_positive");
    if (!positive) throw new Error("positive fixture missing");
    const subject = positive.report.subject;
    const source = positive.report.source;
    const report = evaluateFlowSafety({
      schema_version: "shirube-flow-safety-input/v1",
      subject,
      expected_subject: subject,
      subject_binding_mode: "external_github_actions_artifact",
      external_subject_source: source,
      subject_bytes_sha256: source.subject_sha256,
      active_work: [],
      cells: [],
      affected_cell_id: subject.cell_id,
    });
    expect(report.verdict).toBe("PASS");
    expect(report.subject_binding).toMatchObject({
      authenticated: true,
      source_independence_verified: true,
      artifact_id: 4242,
      workflow_run_id: 7001,
    });
  });

  test("flow-safety rejects checklist/expected-subject fallback", () => {
    const subject = {
      cell_id: "CELL-EXTERNAL-001",
      repo: "watchout/agent-comms-mcp",
      PR: 42,
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      gate_type: "PR_exact_head_audit",
      control_input_digest: "b".repeat(64),
    };
    const report = evaluateFlowSafety({
      schema_version: "shirube-flow-safety-input/v1",
      subject,
      expected_subject: subject,
    });
    expect(report.verdict).toBe("BLOCK");
    expect(report.findings.some((finding) => finding.code === "MISSING_EXTERNAL_GATE_SUBJECT_BINDING")).toBe(true);
  });

  test("Rapid/Lite report integration reads claimed and expected subjects from independent files", () => {
    const directory = tempDirectory();
    const handoffPath = path.join(directory, "handoff.yaml");
    const subjectPath = path.join(directory, "subject.yaml");
    const sourcePath = path.join(directory, "source.json");
    const handoffBytes = Buffer.from("cell_id: CELL-EXTERNAL-001\n", "utf8");
    writeFileSync(handoffPath, handoffBytes);
    const subject = {
      schema_version: "shirube-external-gate-subject/v1",
      cell_id: "CELL-EXTERNAL-001",
      repo: "watchout/agent-comms-mcp",
      PR: 42,
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      gate_type: "PR_exact_head_audit",
      control_input_digest: sha256(handoffBytes),
    };
    const subjectBytes = Buffer.from(`${JSON.stringify(subject, null, 2)}\n`, "utf8");
    writeFileSync(subjectPath, subjectBytes);
    writeFileSync(sourcePath, `${JSON.stringify({
      schema_version: "shirube-external-gate-subject-source/v1",
      verdict: "PASS",
      source_type: "github_actions_artifact",
      claimed_subject_source: "external_artifact_bytes",
      expected_subject_sources: ["github_pull_request_event", "github_pulls_api", "exact_handoff_bytes"],
      source_independence_verified: true,
      subject_sha256: sha256(subjectBytes),
      exact_subject: subject,
      immutable_artifact_identity: {
        repository_id: 1001,
        artifact_id: 4242,
        artifact_node_id: "MDg6QXJ0aWZhY3Q0MjQy",
        artifact_digest: `sha256:${"b".repeat(64)}`,
        workflow_run_id: 7001,
        producer_workflow_id: 8001,
        producer_workflow_path: ".github/workflows/shirube-external-gate-subject-request.yml",
        producer_head_sha: "d".repeat(40),
      },
      authenticated_provenance: {
        api_origin: "api.github.com",
        api_version: "2022-11-28",
        token_env_name: "GITHUB_TOKEN",
        artifact_get_status: 200,
        workflow_run_get_status: 200,
        pull_request_get_status: 200,
        producer_event: "workflow_dispatch",
        producer_actor: "watchout",
        producer_run_conclusion: "success",
        artifact_created_at: "2026-08-04T00:01:00Z",
        artifact_expires_at: "2026-08-18T00:01:00Z",
        artifact_expired: false,
      },
      binding: { all_six_fields_equal: true },
      target_branch_mutated: false,
    }, null, 2)}\n`);

    const record = runFlowSafety({
      resultDir: directory,
      refs: {
        handoff: handoffPath,
        auditChecklist: "external-audit-request-present",
        externalGateSubject: subjectPath,
        externalGateSubjectSource: sourcePath,
      },
      actual: {
        actualRepo: "watchout/agent-comms-mcp",
        actualPr: "42",
        actualHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(record.verdict).toBe("PASS");
    expect(record.report.subject_binding.authenticated).toBe(true);
    expect(record.report.claimed_subject_source).toBe("authenticated_github_actions_artifact");
  });
});

describe("workflow trust boundary", () => {
  test("producer is default-branch workflow_dispatch and consumer uses manifest-verified exact base runtime with actions read", () => {
    const producer = readFileSync(path.join(import.meta.dir, "../.github/workflows/shirube-external-gate-subject-request.yml"), "utf8");
    const consumer = readFileSync(path.join(import.meta.dir, "../.github/workflows/shirube-rapid-lite-gates-report.yml"), "utf8");
    expect(producer).toContain("workflow_dispatch:");
    expect(producer).toContain("Require trusted default-branch dispatch");
    expect(producer).toContain("overwrite: false");
    expect(consumer).toContain("actions: read");
    expect(consumer).toContain("ACTIVE_RUNTIME_DIR: runtime-base-source");
    expect(consumer).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(consumer).toContain("persist-credentials: false");
    expect(consumer).toContain("RESULT_DIR: .shirube-rapid-lite");
    expect(consumer).toContain('--workspace-root "$GITHUB_WORKSPACE"');
    expect(consumer).toContain('--result-dir "$GITHUB_WORKSPACE/$RESULT_DIR"');
    expect(consumer).toContain("node \"$ACTIVE_RUNTIME_DIR/.shirube/runtime/rapid-lite/run-rapid-lite-workflow.mjs\"");
  });

  test("keeps executable PR body bytes outside the target checkout and trusted runtime", async () => {
    const workspace = tempDirectory();
    const target = path.join(workspace, "target");
    const runtime = path.join(workspace, "runtime-base-source");
    const attackerResults = path.join(workspace, "attacker-results");
    const targetResults = path.join(target, ".shirube-rapid-lite");
    const trustedScript = path.join(runtime, "trusted-runtime.mjs");
    const executionMarker = path.join(workspace, "target-code-executed");
    mkdirSync(target, { recursive: true });
    mkdirSync(attackerResults, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(trustedScript, "export const trustedRuntime = true;\n");
    symlinkSync("../attacker-results", targetResults);
    symlinkSync("../runtime-base-source/trusted-runtime.mjs", path.join(attackerResults, "pr-body.md"));

    const prepared = prepareWorkflowDirectories({
      workspaceRoot: workspace,
      targetDir: target,
      resultDir: ".shirube-rapid-lite",
    });
    const executableBody = `import { writeFileSync } from \"node:fs\"; writeFileSync(${JSON.stringify(executionMarker)}, \"executed\");\n`;
    writeNewResultFile(path.join(prepared.resultDir, "pr-body.md"), executableBody);

    expect(prepared.resultDir).toBe(path.join(prepared.workspaceRoot, ".shirube-rapid-lite"));
    expect(readFileSync(path.join(prepared.resultDir, "pr-body.md"), "utf8")).toBe(executableBody);
    expect(readFileSync(trustedScript, "utf8")).toBe("export const trustedRuntime = true;\n");
    const trustedModule = await import(`${pathToFileURL(trustedScript).href}?test=${Date.now()}`);
    expect(trustedModule.trustedRuntime).toBe(true);
    expect(existsSync(executionMarker)).toBe(false);
  });

  test("rejects target-owned and symlinked result directories", () => {
    const workspace = tempDirectory();
    const target = path.join(workspace, "target");
    const runtime = path.join(workspace, "runtime-base-source");
    mkdirSync(target, { recursive: true });
    mkdirSync(runtime, { recursive: true });

    expect(() => prepareWorkflowDirectories({
      workspaceRoot: workspace,
      targetDir: target,
      resultDir: path.join(target, ".shirube-rapid-lite"),
    })).toThrow("result-dir must be outside target-dir");

    symlinkSync(runtime, path.join(workspace, ".shirube-rapid-lite"));
    expect(() => prepareWorkflowDirectories({
      workspaceRoot: workspace,
      targetDir: target,
      resultDir: ".shirube-rapid-lite",
    })).toThrow("result-dir must not be a symlink");
  });

  test("uses no-follow exclusive creation for every runner-owned output", () => {
    const workspace = tempDirectory();
    const target = path.join(workspace, "target");
    const runtime = path.join(workspace, "runtime-base-source");
    const trustedScript = path.join(runtime, "trusted-runtime.mjs");
    mkdirSync(target, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(trustedScript, "export const trustedRuntime = true;\n");
    const prepared = prepareWorkflowDirectories({
      workspaceRoot: workspace,
      targetDir: target,
      resultDir: ".shirube-rapid-lite",
    });
    symlinkSync("../runtime-base-source/trusted-runtime.mjs", path.join(prepared.resultDir, "pr-body.md"));

    expect(() => writeNewResultFile(path.join(prepared.resultDir, "pr-body.md"), "target-controlled\n")).toThrow();
    expect(readFileSync(trustedScript, "utf8")).toBe("export const trustedRuntime = true;\n");
  });
});

function tempDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "shirube-external-subject-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
