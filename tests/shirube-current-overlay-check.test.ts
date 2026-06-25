import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function runGate(body: string, changedFiles: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "shirube-current-overlay-"));
  const eventPath = join(dir, "event.json");
  const changedFilesPath = join(dir, "changed-files.txt");

  writeFileSync(eventPath, JSON.stringify({
    number: 999,
    pull_request: {
      number: 999,
      draft: true,
      body,
      labels: [],
      head: { sha: headSha },
    },
  }));
  writeFileSync(changedFilesPath, `${changedFiles.join("\n")}\n`);

  try {
    return spawnSync("node", [
      "scripts/shirube-current-overlay-check.mjs",
      "--repo",
      "watchout/agent-comms-mcp",
      "--event",
      eventPath,
      "--changed-files",
      changedFilesPath,
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
});
