import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function runGate(
  body: string,
  changedFiles: string[],
  options: {
    draft?: boolean;
    labels?: string[];
    ownerMergeMethod?: string;
    trailingCommentBody?: string;
    expectedHeadSha?: string;
    eventHeadSha?: string;
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
    ], {
      cwd: repoRoot,
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
});
