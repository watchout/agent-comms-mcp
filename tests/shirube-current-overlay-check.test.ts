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
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "shirube-current-overlay-"));
  const eventPath = join(dir, "event.json");
  const changedFilesPath = join(dir, "changed-files.txt");

  const draft = options.draft ?? true;
  const labels = options.labels ?? [];
  writeFileSync(eventPath, JSON.stringify({
    number: 999,
    pull_request: {
      number: 999,
      draft,
      body,
      labels: labels.map((name) => ({ name })),
      head: { sha: headSha },
    },
  }));
  writeFileSync(changedFilesPath, `${changedFiles.join("\n")}\n`);
  const commentsPath = join(dir, "comments.json");
  const decisionUrl = "https://github.com/watchout/agent-comms-mcp/pull/999#issuecomment-1";
  writeFileSync(commentsPath, JSON.stringify([{
    body: [
      "shirube_owner_decision:",
      "  schema_version: shirube-owner-decision/v1",
      "  target_repo: watchout/agent-comms-mcp",
      "  target_pr: 999",
      `  exact_head_sha: ${headSha}`,
      "  verdict: APPROVED_EXACT_HEAD",
      `  merge_method: ${options.ownerMergeMethod ?? "merge"}`,
      "  actor: watchout",
      `  decision_ref: ${decisionUrl}`,
      options.trailingCommentBody ?? "",
    ].join("\n"),
    user: { login: "watchout" },
    author_association: "OWNER",
    html_url: decisionUrl,
  }]));

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
});
