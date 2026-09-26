import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildPublicationComment,
  buildPreflightBody,
  expectedHostedHandoffRef,
  findUnresolvedSemanticDuplicates,
  prepareCompatibilityCompleteHandoff,
  publicationArtifactPaths,
  publicationCompatibilityFindings,
  publicationDecision,
  semanticHandoffKey,
} from "../.shirube/runtime/rapid-lite/preflight-control-handoff.mjs";
import { extractCanonicalControlHandoff } from "../.shirube/runtime/rapid-lite/resolve-control-handoff-ref.mjs";

const HEAD = "fb980e7dff60ddac258beb4d51823c1a82168bc2";
const OTHER_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IMPLEMENTATION_EVIDENCE = "https://github.com/watchout/agent-comms-mcp/pull/915#issuecomment-5188078795";
const PASS_AGGREGATE = {
  schema: "shirube-rapid-lite-report/v1",
  verdict: "PASS_WITH_WARN",
  would_block: false,
  report_failed: false,
};
const ACTUAL_SUBJECT = {
  actualRepo: "watchout/agent-comms-mcp",
  actualPr: 915,
  actualHead: HEAD,
};

describe("control handoff publication preflight", () => {
  test("generates the raw compatibility keys required by every current checker", () => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });

    expect(prepared.cell).toMatchObject({
      id: "CELL-AUN-REGISTRY-IDENTITY-RECONCILIATION-001",
      "CELL-ID": "CELL-AUN-REGISTRY-IDENTITY-RECONCILIATION-001",
      cell_id: "CELL-AUN-REGISTRY-IDENTITY-RECONCILIATION-001",
    });
    expect(prepared).toMatchObject({
      lifecycle_state: "READY_FOR_IMPLEMENTATION",
      artifact_state: "READY_FOR_IMPLEMENTATION",
      spec_review_state: "ready_for_implementation",
      handoff_ready_for_implementation: true,
      protected_stop: true,
    });
    expect(prepared.validation.required_evidence).toEqual([
      "pr_head_sha",
      "changed_files",
      "validation_commands",
    ]);
    expect(prepared.validation.evidence_refs).toEqual([IMPLEMENTATION_EVIDENCE]);
    expect(publicationCompatibilityFindings(prepared)).toEqual([]);
  });

  test("does not invent implementation readiness without an explicit generator flag", () => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff());
    const codes = publicationCompatibilityFindings(prepared).map((entry) => entry.code);

    expect(prepared.lifecycle_state).toBe("IMPLEMENTED_EXACT_HEAD_READY_FOR_METADATA_BINDING_CORRECTION");
    expect(codes).toContain("handoff_not_ready_for_implementation");
  });

  test("moves immutable evidence URLs out of the checker type list without losing them", () => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });

    expect(prepared.validation.required_evidence).not.toContain(IMPLEMENTATION_EVIDENCE);
    expect(prepared.validation.evidence_refs).toContain(IMPLEMENTATION_EVIDENCE);
    expect(publicationCompatibilityFindings(prepared).find((entry) => entry.code === "unrecognized_required_evidence")).toBeUndefined();
  });

  test("preserves and blocks unknown evidence requirements instead of silently weakening them", () => {
    const input = baseHandoff();
    input.validation.required_evidence.push("custom_probe_receipt");
    const prepared = prepareCompatibilityCompleteHandoff(input, {
      markReadyForImplementation: true,
    });

    expect(prepared.validation.required_evidence).toContain("custom_probe_receipt");
    expect(publicationCompatibilityFindings(prepared)).toContainEqual(
      expect.objectContaining({ code: "unrecognized_required_evidence" }),
    );
  });

  test("derives a marker-independent semantic identity", () => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });
    const reordered = structuredClone(prepared);
    reordered.allowed_paths.reverse();

    expect(semanticHandoffKey(reordered)).toBe(semanticHandoffKey(prepared));
  });

  test("blocks conflicting head aliases before duplicate or aggregate evidence can authorize publication", () => {
    const prior = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });
    const candidate = structuredClone(prior);
    candidate.exact_subject.head_commit = OTHER_HEAD;
    const priorComment = commentFor(prior, "CH-PRIOR", "https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-2");
    const decision = publicationDecision({
      handoff: candidate,
      aggregate: PASS_AGGREGATE,
      comments: [priorComment],
      commentsChecked: true,
      actualRepo: "watchout/agent-comms-mcp",
      actualPr: 915,
      actualHead: HEAD,
    });

    expect(semanticHandoffKey(candidate)).toBeNull();
    expect(decision.compatibility_findings.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["exact_head_alias_mismatch", "actual_head_mismatch"]),
    );
    expect(decision.allow_publish).toBe(false);
  });

  test("blocks a semantic duplicate even when its marker and handoff id differ", () => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });
    const duplicate = structuredClone(prepared);
    duplicate.handoff_id = "CH-DIFFERENT-MARKER";
    duplicate.control_handoff_id = "CH-DIFFERENT-MARKER";
    const comment = commentFor(duplicate, "CH-DIFFERENT-MARKER", "https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-1");

    expect(findUnresolvedSemanticDuplicates({ candidate: prepared, comments: [comment] })).toEqual([
      expect.objectContaining({ html_url: comment.html_url }),
    ]);
  });

  test("allows an explicit immutable successor to supersede every matching predecessor", () => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });
    const predecessorUrl = "https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-1";
    prepared.supersedes = [predecessorUrl];
    const predecessor = commentFor(prepared, "CH-OLD", predecessorUrl);

    expect(findUnresolvedSemanticDuplicates({ candidate: prepared, comments: [[predecessor]] })).toEqual([]);
  });

  test("computes the hosted resolver binding from workspace geometry", () => {
    expect(expectedHostedHandoffRef({
      workspaceRoot: "/work",
      targetDir: "/work/target",
    })).toBe("../.shirube-rapid-lite/external-control-handoff.yaml");
  });

  test("binds report artifact paths to the trusted workspace result directory, not caller cwd", () => {
    expect(publicationArtifactPaths("/work/.results")).toEqual({
      preparedHandoff: "/work/.results/prepared-control-handoff.json",
      publicationComment: "/work/.results/publication-comment.md",
    });
  });

  test("generates the exact YAML-fenced comment shape consumed by the hosted resolver", () => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });
    const comment = buildPublicationComment(prepared);
    const extracted = extractCanonicalControlHandoff(comment);

    expect(comment).toStartWith(`<!-- shirube-v3:control-handoff:${prepared.handoff_id} -->\n\n\`\`\`yaml\n`);
    expect(extracted.error).toBeUndefined();
    expect(extracted.handoff).toEqual(prepared);
  });

  test("rejects marker-unsafe handoff ids before publication", () => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });
    prepared.handoff_id = "bad id";
    prepared.control_handoff_id = "bad id";

    expect(() => buildPublicationComment(prepared)).toThrow("marker-safe");
    expect(publicationDecision({
      handoff: prepared,
      aggregate: PASS_AGGREGATE,
      comments: [],
      commentsChecked: true,
      ...ACTUAL_SUBJECT,
    })).toMatchObject({
      allow_publish: false,
      compatibility_findings: expect.arrayContaining([
        expect.objectContaining({ code: "marker_unsafe_handoff_id" }),
      ]),
    });
  });

  test("preflight body pins the candidate before defaults and removes stale handoff bindings", () => {
    const targetDir = path.resolve(import.meta.dir, "..");
    const preparedPath = "/work/prepared-control-handoff.json";
    const body = buildPreflightBody({
      targetDir,
      preparedPath,
      prBody: "handoff_ref: .shirube/control-handoffs/CH-001.yaml\ncontrol_handoff_comment_ref: https://github.com/example/old\nCELL-ID: CELL-001\n",
    });

    expect(body).toContain(`handoff_ref: ${preparedPath}`);
    expect(body).not.toContain("handoff_ref: .shirube/control-handoffs/CH-001.yaml");
    expect(body).not.toContain("control_handoff_comment_ref:");
    expect(body).toContain("CELL-ID: CELL-001");
  });

  test("publication runner snapshots ephemeral changed-file input before spawning gates", () => {
    const source = Bun.file(path.resolve(import.meta.dir, "../.shirube/runtime/rapid-lite/preflight-control-handoff.mjs"));

    expect(source.size).toBeGreaterThan(0);
    return source.text().then((text) => {
      expect(text).toContain('const stableChangedFilesPath = path.join(results, "changed-files.txt")');
      expect(text).toContain('writeNewResultFile(stableChangedFilesPath, readFileSync(changedFilesPath, "utf8"))');
      expect(text).toContain('"changed-files": stableChangedFilesPath');
    });
  });

  test("publication remains fail-closed without aggregate pass and a completed comment scan", () => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });

    expect(publicationDecision({
      handoff: prepared,
      aggregate: PASS_AGGREGATE,
      comments: [],
      commentsChecked: true,
      ...ACTUAL_SUBJECT,
    }).allow_publish).toBe(true);
    expect(publicationDecision({
      handoff: prepared,
      aggregate: { ...PASS_AGGREGATE, would_block: true },
      comments: [],
      commentsChecked: true,
      ...ACTUAL_SUBJECT,
    }).allow_publish).toBe(false);
    expect(publicationDecision({
      handoff: prepared,
      aggregate: PASS_AGGREGATE,
      comments: [],
      commentsChecked: false,
      ...ACTUAL_SUBJECT,
    }).allow_publish).toBe(false);
  });

  test("rejects publication when authenticated runtime subject inputs are omitted", () => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });
    const decision = publicationDecision({
      handoff: prepared,
      aggregate: PASS_AGGREGATE,
      comments: [],
      commentsChecked: true,
    });

    expect(decision.allow_publish).toBe(false);
    expect(decision.compatibility_findings.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["actual_repository_missing", "actual_pull_request_missing", "actual_head_missing"]),
    );
  });

  test.each([
    undefined,
    null,
    {},
    [{}],
    [{ id: null, body: "" }],
  ])("rejects an incomplete or malformed comment scan payload: %p", (comments) => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });
    const decision = publicationDecision({
      handoff: prepared,
      aggregate: PASS_AGGREGATE,
      comments,
      commentsChecked: true,
      ...ACTUAL_SUBJECT,
    });

    expect(decision.allow_publish).toBe(false);
    expect(decision.compatibility_findings).toContainEqual(
      expect.objectContaining({ code: "comment_scan_incomplete" }),
    );
  });

  test.each([
    { ...PASS_AGGREGATE, schema: undefined },
    { ...PASS_AGGREGATE, schema: "wrong-schema/v1" },
    { ...PASS_AGGREGATE, verdict: "BLOCKED" },
    { ...PASS_AGGREGATE, verdict: "FAILURE" },
    { ...PASS_AGGREGATE, verdict: "SKIPPED" },
    { ...PASS_AGGREGATE, verdict: "UNKNOWN" },
    { ...PASS_AGGREGATE, verdict: undefined },
  ])("rejects a non-passing Rapid/Lite aggregate contract: %p", (aggregate) => {
    const prepared = prepareCompatibilityCompleteHandoff(baseHandoff(), {
      markReadyForImplementation: true,
    });

    expect(publicationDecision({
      handoff: prepared,
      aggregate,
      comments: [],
      commentsChecked: true,
      ...ACTUAL_SUBJECT,
    }).allow_publish).toBe(false);
  });
});

function baseHandoff() {
  return {
    schema_version: "shirube-v3/control_handoff/v1",
    handoff_id: "CH-CELL20-HEARTBEAT-VOLATILE-READSET-FENCE-20260805-001",
    corrective_id: "CELL20-HEARTBEAT-VOLATILE-READSET-FENCE-001",
    lifecycle_state: "IMPLEMENTED_EXACT_HEAD_READY_FOR_METADATA_BINDING_CORRECTION",
    artifact_state: "READY_FOR_BOUNDED_METADATA_CORRECTION",
    control_source: "https://github.com/watchout/agent-comms-mcp/issues/602",
    repository: {
      name: "watchout/agent-comms-mcp",
      pull_request: 915,
    },
    cell: {
      id: "CELL-AUN-REGISTRY-IDENTITY-RECONCILIATION-001",
    },
    exact_subject: {
      head_commit: HEAD,
    },
    pr_head_sha: HEAD,
    allowed_paths: [
      "core/registry-identity-reconciliation.ts",
      "tests/registry-identity-reconciliation.test.ts",
    ],
    forbidden_paths: ["db/**"],
    stop_conditions: ["exact subject drift"],
    required_checks: ["git diff --check"],
    required_evidence: [IMPLEMENTATION_EVIDENCE],
    validation: {
      required_commands: ["git diff --check"],
      required_evidence: [IMPLEMENTATION_EVIDENCE],
    },
    next_action: {
      blocking: true,
      owner_agent: "codex-cto",
      owner_function: "orchestration_controller",
      action: "preflight then publish once",
      handoff_method: "immutable comment",
      input_refs: [IMPLEMENTATION_EVIDENCE],
      scope: "metadata only",
      deliverable: "non-blocked Rapid/Lite report",
      completion_evidence: "immutable URL and digest",
      stop_reason: "stop on drift",
    },
  };
}

function commentFor(handoff: Record<string, unknown>, marker: string, htmlUrl: string) {
  return {
    id: 1,
    html_url: htmlUrl,
    body: `<!-- shirube-v3:control-handoff:${marker} -->\n\`\`\`yaml\n${JSON.stringify(handoff, null, 2)}\n\`\`\`\n`,
  };
}
