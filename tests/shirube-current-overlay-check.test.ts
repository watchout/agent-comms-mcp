import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = process.cwd();
const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const rapidLiteWorkflowPath = ".github/workflows/shirube-rapid-lite-gates-report.yml";
const overlayFixturePaths = [
  ".shirube/repo-spec.yaml",
  ".shirube/execution-context.yaml",
  ".shirube/adoption-intake.yaml",
  ".shirube/existing-state-scan.yaml",
  ".shirube/control-handoffs/CH-001.yaml",
  ".shirube/lifecycle-state.yaml",
  ".shirube/enforcement-policy.yaml",
  ".shirube/control-state-completeness.yaml",
  ".shirube/source-mirrors/control-issue.yaml",
  "docs/shirube/README.md",
  rapidLiteWorkflowPath,
  ".github/pull_request_template.md",
  ".github/workflows/pr-checks.yml",
  "scripts/shirube-current-overlay-check.mjs",
  // The gate imports its conformance decision from here rather than keeping a second
  // copy of the rule. An isolated gate root therefore has to carry it too.
  "scripts/lib/cell-conformance.mjs",
  ".shirube/cell-conformance.json",
];

function runGate(
  body: string,
  changedFiles: string[],
  options: {
    draft?: boolean;
    labels?: string[];
    ownerMergeMethod?: string;
    trailingCommentBody?: string;
    expectedHeadSha?: string;
    requiredMergeMethod?: string;
    eventHeadSha?: string;
    workflowBody?: string;
    ownerDecisions?: Array<{
      mergeMethod: string;
      supersedesDecisionRef?: string;
    }>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "shirube-current-overlay-"));
  const eventPath = join(dir, "event.json");
  const changedFilesPath = join(dir, "changed-files.txt");

  const draft = options.draft ?? true;
  const labels = options.labels ?? [];
  const eventHeadSha = options.eventHeadSha ?? headSha;
  writeFileSync(eventPath, JSON.stringify({
    number: 999,
    pull_request: {
      number: 999,
      draft,
      body,
      labels: labels.map((name) => ({ name })),
      head: { sha: eventHeadSha },
    },
  }));
  writeFileSync(changedFilesPath, `${changedFiles.join("\n")}\n`);
  const commentsPath = join(dir, "comments.json");
  const ownerDecisions = options.ownerDecisions ?? [{ mergeMethod: options.ownerMergeMethod ?? "merge" }];
  const comments = ownerDecisions.map((decision, index) => {
    const decisionUrl = `https://github.com/watchout/agent-comms-mcp/pull/999#issuecomment-${index + 1}`;
    return {
      body: [
        "shirube_owner_decision:",
        "  schema_version: shirube-owner-decision/v1",
        "  target_repo: watchout/agent-comms-mcp",
        "  target_pr: 999",
        `  exact_head_sha: ${eventHeadSha}`,
        "  verdict: APPROVED_EXACT_HEAD",
        `  merge_method: ${decision.mergeMethod}`,
        decision.supersedesDecisionRef
          ? `  supersedes_decision_ref: ${decision.supersedesDecisionRef}`
          : "",
        "  actor: watchout",
        `  decision_ref: ${decisionUrl}`,
        index === ownerDecisions.length - 1 ? options.trailingCommentBody ?? "" : "",
      ].filter(Boolean).join("\n"),
      user: { login: "watchout" },
      author_association: "OWNER",
      html_url: decisionUrl,
    };
  });
  writeFileSync(commentsPath, JSON.stringify(comments));

  let gateRoot = repoRoot;
  if (options.workflowBody !== undefined) {
    gateRoot = join(dir, "repo");
    for (const relativePath of overlayFixturePaths) {
      const destination = join(gateRoot, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(repoRoot, relativePath), destination);
    }
    writeFileSync(join(gateRoot, rapidLiteWorkflowPath), options.workflowBody);
  }

  try {
    return spawnSync("node", [
      "scripts/shirube-current-overlay-check.mjs",
      "--repo",
      "watchout/agent-comms-mcp",
      "--event",
      eventPath,
      "--changed-files",
      changedFilesPath,
      "--comments",
      commentsPath,
      ...(options.expectedHeadSha ? ["--expected-head", options.expectedHeadSha] : []),
      ...(options.requiredMergeMethod ? ["--required-merge-method", options.requiredMergeMethod] : []),
    ], {
      cwd: gateRoot,
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseBody(cellId: string, riskTier: string) {
  return [
    "## Shirube Metadata",
    `CELL-ID: ${cellId}`,
    `Risk Tier: ${riskTier}`,
    `Exact Head SHA: ${headSha}`,
    "",
    "## Allowed paths",
    "- bin/**",
    "- core/**",
    "- tests/**",
    "",
    "## Protected surfaces",
    "```text",
    "touched: runtime read-only planning surface",
    "declared: runtime",
    "```",
    "",
    "## Validation",
    "- pending",
  ].join("\n");
}

describe("shirube-current-overlay-check", () => {
  test("allows runtime implementation PRs under the installed overlay gate", () => {
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      [
        "bin/aun/runtime-v2.ts",
        "core/aun-runtime-v2-claim-plan.ts",
        "tests/aun-runtime-v2-claim-plan.test.ts",
      ],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Shirube current-overlay gate passed.");
  });

  test("still blocks runtime files in the Rapid/Lite adoption overlay PR", () => {
    const result = runGate(
      baseBody("CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001", "R2"),
      [
        ".shirube/repo-spec.yaml",
        "core/aun-runtime-v2-claim-plan.ts",
      ],
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("core/aun-runtime-v2-claim-plan.ts is a runtime/product protected file");
  });

  test("allows a non-draft PR when the owner decision and one merge-method label match", () => {
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      ["tests/aun-runtime-v2-claim-plan.test.ts"],
      {
        draft: false,
        labels: ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:merge"],
        ownerMergeMethod: "merge",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Shirube current-overlay gate passed.");
  });

  test("blocks a merge-method label that disagrees with the exact-head owner decision", () => {
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      ["tests/aun-runtime-v2-claim-plan.test.ts"],
      {
        draft: false,
        labels: ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:squash"],
        ownerMergeMethod: "merge",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Owner decision merge_method=merge does not match label merge-method:squash.");
  });

  test("blocks an owner decision that omits merge_method", () => {
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      ["tests/aun-runtime-v2-claim-plan.test.ts"],
      {
        draft: false,
        labels: ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:merge"],
        ownerMergeMethod: "",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Owner decision must select merge_method=merge, squash, or rebase; got <empty>.");
  });

  test("blocks missing, multiple, and unsupported merge-method labels", () => {
    for (const labels of [
      ["owner-exact-head-approved", "shirube-current-overlay"],
      ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:merge", "merge-method:squash"],
      ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:octopus"],
    ]) {
      const result = runGate(
        baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
        ["tests/aun-runtime-v2-claim-plan.test.ts"],
        { draft: false, labels, ownerMergeMethod: "merge" },
      );
      expect(result.status).toBe(1);
    }
  });

  test("parses merge_method only from the shirube owner decision block", () => {
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      ["tests/aun-runtime-v2-claim-plan.test.ts"],
      {
        draft: false,
        labels: ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:merge"],
        ownerMergeMethod: "merge",
        trailingCommentBody: "next_action:\n  merge_method: squash",
      },
    );

    expect(result.status).toBe(0);
  });

  test("fails closed when exact-head owner decisions conflict without explicit supersession", () => {
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      ["tests/aun-runtime-v2-claim-plan.test.ts"],
      {
        draft: false,
        labels: ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:squash"],
        ownerDecisions: [{ mergeMethod: "squash" }, { mergeMethod: "merge" }],
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("requires exactly one authoritative owner decision after explicit supersession; found 2");
  });

  test("accepts one current exact-head decision when it explicitly supersedes the prior decision", () => {
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      ["tests/aun-runtime-v2-claim-plan.test.ts"],
      {
        draft: false,
        labels: ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:merge"],
        ownerDecisions: [
          { mergeMethod: "squash" },
          {
            mergeMethod: "merge",
            supersedesDecisionRef: "https://github.com/watchout/agent-comms-mcp/pull/999#issuecomment-1",
          },
        ],
      },
    );

    expect(result.status).toBe(0);
  });

  test("fails closed when a superseding decision changes method but the live label is stale", () => {
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      ["tests/aun-runtime-v2-claim-plan.test.ts"],
      {
        draft: false,
        labels: ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:squash"],
        ownerDecisions: [
          { mergeMethod: "squash" },
          {
            mergeMethod: "merge",
            supersedesDecisionRef: "https://github.com/watchout/agent-comms-mcp/pull/999#issuecomment-1",
          },
        ],
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Owner decision merge_method=merge does not match label merge-method:squash.");
  });

  test("fails closed when supersedes_decision_ref does not identify a prior valid exact-head decision", () => {
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      ["tests/aun-runtime-v2-claim-plan.test.ts"],
      {
        draft: false,
        labels: ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:merge"],
        ownerDecisions: [{
          mergeMethod: "merge",
          supersedesDecisionRef: "https://github.com/watchout/agent-comms-mcp/pull/999#issuecomment-404",
        }],
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("has invalid supersedes_decision_ref=");
  });

  test("fails closed when the live PR head differs from the checked workflow head", () => {
    const checkedHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      ["tests/aun-runtime-v2-claim-plan.test.ts"],
      {
        draft: false,
        labels: ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:merge"],
        ownerMergeMethod: "merge",
        expectedHeadSha: checkedHead,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`Live PR head ${headSha} does not match checked head ${checkedHead}.`);
  });

  test("allows auto-squash revalidation only while the live decision and label remain squash", () => {
    const result = runGate(
      baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
      ["tests/aun-runtime-v2-claim-plan.test.ts"],
      {
        draft: false,
        labels: ["owner-exact-head-approved", "shirube-current-overlay", "merge-method:squash"],
        ownerMergeMethod: "squash",
        expectedHeadSha: headSha,
        requiredMergeMethod: "squash",
      },
    );

    expect(result.status).toBe(0);
  });

  test.each(["merge", "rebase"])(
    "fails a stale auto-squash run after the live authority changes to %s",
    (currentMethod) => {
      const result = runGate(
        baseBody("CELL-MCP-AUN-RUNTIME-V2-CLAIM-DRYRUN-001", "R1"),
        ["tests/aun-runtime-v2-claim-plan.test.ts"],
        {
          draft: false,
          labels: ["owner-exact-head-approved", "shirube-current-overlay", `merge-method:${currentMethod}`],
          ownerDecisions: [
            { mergeMethod: "squash" },
            {
              mergeMethod: currentMethod,
              supersedesDecisionRef: "https://github.com/watchout/agent-comms-mcp/pull/999#issuecomment-1",
            },
          ],
          expectedHeadSha: headSha,
          requiredMergeMethod: "squash",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`Execution requires merge_method=squash, but the live label selects ${currentMethod}.`);
      expect(result.stdout).toContain(`Execution requires merge_method=squash, but the authoritative owner decision selects ${currentMethod}.`);
    },
  );

  test("accepts the public same-repository exact-ref manifest-verified local runtime topology", () => {
    const workflowBody = readFileSync(join(repoRoot, rapidLiteWorkflowPath), "utf8");
    const result = runGate(
      baseBody("CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001", "R3"),
      [rapidLiteWorkflowPath],
      { workflowBody },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Shirube current-overlay gate passed.");
  });

  test("rejects a private ADF reusable workflow call or checkout", () => {
    const canonical = readFileSync(join(repoRoot, rapidLiteWorkflowPath), "utf8");
    const privateRef = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const variants = [
      canonical.replace(
        "jobs:\n",
        `jobs:\n  forbidden-private-call:\n    uses: \"watchout/ai-dev-framework/.github/workflows/shirube-rapid-lite-reusable.yml@${privateRef}\"\n`,
      ),
      canonical.replace(
        "repository: watchout/agent-comms-mcp",
        "repository: watchout/ai-dev-framework",
      ),
    ];

    for (const workflowBody of variants) {
      const result = runGate(
        baseBody("CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001", "R3"),
        [rapidLiteWorkflowPath],
        { workflowBody },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("must not call or checkout the private ADF repository");
    }
  });

  test("rejects a drifted public runtime ref", () => {
    const canonical = readFileSync(join(repoRoot, rapidLiteWorkflowPath), "utf8");
    const workflowBody = canonical.replace(
      "4ea4b8bc122e22c47323fc8836dc3d7aedd487e9",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    const result = runGate(
      baseBody("CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001", "R3"),
      [rapidLiteWorkflowPath],
      { workflowBody },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("must declare the exact pinned public runtime ref once");
  });

  test("rejects missing strict runtime manifest verification", () => {
    const canonical = readFileSync(join(repoRoot, rapidLiteWorkflowPath), "utf8");
    const workflowBody = canonical.replace("sha256sum --check --strict", "sha256sum --check");
    const result = runGate(
      baseBody("CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001", "R3"),
      [rapidLiteWorkflowPath],
      { workflowBody },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("must include sha256sum --check --strict");
  });
});
