#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { evaluateStandingAuthorization } from "./lib/cell-conformance.mjs";

// The owner published a standing authorization for frozen-roadmap A1 work:
// CI green, no schema/billing/credential change, no breaking change, and it does not
// override this gate for anything protected. Until this amendment, that decision could
// not reach the gate at all: the exact-head requirement below applied to every non-draft
// PR unconditionally, and a standing policy cannot satisfy a check on who authored a
// comment. The result was that every PR in this repository, however small, required the
// owner to run an approval by hand.
//
// This waiver mechanises the decision the owner already made, and nothing more.
const STANDING_DECISION_ID = "OD-AUN-602-STANDING-MERGE-AND-NO-DRIFT-20260816-001";
const STANDING_DECISION_URL = "https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5306783646";
const CONFORMANCE_CONFIG_PATH = ".shirube/cell-conformance.json";

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "full";
const sourceAdmissionOnly = mode === "source-admission";
const repo = stringArg(args.repo) ?? process.env.GITHUB_REPOSITORY ?? "";
const eventPath = stringArg(args.event) ?? process.env.GITHUB_EVENT_PATH ?? "";
const changedFilesPath = stringArg(args["changed-files"]);
const expectedHeadSha = stringArg(args["expected-head"]);
const requiredMergeMethod = stringArg(args["required-merge-method"]);
const changedFiles = readChangedFiles(changedFilesPath);
const event = readJsonIfPresent(eventPath);
const pr = event?.pull_request ?? null;
const prNumber = Number(pr?.number ?? event?.number ?? process.env.GITHUB_PR_NUMBER ?? 0);
const body = String(pr?.body ?? "");
const labels = new Set((pr?.labels ?? []).map((label) => String(label.name ?? "")));
const headSha = String(pr?.head?.sha ?? process.env.GITHUB_SHA ?? "");
const errors = [];
const warnings = [];
const supportedMergeMethods = new Set(["merge", "squash", "rebase"]);
const mergeMethodLabelPrefix = "merge-method:";
const isRapidLiteAdoptionPr = /(?:^|\n)\s*CELL-ID\s*:\s*CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001(?:\s|$)/iu.test(body);

const adoptionForbiddenRuntimePatterns = [
  /^server\.ts$/u,
  /^core\//u,
  /^cli\//u,
  /^bin\/(?!aun\.ts$)/u,
  /^entrypoints\//u,
  /^adapters\//u,
  /^db\//u,
  /^hooks\//u,
  /^config\/(?!queue-work-residue-policy\.json$)/u,
  /^package\.json$/u,
  /^bun\.lockb$/u,
  /^package-lock\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^\.env/u,
  /^secrets\//u,
  /^deploy\//u,
];

const requiredArtifacts = [
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
  ".github/workflows/shirube-rapid-lite-gates-report.yml",
  ".github/pull_request_template.md",
];

const obsoleteArtifacts = [
  ".shirube/cells/CELL-MCP-SHIRUBE-FULL-ADOPTION-001.yaml",
  ".shirube/evidence/EVIDENCE-MCP-SHIRUBE-FULL-ADOPTION-001.yaml",
  ".shirube/impls/IMPL-MCP-SHIRUBE-FULL-ADOPTION-001.md",
  ".shirube/specs/SPEC-MCP-SHIRUBE-FULL-ADOPTION-001.md",
  ".shirube/rapid-lite/CONTROL-HANDOFF-MCP-805.yaml",
];

requireEqual("target repo", repo, "watchout/agent-comms-mcp");
for (const artifact of requiredArtifacts) requireExisting(artifact);
for (const artifact of obsoleteArtifacts) requireAbsent(artifact);

// Current metadata is distinct from nested historical onboarding. These narrow
// generated scalar checks do not replace the trusted full YAML/runtime gates.
requireCurrentScalars(".shirube/repo-spec.yaml", "", {
  schema_version: "shirube-repo-spec/v1", repo: "watchout/agent-comms-mcp",
});
requireCurrentScalars(".shirube/repo-spec.yaml", "source_of_truth_policy", {
  primary_control_source: "watchout/agent-comms-mcp#940", mirror_is_truth: false,
  llm_final_authority: false, owner_confirmation_required: true,
});
requireText(".shirube/repo-spec.yaml", [".github/workflows/shirube-rapid-lite-gates-report.yml"]);
requireCurrentScalars(".shirube/execution-context.yaml", "", {
  schema_version: "shirube-execution-context/v1", mode: "current_product_audit_preparation",
  canonical_active_function: "implementation_executor",
});
requireCurrentScalars(".shirube/execution-context.yaml", "primary", {
  repo: "watchout/agent-comms-mcp", work_order: "watchout/agent-comms-mcp#940", pr: "watchout/agent-comms-mcp#963",
});
requireCurrentScalars(".shirube/execution-context.yaml", "common_contract", {
  primary_repo_required: true, work_order_required: true, active_role_required: true,
  exact_head_required_for_merge_ready: true, owner_decision_required_for_merge_ready: true,
  llm_final_authority_forbidden: true, support_repo_as_target_forbidden: true, control_repo_as_target_forbidden: true,
});
requireText(".shirube/execution-context.yaml", ["relation: primary", "relation: framework_support", "relation: same_repo_control_source"]);

requireText(".shirube/control-handoffs/CH-001.yaml", [
  "schema_version: shirube-control-handoff/rapid-lite/v1",
  "mode: rapid-lite",
  "profile: hotel-lite",
  "framework_ref: watchout/ai-dev-framework@",
  "CELL-ID: CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001",
  "required_before_merge: true",
  "committed_pending_policy_only: true",
  ".github/workflows/shirube-rapid-lite-gates-report.yml",
]);
requireRegex(".shirube/control-handoffs/CH-001.yaml", /framework_ref: watchout\/ai-dev-framework@[a-f0-9]{40}\b/u, "framework_ref must be pinned to a 40-character ADF SHA.");

requireText(".shirube/enforcement-policy.yaml", [
  "schema_version: shirube-enforcement-policy/v1",
  "mode: report_only",
  "owner_observed: true",
  "enabled: false",
  "unchanged: true",
  "required check activation",
  "runtime/API/DB/package/deploy behavior",
]);

requireCurrentScalars(".shirube/lifecycle-state.yaml", "", {
  schema_version: "shirube-lifecycle-state/rapid-lite/v1", mode: "rapid-lite", profile: "hotel-lite",
  current_phase: "GATE_REVIEW_REQUIRED", observed_gate_state: "BLOCKED_PENDING_CURRENT_AUDIT",
  owner_must_not_merge_until_exact_head_decision: true,
});

const rapidLiteWorkflowPath = ".github/workflows/shirube-rapid-lite-gates-report.yml";
requireText(rapidLiteWorkflowPath, [
  "name: Shirube Rapid/Lite Gates Report",
  "TARGET_DIR: target",
  "RUNTIME_DIR: runtime-source",
  "PUBLIC_RUNTIME_REF: 4ea4b8bc122e22c47323fc8836dc3d7aedd487e9",
  "repository: watchout/agent-comms-mcp",
  "ref: ${{ env.PUBLIC_RUNTIME_REF }}",
  "path: ${{ env.TARGET_DIR }}",
  "path: ${{ env.RUNTIME_DIR }}",
  ".shirube/runtime/rapid-lite/manifest.json",
  "sha256sum --check --strict",
  ".shirube/runtime/rapid-lite/run-rapid-lite-workflow.mjs",
  "shirube-rapid-lite-gates-report/v1",
  "shirube-rapid-lite-gates-${{ github.event.pull_request.number }}",
  'entry.gate === "flow-safety"',
  'gate.status === "ran" && gate.verdict !== "PASS"',
  "Rapid/Lite gates other than flow-safety remain report-only in this slice.",
]);
requireTextCount(rapidLiteWorkflowPath, "repository: watchout/agent-comms-mcp", 1, "Rapid/Lite workflow must checkout the public same-repository runtime exactly once.");
requireTextCount(rapidLiteWorkflowPath, "PUBLIC_RUNTIME_REF: 4ea4b8bc122e22c47323fc8836dc3d7aedd487e9", 1, "Rapid/Lite workflow must declare the exact pinned public runtime ref once.");
requireTextCount(rapidLiteWorkflowPath, ".shirube/runtime/rapid-lite/run-rapid-lite-workflow.mjs", 1, "Rapid/Lite workflow must invoke the repository-local runtime entry exactly once.");
forbidText(rapidLiteWorkflowPath, ["watchout/ai-dev-framework"], "Rapid/Lite workflow must not call or checkout the private ADF repository.");
requirePullRequestTypes(rapidLiteWorkflowPath, [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "edited",
  "labeled",
  "unlabeled",
]);
requirePullRequestTypes(".github/workflows/pr-checks.yml", [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "converted_to_draft",
  "labeled",
  "unlabeled",
  "edited",
]);
requireText(".github/workflows/pr-checks.yml", [
  "Auto-merge (explicit owner-selected squash)",
  "contains(github.event.pull_request.labels.*.name, 'merge-method:squash')",
  "Revalidate live authority and squash checked head",
  '--expected-head "$CHECKED_HEAD"',
  '-f sha="$CHECKED_HEAD"',
  "-f merge_method=squash",
  "--required-merge-method squash",
]);

if (pr) {
  if (expectedHeadSha && headSha !== expectedHeadSha) {
    errors.push(`Live PR head ${headSha || "<empty>"} does not match checked head ${expectedHeadSha}.`);
  }
  requirePrBodyText([
    "CELL-ID:",
    "Risk Tier:",
    "Allowed paths",
    "Protected surfaces",
    "Validation",
  ]);
  if (headSha && pr.draft === true && !body.includes(headSha)) {
    warnings.push(`Draft PR body does not yet include current exact head SHA ${headSha}; required before non-draft/merge handling.`);
  }
  if (headSha && pr.draft !== true && !body.includes(headSha)) {
    errors.push(`PR body must include the current exact head SHA ${headSha}.`);
  }
  if (pr.draft !== true && sourceAdmissionOnly
    && !evaluateStandingAuthorization_fromDisk().applies && !labels.has("shirube-current-overlay")) {
    errors.push("Non-draft PRs require label shirube-current-overlay.");
  }
  if (pr.draft !== true && !sourceAdmissionOnly) {
    const waiver = evaluateStandingAuthorization_fromDisk();
    if (waiver.applies) {
      warnings.push(`Exact-head owner decision waived under ${STANDING_DECISION_ID}: ${waiver.reason}`);
      // The merge method still has to be stated explicitly; the waiver removes the
      // per-head approval, not the requirement to say how the PR merges.
      requireMergeMethodSelection(null);
    } else {
      warnings.push(`Standing authorization does not apply: ${waiver.reason}`);
      if (!labels.has("owner-exact-head-approved")) {
        errors.push("Non-draft PRs require label owner-exact-head-approved.");
      }
      if (!labels.has("shirube-current-overlay")) {
        errors.push("Non-draft PRs require label shirube-current-overlay.");
      }
      const ownerDecision = await requireOwnerDecisionArtifact();
      requireMergeMethodSelection(ownerDecision);
    }
  }
}

// Reads what the gate can see from disk, then defers to the shared decision function so
// that this gate and the conformance report cannot disagree.
function evaluateStandingAuthorization_fromDisk() {
  let config = null;
  if (existsSync(CONFORMANCE_CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFORMANCE_CONFIG_PATH, "utf8"));
    } catch (error) {
      return { applies: false, reason: `${CONFORMANCE_CONFIG_PATH} is unreadable: ${error.message}` };
    }
  }
  return evaluateStandingAuthorization({
    config,
    changedFiles,
    labels,
    body,
    decisionId: STANDING_DECISION_ID,
    decisionUrl: STANDING_DECISION_URL,
  });
}


if (isRapidLiteAdoptionPr) {
  for (const file of changedFiles) {
    if (matchesAny(file, adoptionForbiddenRuntimePatterns)) {
      errors.push(`${file} is a runtime/product protected file; this adoption PR must not change it.`);
    }
  }
}

if (pr && (changedFiles.some((file) => file.startsWith(".github/workflows/")) || body.includes("CELL-AUN-940-NARROW-USE-CORRECTION-20260908-001"))) {
  if (body.includes("CELL-AUN-940-NARROW-USE-CORRECTION-20260908-001")) {
    try { await requireBoundedCiSupply(); }
    catch (error) { errors.push(`Bounded CI supply blocked: ${error.message}`); }
  } else {
  if (!body.includes("CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001")) {
    errors.push("Workflow changes require CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001 in the PR body.");
  }
  if (!body.includes("Risk Tier: R3")) {
    errors.push("Workflow changes require Risk Tier: R3 in the PR body.");
  }
  }
}

// One owner-admitted CI supply, never a generic R4 or merge waiver. The digest
// binds the complete reviewed canonical object, including all 127 admitted integration paths. No remote event budget is inferred.
async function requireBoundedCiSupply() {
  const target="watchout/agent-comms-mcp", cell="CELL-AUN-940-NARROW-USE-CORRECTION-20260908-001";
  const base="0f772883db6f3b50772d3e4b82ce47795091f0a9", origin="565583c25963b7dfa9b4445543967d372091b336";
  const odUrl=`https://github.com/${target}/issues/940#issuecomment-5609700544`;
  const currentC16="ef5a34853b56b8ce788a5403a0f8cabb34fc5476";
  const odHash="59952776f1cfb5093040cb9318641f54721ef4f0f416ee278d1e426e980aef02";
  // Immutable I22/I23/I24/I25/A2 historical validity; never the I26 effective cap.
  const expiry="2026-09-18T09:00:00Z", now=Date.now();
  const effectiveExpiry="2026-09-18T13:15:00Z";
  const windowPredecessor="fa94d6727c453f44b6d0a8949dc09fc2914c5d05";
  const historicalExpiry="2026-09-17T09:00:00Z";
  const historicalC17="9a48756fee1d21c047bbda02666c4fa8bbce6b13";
  const reviewedCiHead="eac39beb49da9b00a1bc9bf0cf988006b08caad1";
  const check=(condition,detail)=>{if(!condition)throw Error(detail)};
  const hash=value=>createHash("sha256").update(value).digest("hex");
  const sha40=value=>typeof value==="string"&&/^[0-9a-f]{40}$/.test(value);
  const sha64=value=>typeof value==="string"&&/^[0-9a-f]{64}$/.test(value);
  const metadata=key=>{
    const lines=body.split(/\r?\n/).filter(line=>line.trimStart().startsWith(`${key}:`));
    check(lines.length===1&&lines[0].startsWith(`${key}:`),`unique anchored ${key} required`);
    return lines[0].slice(key.length+1).trim();
  };
  check(repo===target&&prNumber===963,"repo/PR mismatch");
  check(metadata("CELL-ID")===cell&&metadata("Risk Tier")==="R4","cell/risk mismatch");
  check(!body.includes("CELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001"),"adoption-cell contamination");
  check(metadata("Workflow Supply")==="CI_TEST_SUPPLY_ONLY","wrong workflow scope");
  check(changedFilesPath&&existsSync(changedFilesPath)&&changedFiles.length>0,"changed-files input required");
  check(sha40(headSha)&&pr.base?.sha===base&&now<Date.parse(effectiveExpiry),"head/base/expiry mismatch");
  const ref=metadata("ci_supply_handoff_comment_ref"), digest=metadata("ci_supply_handoff_body_sha256");
  check(/^https:\/\/github\.com\/watchout\/agent-comms-mcp\/issues\/940#issuecomment-[1-9][0-9]*$/.test(ref)&&sha64(digest),"handoff pin invalid");
  check(ref===`https://github.com/${target}/issues/940#issuecomment-5713693956`
    &&digest==="eb8bd44526c94bdb7c8158ed23d48d087ce0e41d3907dc92131031cc715beed8","exact published I required");
  const fixturePath=stringArg(args["control-comments"]);
  const fixture=fixturePath?readJsonIfPresent(fixturePath):null;
  if(fixturePath)check(Array.isArray(fixture),"control-comments must be API-shaped array");
  const load=async(url,expectedHash)=>{
    const id=Number(url.split("issuecomment-")[1]);
    const matches=fixture?.filter(comment=>comment?.id===id);
    if(matches)check(matches.length===1,"control comment missing/duplicate");
    const comment=matches?matches[0]:(await boundedGithubGet(`https://api.github.com/repos/${target}/issues/comments/${id}`)).value;
    check(comment?.id===id&&comment.html_url===url&&comment.issue_url===`https://api.github.com/repos/${target}/issues/940`
      &&comment.user?.login==="watchout"&&comment.author_association==="OWNER","control comment authenticated identity mismatch");
    check(typeof comment.body==="string"&&hash(comment.body)===expectedHash,"control raw body digest mismatch");
    return comment.body;
  };
  requireCiOwnerDecision(await load(odUrl,odHash),"OD-CTO-APPROVAL-NORMALIZATION-20260910-001",true);
  const canonicalPath=".shirube/control-handoffs/CH-AUN-940-NARROW-USE-CORRECTION-20260917.yaml";
  const amendmentPaths=["docs/design/aun-bounded-admission.md","scripts/shirube-current-overlay-check.mjs",
    "tests/shirube-current-overlay-check.test.ts","docs/shirube/README.md",canonicalPath].sort();
  const windowRef=metadata("ci_supply_window_amendment_ref"), windowDigest=metadata("ci_supply_window_amendment_sha256");
  check(windowRef===`https://github.com/${target}/issues/940#issuecomment-5726524883`
    &&windowDigest==="2977acc9b8ad46867a11eb1f52748ad1570764d2ae76ce3477d236f464915c12","exact published I26 required");
  const windowBody=await load(windowRef,windowDigest);
  const windowMarker="<!-- shirube-v3:control-handoff:CH-CTO-AUN-C23-FINITE-WINDOW-20260918-I26 -->";
  check(windowBody.split(windowMarker).length===2
    &&[...windowBody.matchAll(/<!--\s*shirube-v3:control-handoff[^>]*-->/g)].length===1,"one I26 marker required");
  const windowBlocks=[...windowBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(windowBlocks.length===1,"one I26 JSON block required");
  const window=JSON.parse(windowBlocks[0][1]);
  check(window.schema_version==="shirube-v3/control_handoff/v1"
    &&window.handoff_id==="CH-CTO-AUN-C23-FINITE-WINDOW-20260918-I26"
    &&window.control_source===`${target}#940`&&window.cell_id===cell
    &&window.authority_ref.url===odUrl&&window.authority_ref.sha256===odHash
    &&window.source_predecessor===windowPredecessor&&window.source_base===base
    &&window.executor==="/root/ci_sequence_plan_gate"&&window.active_function==="implementation_executor"
    &&window.allowed_paths.length===6
    &&JSON.stringify(window.allowed_paths.slice(0,5).sort())===JSON.stringify(amendmentPaths)
    &&window.allowed_paths[5]==="/Users/yuji/Developer/codex/control-artifacts/github-work-review-20260918/work-instruction-5726145495/source-window-correction/**"
    &&window.source_effective_amendment.historical_I25_expiry===expiry
    &&window.source_effective_amendment.effective_source_expires_at===effectiveExpiry
    &&window.source_effective_amendment.applies_to==="Only successor of exactfa94, same repo/PR963/cell/base and existing135path scope with this exact5path delta. CI source/consumer applicability only, never owner/runtime authority."
    &&window.source_effective_amendment.historical_refs_and_expiries_immutable===true
    &&window.source_effective_amendment.owner_approval_granted===false
    &&window.source_effective_amendment.current_head_and_quality_unverified===true
    &&window.bounds.seconds===1500&&window.bounds.focused_test_processes===2
    &&window.bounds.type_check_processes===1&&window.bounds.local_commits===1
    &&window.bounds.public_effects===0&&window.bounds.runtime_effects===0
    &&Date.parse(window.bounds.started_at)<=now,"I26 authenticated scope/bounds mismatch");
  const roleRef=`https://github.com/${target}/issues/940#issuecomment-5726556100`;
  const roleDigest="20b3f667f32ae28f8d66acfeb6743583f7e38b6ebe2a17a12c777fec8fce803a";
  const roleBody=await load(roleRef,roleDigest);
  const roleBlocks=[...roleBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(roleBlocks.length===1,"one I26-A1 role JSON block required");
  const roles=JSON.parse(roleBlocks[0][1]), consumerRoles=roles.current_source_consumer;
  check(roles.schema_version==="shirube-control-handoff-amendment/v1"
    &&roles.amendment_id==="CH-CTO-AUN-C23-FINITE-WINDOW-20260918-I26-A1"
    &&roles.control_source===`${target}#940`&&roles.cell_id===cell
    &&roles.I26_ref.url===windowRef&&roles.I26_ref.sha256===windowDigest
    &&roles.authority_ref.url===odUrl&&roles.authority_ref.sha256===odHash
    &&consumerRoles.maker_executor===window.executor&&consumerRoles.maker_agent==="codex-cto/ci_sequence_plan_gate"
    &&consumerRoles.maker_function==="implementation_executor"
    &&consumerRoles.checker_executor==="/root/recovery_path_author"&&consumerRoles.checker_agent==="codex-cto/recovery_path_author"
    &&consumerRoles.checker_function==="evidence_audit_gate"&&consumerRoles.publisher==="watchout"
    &&consumerRoles.checker_agent!==consumerRoles.maker_agent&&consumerRoles.verdict_now==="NOT_ISSUED"
    &&consumerRoles.source_implementation_acceptance_required===true
    &&roles.effective_source_expires_at===effectiveExpiry&&roles.bounds_change===false
    &&roles.historical_identity_checks_unchanged===true,"I26 current independent role binding mismatch");
  const projectionRef=`https://github.com/${target}/issues/940#issuecomment-5726585940`;
  const projectionDigest="05b111c3a5f4929401d177695187890c8431f916879b97d1892b3681e457dd85";
  const projectionBody=await load(projectionRef,projectionDigest);
  const projectionBlocks=[...projectionBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(projectionBlocks.length===1,"one I26-A2 JSON block required");
  const projection=JSON.parse(projectionBlocks[0][1]);
  const windowSupportPaths=[".shirube/execution-context.yaml",".shirube/repo-spec.yaml"].sort();
  const windowPaths=[...amendmentPaths,...windowSupportPaths].sort();
  check(projection.schema_version==="shirube-control-handoff-amendment/v1"
    &&projection.amendment_id==="CH-CTO-AUN-C23-FINITE-WINDOW-20260918-I26-A2"
    &&projection.control_source===`${target}#940`&&projection.cell_id===cell
    &&projection.authority_ref.url===odUrl&&projection.authority_ref.sha256===odHash
    &&projection.I26_ref.url===windowRef&&projection.I26_ref.sha256===windowDigest
    &&projection.A1_ref.url===roleRef&&projection.A1_ref.sha256===roleDigest
    &&projection.source_predecessor===windowPredecessor
    &&JSON.stringify([...projection.additional_paths].sort())===JSON.stringify(windowSupportPaths)
    &&JSON.stringify([...projection.current_delta_allowed_paths].sort())===JSON.stringify(windowPaths)
    &&projection.cumulative_scope.actual_total_paths===135
    &&projection.cumulative_scope.current_successor_delta_paths===7
    &&projection.cumulative_scope.unchanged_original_runtime_product_paths===true
    &&projection.maker.executor===window.executor&&projection.maker.function==="implementation_executor"
    &&projection.checker.executor===consumerRoles.checker_executor&&projection.checker.function==="evidence_audit_gate"
    &&projection.effective_source_expires_at===effectiveExpiry&&projection.bounds_change===false,
    "I26-A2 current projection scope mismatch");
  requireCurrentScalars(".shirube/execution-context.yaml","",{implementation_actor:consumerRoles.maker_agent});
  requireCurrentScalars(".shirube/execution-context.yaml","current_source_amendment_ref",{url:windowRef,sha256:windowDigest});
  requireCurrentScalars(".shirube/execution-context.yaml","current_source_checker_ref",{url:roleRef,sha256:roleDigest});
  const amendmentBody=await load(`https://github.com/${target}/issues/940#issuecomment-5713769510`,
    "7ff80f50c1d9958c951f6312bc11a6896a699448f20af0656ed9ea12fba715be");
  const amendmentBlocks=[...amendmentBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(amendmentBlocks.length===1,"one I25-A1 amendment JSON block required");
  const amendment=JSON.parse(amendmentBlocks[0][1]);
  check(amendment.schema_version==="shirube-control-handoff-amendment/v1"
    &&amendment.amendment_id==="CH-CTO-AUN-POC-INTEGRATION-20260917-I25-A1"
    &&amendment.control_source===`${target}#940`&&amendment.cell_id===cell
    &&amendment.original_handoff_ref.url===ref&&amendment.original_handoff_ref.sha256===digest
    &&amendment.source_predecessor==="cf06d07480d6300683a11e5064530e96f16d280d"
    &&amendment.authority_refs.length===2&&amendment.authority_refs[0].url===odUrl&&amendment.authority_refs[0].sha256===odHash
    &&amendment.authority_refs[1].url===`https://github.com/${target}/issues/940#issuecomment-5576498516`
    &&amendment.authority_refs[1].sha256==="a3d16ddcb8fd872cade9f971f337ede6f3cf85a23fec621492be916438978ff1"
    &&amendment.execution_context.maker==="codex-cto/ci_sequence_fix"
    &&amendment.execution_context.canonical_author==="codex-cto/recovery_path_author"
    &&amendment.execution_context.checker==="codex-cto/ci_sequence_plan_gate"
    &&amendment.execution_context.controller==="codex-cto"&&amendment.execution_context.maker_history_retained===true
    &&amendment.cumulative_scope.historical_paths===127&&amendment.cumulative_scope.additional_exact_path===canonicalPath
    &&amendment.cumulative_scope.new_total_changed_paths===128&&amendment.cumulative_scope.readme_already_within127===true
    &&amendment.cumulative_scope.all_existing_product_runtime_paths_unchanged===true
    &&JSON.stringify([...amendment.implementation_paths].sort())===JSON.stringify(amendmentPaths),"I25-A1 authenticated scope mismatch");
  const supportPaths=[".shirube/execution-context.yaml",".shirube/adoption-intake.yaml",
    ".shirube/existing-state-scan.yaml",".shirube/lifecycle-state.yaml",".shirube/repo-spec.yaml",
    ".shirube/source-mirrors/control-issue.yaml",".shirube/spec-reconciliation-plan.yaml"].sort();
  const currentImplementationPaths=[...amendmentPaths,...supportPaths].sort();
  const finalAmendmentBody=await load(`https://github.com/${target}/issues/940#issuecomment-5713927431`,
    "2a46980a2a0781eb7e5adc5a159389d33c7ce928aa9e1e527bf620932e2f0af4");
  const finalAmendmentBlocks=[...finalAmendmentBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(finalAmendmentBlocks.length===1,"one I25-A2 amendment JSON block required");
  const finalAmendment=JSON.parse(finalAmendmentBlocks[0][1]);
  check(finalAmendment.schema_version==="shirube-control-handoff-amendment/v1"
    &&finalAmendment.amendment_id==="CH-CTO-AUN-POC-INTEGRATION-20260917-I25-A2"
    &&finalAmendment.control_source===`${target}#940`&&finalAmendment.cell_id===cell
    &&finalAmendment.authority_ref.url===odUrl&&finalAmendment.authority_ref.sha256===odHash
    &&finalAmendment.I25_ref.url===ref&&finalAmendment.I25_ref.sha256===digest
    &&finalAmendment.A1_ref.url===`https://github.com/${target}/issues/940#issuecomment-5713769510`
    &&finalAmendment.A1_ref.sha256===hash(amendmentBody)
    &&finalAmendment.source_predecessor===amendment.source_predecessor
    &&JSON.stringify([...finalAmendment.implementation_paths].sort())===JSON.stringify(currentImplementationPaths)
    &&JSON.stringify([...finalAmendment.support_metadata_paths].sort())===JSON.stringify(supportPaths)
    &&JSON.stringify([...finalAmendment.cumulative_scope.support_paths].sort())===JSON.stringify(supportPaths)
    &&finalAmendment.cumulative_scope.original_history_paths===127
    &&finalAmendment.cumulative_scope.canonical_metadata_path===canonicalPath
    &&finalAmendment.cumulative_scope.actual_total_paths===135&&finalAmendment.cumulative_scope.implementation_total_paths===12
    &&finalAmendment.cumulative_scope.all_actual_diff_paths_must_be_counted===true
    &&finalAmendment.cumulative_scope.existing_product_runtime_paths_unchanged===true
    &&finalAmendment.maker.executor==="/root/ci_sequence_fix"&&finalAmendment.maker.function==="implementation_executor"
    &&finalAmendment.maker.bounds.original_start==="2026-09-17T11:37:30Z"
    &&finalAmendment.maker.bounds.prior_active_limit_minutes===35&&finalAmendment.maker.bounds.additional_active_minutes===25
    &&finalAmendment.maker.bounds.total_active_limit_minutes===60&&finalAmendment.maker.bounds.prior_wall_limit_minutes===50
    &&finalAmendment.maker.bounds.additional_wall_minutes===25&&finalAmendment.maker.bounds.total_wall_limit_minutes===75
    &&finalAmendment.maker.bounds.execution_expires_at==="2026-09-17T22:00:00+09:00"
    &&Date.parse(finalAmendment.maker.bounds.source_expires_at)===Date.parse(expiry)
    &&finalAmendment.author.executor==="/root/recovery_path_author"&&finalAmendment.author.function==="control_artifact_author"
    &&finalAmendment.checker.executor==="/root/ci_sequence_plan_gate"&&finalAmendment.checker.function==="evidence_audit_gate",
    "I25-A2 authenticated scope/resource mismatch");
  // I20 remains authenticated history, with its exact metadata-only delta.
  const historicalI20Body=await load(`https://github.com/${target}/issues/940#issuecomment-5688909231`,
    "3b0d39b5c7a96201220154adc5a16b4f24b86e8831348b8bbf41aeacf001bbaa");
  check(historicalI20Body.includes("CH-CTO-AUN-POC-INTEGRATION-20260916-I20"),"historical I20 mismatch");
  // I21 is immutable historical admission for C17, not authority for this successor.
  const handoffBody=await load(`https://github.com/${target}/issues/940#issuecomment-5694821959`,
    "10cb824bb9bdca062a73a0c3ed56131b197b57209f9b0223f6a3c0136d3dfe03");
  const marker="<!-- shirube-v3:control-handoff:CH-CTO-AUN-POC-INTEGRATION-20260916-I21 -->";
  check(handoffBody.split(marker).length===2&&[...handoffBody.matchAll(/<!--\s*shirube-v3:control-handoff[^>]*-->/g)].length===1,"canonical marker must occur once");
  const blocks=[...handoffBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(blocks.length===1,"one current handoff JSON block required");
  const handoff=JSON.parse(blocks[0][1]);
  check(handoff.schema_version==="shirube-control-handoff/v1"
    &&handoff.handoff_id==="CH-CTO-AUN-POC-INTEGRATION-20260916-I21"
    &&handoff.subject.repository===target&&handoff.subject.pr===963
    &&handoff.subject.current_public_head===currentC16&&handoff.subject.base===base
    &&handoff.subject.c2==="8d38f3bd6a99a2f4615949dd747d708f8b6943d6"
    &&handoff.subject.seat_continuity==="81be7f051f85973bb9533e87d3258825082ad158"
    &&handoff.subject.was_companion==="e49abc24838227776dc01be111aeb035ec7c9aad"
    &&Date.parse(handoff.bounds.expires_at)===Date.parse(historicalExpiry)
    &&handoff.bounds.new_candidates===1&&handoff.bounds.cumulative_candidate_limit===17
    &&handoff.bounds.new_full_suite_runs===1&&handoff.bounds.cumulative_full_suite_limit===19
    &&handoff.bounds.new_private2_runs===1&&handoff.bounds.focused_performance_runs_max===2
    &&handoff.bounds.focused_metadata_runs_max===1
    &&handoff.bounds.correction_rounds===0&&handoff.bounds.two_callers_original_limit===20
    &&handoff.bounds.two_callers_historical_local_consumed===33&&handoff.bounds.two_callers_consumed===33
    &&handoff.bounds.active_minutes===20&&handoff.bounds.execution_expires_at==="2026-09-16T18:20:00+09:00"
    &&handoff.bounds.local_completion_target==="2026-09-16T18:15:00+09:00"
    &&handoff.bounds.owned_fixture_setup_completion===1
    &&handoff.bounds.two_callers_additional_local_specimens_remaining_max===3&&handoff.bounds.two_callers_cumulative_limit===36
    &&handoff.subject.current_local_head==="ef5a34853b56b8ce788a5403a0f8cabb34fc5476"
    &&handoff.subject.current_local_tree==="7fd5f1dcca2766b7deaa8b599328941217145794"
    &&handoff.execution_context.active_function==="implementation_executor"
    &&handoff.execution_context.actor_agent_id==="codex-cto/application_review"
    &&handoff.execution_context.checker==="/root/goal_gap"
    &&handoff.authority_refs.length===1&&handoff.authority_refs[0].url===odUrl
    &&handoff.authority_refs[0].sha256===odHash
    &&handoff.allowed_paths.length===127&&new Set(handoff.allowed_paths).size===127,"current integration supply mismatch");
  const historicalA1Paths=[...handoff.allowed_paths,canonicalPath].sort();
  check(historicalA1Paths.length===128&&new Set(historicalA1Paths).size===128,"I25-A1 cumulative path set mismatch");
  const admittedPaths=[...historicalA1Paths,...supportPaths].sort();
  check(admittedPaths.length===135&&new Set(admittedPaths).size===135,"I25-A2 cumulative path set mismatch");
  check(changedFiles.every(file=>admittedPaths.includes(file))
    &&changedFiles.filter(file=>file.startsWith(".github/workflows/")).every(file=>file===".github/workflows/pr-checks.yml"),"candidate path outside supply");
  const git=(...argv)=>execFileSync("git",argv,{encoding:"utf8",timeout:15000,maxBuffer:16*1024*1024}).trim();
  // Authenticate the immutable I26 history separately from this explicit repair.
  const repairPredecessor="d982dc2c0284a633b2b1f82d6780b3f77b8e0dd1";
  check(git("rev-list","--parents","-n","1",repairPredecessor)===`${repairPredecessor} ${windowPredecessor}`
    &&git("rev-parse",`${repairPredecessor}^{tree}`)==="d759272b9f94b81b55654c63c4cad328d6659605",
    "I26 historical predecessor/tree mismatch");
  check(JSON.stringify(git("diff","--no-renames","--name-only",`${windowPredecessor}...${repairPredecessor}`)
    .split("\n").filter(Boolean).sort())===JSON.stringify(windowPaths),"I26-A2 historical seven-path delta required");
  let currentConsumerRef=windowRef,currentConsumerDigest=windowDigest;
  if(headSha!==repairPredecessor){
    check(git("rev-list","--parents","-n","1",headSha)===`${headSha} ${repairPredecessor}`,
      "I26 exact predecessor required; I26-A3 requires direct d982 child");
    const correctionRef=metadata("ci_supply_correction_amendment_ref"),correctionDigest=metadata("ci_supply_correction_amendment_sha256");
    check(correctionRef===`https://github.com/${target}/issues/940#issuecomment-5727595761`
      &&correctionDigest==="52d917d96e51c72bd043bfa18e9de25ef43f9e7e40c0467775561532d183e0c2","exact published I26-A3 required");
    const correctionBody=await load(correctionRef,correctionDigest);
    const marker="<!-- shirube-v3:control-handoff-amendment:CH-CTO-AUN-C23-CI-SUBJECT-CORRECTION-20260918-I26-A3 -->";
    check(correctionBody.split(marker).length===2
      &&[...correctionBody.matchAll(/<!--\s*shirube-v3:control-handoff[^>]*-->/g)].length===1,"one I26-A3 marker required");
    const blocks=[...correctionBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
    check(blocks.length===1,"one I26-A3 JSON block required");
    const correction=JSON.parse(blocks[0][1]);
    const correctionPaths=["scripts/shirube-current-overlay-check.mjs","tests/shirube-current-overlay-check.test.ts",
      "docs/design/aun-bounded-admission.md","docs/shirube/README.md"].sort();
    check(correction.schema_version==="shirube-control-handoff-amendment/v1"
      &&correction.amendment_id==="CH-CTO-AUN-C23-CI-SUBJECT-CORRECTION-20260918-I26-A3"
      &&correction.control_source===`${target}#940`
      &&correction.authority_ref.url===odUrl&&correction.authority_ref.sha256===odHash
      &&correction.I26_ref.url===windowRef&&correction.I26_ref.sha256===windowDigest
      &&correction.I26_A1_ref.url===roleRef&&correction.I26_A1_ref.sha256===roleDigest
      &&correction.I26_A2_ref.url===projectionRef&&correction.I26_A2_ref.sha256===projectionDigest
      &&correction.subject.repo===target&&correction.subject.pr===963&&correction.subject.cell_id===cell
      &&correction.subject.base===base&&correction.subject.repair_predecessor===repairPredecessor
      &&correction.subject.repair_predecessor_tree==="d759272b9f94b81b55654c63c4cad328d6659605"
      &&correction.subject.original_I26_predecessor===windowPredecessor
      &&correction.executor===window.executor&&correction.checker===consumerRoles.checker_executor
      &&correction.active_function==="implementation_executor"
      &&JSON.stringify([...correction.allowed_paths].sort())===JSON.stringify(correctionPaths)
      &&correction.cumulative_allowed_paths===135&&correction.original_fa94_to_d982_paths===7
      &&correction.effective_source_expires_at===effectiveExpiry
      &&correction.historical_refs_expiries_and_consumed_attempts_preserved===true
      &&correction.owner_runtime_authority_granted===false
      &&correction.issued_not_before==="2026-09-18T08:50:50.099777+00:00"&&Date.parse(correction.issued_not_before)<=now
      &&JSON.stringify(correction.bounds)===JSON.stringify({"seconds_from_actual_start":2100,"focused_direct_processes":1,"focused_merge_shape_processes":1,"changed_input_focused_retry":1,"full_suite_processes":1,"private_contract_processes":1,"local_commits":1,"unpublished_test_or_fixture_correction_amend":1,"owned_merge_shape_fixture":1,"public_effects":0,"shared_runtime_effects":0,"new_agents":0}),"I26-A3 authenticated scope/bounds mismatch");
    check(JSON.stringify(git("diff","--no-renames","--name-only",`${repairPredecessor}...${headSha}`)
      .split("\n").filter(Boolean).sort())===JSON.stringify(correctionPaths),"I26-A3 exact four-path delta required");
    const correctionRows=git("diff","--raw","--no-abbrev","--no-renames",`${repairPredecessor}...${headSha}`).split("\n");
    check(correctionRows.length===4&&correctionRows.every(isRegularFileModification),"I26-A3 four regular-file modifications required");
    currentConsumerRef=correctionRef;currentConsumerDigest=correctionDigest;
  }
  check(JSON.stringify(git("diff","--no-renames","--name-only",`${windowPredecessor}...${headSha}`)
    .split("\n").filter(Boolean).sort())===JSON.stringify(windowPaths),"I26-A2 cumulative seven-path delta required");
  const historicalC15="2730cb38e87eee4ca31cc15d496ef49effc25a2d";
  const historicalMetadata=["docs/design/aun-bounded-admission.md","scripts/shirube-current-overlay-check.mjs","tests/shirube-current-overlay-check.test.ts"];
  git("merge-base","--is-ancestor",historicalC15,currentC16);
  check(git("rev-parse",`${currentC16}^{tree}`)==="7fd5f1dcca2766b7deaa8b599328941217145794"
    &&JSON.stringify(git("diff","--no-renames","--name-only",`${historicalC15}...${currentC16}`).split("\n").filter(Boolean).sort())===JSON.stringify(historicalMetadata.sort()),"historical I20 metadata delta mismatch");
  git("merge-base","--is-ancestor",origin,currentC16);
  git("merge-base","--is-ancestor",currentC16,headSha);
  git("merge-base","--is-ancestor",handoff.subject.c2,headSha);
  git("merge-base","--is-ancestor",handoff.subject.seat_continuity,headSha);
  git("merge-base","--is-ancestor",handoff.subject.current_local_head,headSha);
  const repairs=["docs/design/aun-bounded-admission.md","scripts/shirube-current-overlay-check.mjs",
    "tests/shirube-current-overlay-check.test.ts","tests/contract/test_queue_bounded_admission.test.ts",
    "tests/contract/test_queue_bounded_admission_postgres.test.ts","tests/contract/test_queue_bounded_retry.test.ts",
    "tests/contract/test_queue_bounded_use_trace.test.ts","tests/eventlog/eventlog-bot-to-bot-roundtrip.test.ts"];
  const implementationPaths=["tests/contract/test_queue_bounded_retry.test.ts","docs/design/aun-bounded-admission.md","scripts/shirube-current-overlay-check.mjs","tests/shirube-current-overlay-check.test.ts"];
  check(JSON.stringify([...handoff.repair_paths].sort())===JSON.stringify(repairs.sort())
    &&JSON.stringify([...handoff.implementation_paths].sort())===JSON.stringify(implementationPaths.sort())
    &&handoff.subject.entry_full_index_diff_sha256==="aba59ab64e7f117155ea570b01abe1a78712e74a0bbdc1453535aa2028fde807"
    &&git("diff","--no-renames","--name-only",`${handoff.subject.current_local_head}...${historicalC17}`).split("\n").filter(Boolean)
      .every(file=>implementationPaths.includes(file)),"historical C17 repair outside I21 scope");
  git("merge-base","--is-ancestor",currentC16,historicalC17);
  git("merge-base","--is-ancestor",historicalC17,reviewedCiHead);
  git("merge-base","--is-ancestor",reviewedCiHead,headSha);
  check(git("rev-parse",`${historicalC17}^{tree}`)==="d5679c1675d324e04f23b0e0b60a216e0f158219",
    "historical C17 tree mismatch");
  const supplyBody=await load(`https://github.com/${target}/issues/940#issuecomment-5711335296`,
    "3e58b9990c5bf73f4c12f01b8e84e685deb01c6ecf763e11677e4438d973db6d");
  const supplyMarker="<!-- shirube-v3:control-handoff:CH-CTO-AUN-POC-INTEGRATION-20260917-I22 -->";
  check(supplyBody.split(supplyMarker).length===2&&[...supplyBody.matchAll(/<!--\s*shirube-v3:control-handoff[^>]*-->/g)].length===1,
    "current I22 marker must occur once");
  const supplyBlocks=[...supplyBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(supplyBlocks.length===1,"one current I22 JSON block required");
  const supply=JSON.parse(supplyBlocks[0][1]);
  const currentMetadata=[...historicalMetadata].sort();
  const reviewedPaths=[...historicalMetadata,".github/workflows/pr-checks.yml"].sort();
  check(supply.schema_version==="shirube-control-handoff/v1"
    &&supply.handoff_id==="CH-CTO-AUN-POC-INTEGRATION-20260917-I22"
    &&supply.control_source===`${target}#940`
    &&supply.subject.repository===target&&supply.subject.pr===963
    &&supply.subject.base===base&&supply.subject.current_public_head===currentC16
    &&supply.subject.c2===handoff.subject.c2&&supply.subject.seat_continuity===handoff.subject.seat_continuity
    &&supply.subject.was_companion===handoff.subject.was_companion
    &&supply.subject.current_local_head===reviewedCiHead
    &&supply.subject.current_local_tree==="dfcde6d4177c2ec41a96225f13b8725121f7fa07"
    &&supply.subject.entry_full_index_diff_sha256==="69fc999b8007c62291ebf29ded21ebb01472650e4153ee4bf02f51b3fe464fa6"
    &&supply.subject.historical_C17_head===historicalC17
    &&supply.subject.historical_C17_tree==="d5679c1675d324e04f23b0e0b60a216e0f158219"
    &&supply.subject.ci_sequence_delta_sha256==="177c0e7c64abea30b474c1876cd56945ea43b6e58385d86378a1fe74a42ab450"
    &&supply.execution_context.active_function==="implementation_executor"
    &&supply.execution_context.actor_agent_id==="codex-cto/ci_sequence_fix"
    &&supply.execution_context.checker==="/root/ci_sequence_plan_gate"
    &&supply.authority_refs.length===1&&supply.authority_refs[0].url===odUrl&&supply.authority_refs[0].sha256===odHash
    &&supply.historical_I21_ref.url===`https://github.com/${target}/issues/940#issuecomment-5694821959`
    &&supply.historical_I21_ref.sha256==="10cb824bb9bdca062a73a0c3ed56131b197b57209f9b0223f6a3c0136d3dfe03"
    &&Date.parse(supply.bounds.expires_at)===Date.parse(expiry)
    &&supply.bounds.execution_expires_at==="2026-09-17T19:00:00+09:00"
    &&supply.bounds.active_minutes===20&&supply.bounds.new_candidates===1&&supply.bounds.cumulative_candidate_limit===20
    &&supply.bounds.new_full_suite_runs===0&&supply.bounds.cumulative_full_suite_limit===19
    &&supply.bounds.new_private2_runs===1&&supply.bounds.focused_metadata_runs_max===2&&supply.bounds.correction_rounds===1
    &&supply.bounds.publicCIstarts===0&&supply.bounds.pushes===0&&supply.bounds.protected_effects===0
    &&JSON.stringify([...supply.allowed_paths].sort())===JSON.stringify([...handoff.allowed_paths].sort())
    &&JSON.stringify([...supply.repair_paths].sort())===JSON.stringify([...repairs].sort())
    &&JSON.stringify([...supply.implementation_paths].sort())===JSON.stringify(currentMetadata)
    &&JSON.stringify([...supply.validated_ci_sequence_paths].sort())===JSON.stringify(reviewedPaths),"current I22 supply mismatch");
  const binaryHash=(from,to)=>hash(execFileSync("git",["diff","--binary","--full-index",`${from}...${to}`],{timeout:15000,maxBuffer:16*1024*1024}));
  check(git("rev-parse",`${reviewedCiHead}^{tree}`)===supply.subject.current_local_tree
    &&binaryHash(base,reviewedCiHead)===supply.subject.entry_full_index_diff_sha256
    &&binaryHash(historicalC17,reviewedCiHead)===supply.subject.ci_sequence_delta_sha256
    &&JSON.stringify(git("diff","--no-renames","--name-only",`${historicalC17}...${reviewedCiHead}`).split("\n").filter(Boolean).sort())===JSON.stringify(reviewedPaths),
    "reviewed CI sequence delta mismatch");
  const historicalI22Head="a39efd0261b1bc06f4744c8825e5d597b339a6bb";
  git("merge-base","--is-ancestor",reviewedCiHead,historicalI22Head);
  git("merge-base","--is-ancestor",historicalI22Head,headSha);
  check(git("rev-parse",`${historicalI22Head}^{tree}`)==="e6cdf688488d93659bc5e69370c2d5097b58a00d"
    &&binaryHash(reviewedCiHead,historicalI22Head)==="f189561e32f0c200eb2ce35374b92417b7846f962f19d6f27b8ba974de5c26d8"
    &&JSON.stringify(git("diff","--no-renames","--name-only",`${reviewedCiHead}...${historicalI22Head}`).split("\n").filter(Boolean).sort())===JSON.stringify(currentMetadata),
    "historical I22 metadata delta mismatch");
  let historicalI23Body;
  {
  const currentBody=await load(`https://github.com/${target}/issues/940#issuecomment-5712041088`,"360a44222c9299b9178d2b2f9f8682b3f0fa32ea5abb8f3d1ea050f22d253c41");
  const currentMarker="<!-- shirube-v3:control-handoff:CH-CTO-AUN-POC-INTEGRATION-20260917-I23 -->";
  check(currentBody.split(currentMarker).length===2&&[...currentBody.matchAll(/<!--\s*shirube-v3:control-handoff[^>]*-->/g)].length===1,
    "current I23 marker must occur once");
  const currentBlocks=[...currentBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(currentBlocks.length===1,"one current I23 JSON block required");
  const current=JSON.parse(currentBlocks[0][1]);
  const fixturePaths=["tests/helpers/seat-native-runtime-fixture.ts","tests/seat-runtime-continuity.test.ts"];
  const currentPaths=[...currentMetadata,...fixturePaths].sort();
  check(current.schema_version==="shirube-control-handoff/v1"
    &&current.handoff_id==="CH-CTO-AUN-POC-INTEGRATION-20260917-I23"
    &&current.control_source===`${target}#940`
    &&current.subject.repository===target&&current.subject.pr===963&&current.subject.base===base
    &&current.subject.current_public_head===historicalI22Head&&current.subject.current_local_head===historicalI22Head
    &&current.subject.current_local_tree===git("rev-parse",`${historicalI22Head}^{tree}`)
    &&current.subject.entry_full_index_diff_sha256===binaryHash(base,historicalI22Head)
    &&current.subject.c2===handoff.subject.c2&&current.subject.seat_continuity===handoff.subject.seat_continuity
    &&current.subject.was_companion===handoff.subject.was_companion
    &&current.subject.historical_C17_head===historicalC17&&current.subject.reviewed_ci_head===reviewedCiHead
    &&current.subject.historical_C17_tree===supply.subject.historical_C17_tree
    &&current.subject.ci_sequence_delta_sha256===supply.subject.ci_sequence_delta_sha256
    &&current.subject.historical_I22_metadata_delta_sha256===binaryHash(reviewedCiHead,historicalI22Head)
    &&current.execution_context.active_function==="implementation_executor"
    &&current.execution_context.actor_agent_id==="codex-cto/ci_sequence_fix"
    &&current.execution_context.checker==="/root/ci_sequence_plan_gate"
    &&current.authority_refs.length===1&&current.authority_refs[0].url===odUrl&&current.authority_refs[0].sha256===odHash
    &&current.historical_I22_ref.url===`https://github.com/${target}/issues/940#issuecomment-5711335296`
    &&current.historical_I22_ref.sha256===hash(supplyBody)
    &&current.historical_I21_ref.url===supply.historical_I21_ref.url&&current.historical_I21_ref.sha256===hash(handoffBody)
    &&Date.parse(current.bounds.expires_at)===Date.parse(expiry)
    &&current.bounds.execution_expires_at==="2026-09-17T20:00:00+09:00"
    &&current.bounds.active_minutes===35&&current.bounds.wall_minutes===50
    &&current.bounds.new_candidates===1&&current.bounds.cumulative_candidate_limit===21
    &&current.bounds.new_full_suite_runs===1&&current.bounds.cumulative_full_suite_limit===21
    &&current.bounds.new_private2_runs===1&&current.bounds.focused_metadata_runs_max===2
    &&current.bounds.diagnostic_probe_invocations_max===2&&current.bounds.correction_rounds===0
    &&current.bounds.publicCIstarts===0&&current.bounds.pushes===0&&current.bounds.protected_effects===0
    &&JSON.stringify([...current.allowed_paths].sort())===JSON.stringify([...handoff.allowed_paths].sort())
    &&JSON.stringify([...current.historical_repair_paths].sort())===JSON.stringify([...repairs].sort())
    &&JSON.stringify([...current.repair_paths].sort())===JSON.stringify([...repairs,...fixturePaths].sort())
    &&JSON.stringify([...current.implementation_paths].sort())===JSON.stringify(currentPaths)
    &&JSON.stringify([...current.validated_ci_sequence_paths].sort())===JSON.stringify(reviewedPaths),"current I23 supply mismatch");
  historicalI23Body=currentBody;
  }
  const historicalI23Head="737567073017263df8706d7774676d1f90ed9fc9";
  git("merge-base","--is-ancestor",historicalI22Head,historicalI23Head);
  git("merge-base","--is-ancestor",historicalI23Head,headSha);
  check(git("rev-parse",`${historicalI23Head}^{tree}`)==="ecc93094a182f271fecdd08e3832e9192fdbb4b2"
    &&binaryHash(historicalI22Head,historicalI23Head)==="133c0efc4d20faf4044e22d40dc22ac5f94cf16d77b536e81a364ff894d62008"
    &&JSON.stringify(git("diff","--no-renames","--name-only",`${historicalI22Head}...${historicalI23Head}`).split("\n").filter(Boolean).sort())
      ===JSON.stringify([...currentMetadata,"tests/helpers/seat-native-runtime-fixture.ts","tests/seat-runtime-continuity.test.ts"].sort()),
    "historical I23 fixture delta mismatch");
  let historicalI24Body;
  {
  const currentBody=await load(`https://github.com/${target}/issues/940#issuecomment-5712657386`,"50ef93e5ae7329ea0856bbf56e718547d199b071db94dcb24fb9027fe0a0d7c9");
  const currentMarker="<!-- shirube-v3:control-handoff:CH-CTO-AUN-POC-INTEGRATION-20260917-I24 -->";
  check(currentBody.split(currentMarker).length===2&&[...currentBody.matchAll(/<!--\s*shirube-v3:control-handoff[^>]*-->/g)].length===1,
    "current I24 marker must occur once");
  const currentBlocks=[...currentBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(currentBlocks.length===1,"one current I24 JSON block required");
  const current=JSON.parse(currentBlocks[0][1]);
  const fixturePaths=["tests/helpers/seat-native-runtime-fixture.ts","tests/seat-runtime-continuity.test.ts"];
  const currentPaths=[...currentMetadata,...fixturePaths,"tests/contract/test_queue_bounded_retry.test.ts"].sort();
  check(current.schema_version==="shirube-control-handoff/v1"
    &&current.handoff_id==="CH-CTO-AUN-POC-INTEGRATION-20260917-I24"
    &&current.control_source===`${target}#940`
    &&current.subject.repository===target&&current.subject.pr===963&&current.subject.base===base
    &&current.subject.current_public_head===historicalI23Head&&current.subject.current_local_head===historicalI23Head
    &&current.subject.current_local_tree===git("rev-parse",`${historicalI23Head}^{tree}`)
    &&current.subject.entry_full_index_diff_sha256===binaryHash(base,historicalI23Head)
    &&current.subject.c2===handoff.subject.c2&&current.subject.seat_continuity===handoff.subject.seat_continuity
    &&current.subject.was_companion===handoff.subject.was_companion
    &&current.subject.historical_C17_head===historicalC17&&current.subject.reviewed_ci_head===reviewedCiHead
    &&current.subject.historical_C17_tree===supply.subject.historical_C17_tree
    &&current.subject.ci_sequence_delta_sha256===supply.subject.ci_sequence_delta_sha256
    &&current.subject.historical_I22_metadata_delta_sha256===binaryHash(reviewedCiHead,historicalI22Head)
    &&current.subject.historical_I23_delta_sha256===binaryHash(historicalI22Head,historicalI23Head)
    &&current.historical_I23_ref.url===`https://github.com/${target}/issues/940#issuecomment-5712041088`
    &&current.historical_I23_ref.sha256===hash(historicalI23Body)
    &&current.execution_context.active_function==="implementation_executor"
    &&current.execution_context.actor_agent_id==="codex-cto/ci_sequence_fix"
    &&current.execution_context.checker==="/root/ci_sequence_plan_gate"
    &&current.authority_refs.length===1&&current.authority_refs[0].url===odUrl&&current.authority_refs[0].sha256===odHash
    &&current.historical_I22_ref.url===`https://github.com/${target}/issues/940#issuecomment-5711335296`
    &&current.historical_I22_ref.sha256===hash(supplyBody)
    &&current.historical_I21_ref.url===supply.historical_I21_ref.url&&current.historical_I21_ref.sha256===hash(handoffBody)
    &&Date.parse(current.bounds.expires_at)===Date.parse(expiry)
    &&current.bounds.execution_expires_at==="2026-09-17T21:30:00+09:00"
    &&current.bounds.active_minutes===35&&current.bounds.wall_minutes===50
    &&current.bounds.new_candidates===1&&current.bounds.cumulative_candidate_limit===22
    &&current.bounds.new_full_suite_runs===1&&current.bounds.cumulative_full_suite_limit===22
    &&current.bounds.new_private2_runs===1&&current.bounds.focused_metadata_runs_max===2
    &&current.bounds.diagnostic_probe_invocations_max===1&&current.bounds.correction_rounds===0
    &&current.bounds.publicCIstarts===0&&current.bounds.pushes===0&&current.bounds.protected_effects===0
    &&JSON.stringify([...current.allowed_paths].sort())===JSON.stringify([...handoff.allowed_paths].sort())
    &&JSON.stringify([...current.historical_repair_paths].sort())===JSON.stringify([...repairs,...fixturePaths].sort())
    &&JSON.stringify([...current.repair_paths].sort())===JSON.stringify([...repairs,...fixturePaths].sort())
    &&JSON.stringify([...current.implementation_paths].sort())===JSON.stringify(currentPaths)
    &&JSON.stringify([...current.validated_ci_sequence_paths].sort())===JSON.stringify(reviewedPaths),"current I24 supply mismatch");
  historicalI24Body=currentBody;
  }
  const historicalI24Head="cf06d07480d6300683a11e5064530e96f16d280d";
  git("merge-base","--is-ancestor",historicalI23Head,historicalI24Head);
  git("merge-base","--is-ancestor",historicalI24Head,headSha);
  check(git("rev-parse",`${historicalI24Head}^{tree}`)==="17af4acbb8ed68da4256b4f9b144f15de6cbdf33"
    &&binaryHash(historicalI23Head,historicalI24Head)==="88237eea0c12a66ea83819e9b7d98e80441c43ba9345c7a8475d5937015e0b68"
    &&JSON.stringify(git("diff","--no-renames","--name-only",`${historicalI23Head}...${historicalI24Head}`).split("\n").filter(Boolean).sort())
      ===JSON.stringify([...currentMetadata,"tests/seat-runtime-continuity.test.ts","tests/contract/test_queue_bounded_retry.test.ts"].sort()),
    "historical I24 marker delta mismatch");
  const currentBody=await load(ref,digest);
  const currentMarker="<!-- shirube-v3:control-handoff:CH-CTO-AUN-POC-INTEGRATION-20260917-I25 -->";
  check(currentBody.split(currentMarker).length===2&&[...currentBody.matchAll(/<!--\s*shirube-v3:control-handoff[^>]*-->/g)].length===1,
    "current I25 marker must occur once");
  const currentBlocks=[...currentBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(currentBlocks.length===1,"one current I25 JSON block required");
  const current=JSON.parse(currentBlocks[0][1]);
  const fixturePaths=["tests/helpers/seat-native-runtime-fixture.ts","tests/seat-runtime-continuity.test.ts"];
  const currentPaths=currentMetadata;
  check(current.schema_version==="shirube-control-handoff/v1"
    &&current.handoff_id==="CH-CTO-AUN-POC-INTEGRATION-20260917-I25"
    &&current.control_source===`${target}#940`
    &&current.subject.repository===target&&current.subject.pr===963&&current.subject.base===base
    &&current.subject.current_public_head===historicalI24Head&&current.subject.current_local_head===historicalI24Head
    &&current.subject.current_local_tree===git("rev-parse",`${historicalI24Head}^{tree}`)
    &&current.subject.entry_full_index_diff_sha256===binaryHash(base,historicalI24Head)
    &&current.subject.c2===handoff.subject.c2&&current.subject.seat_continuity===handoff.subject.seat_continuity
    &&current.subject.was_companion===handoff.subject.was_companion
    &&current.subject.historical_C17_head===historicalC17&&current.subject.reviewed_ci_head===reviewedCiHead
    &&current.subject.historical_C17_tree===supply.subject.historical_C17_tree
    &&current.subject.ci_sequence_delta_sha256===supply.subject.ci_sequence_delta_sha256
    &&current.subject.historical_I22_metadata_delta_sha256===binaryHash(reviewedCiHead,historicalI22Head)
    &&current.subject.historical_I23_delta_sha256===binaryHash(historicalI22Head,historicalI23Head)
    &&current.historical_I23_ref.url===`https://github.com/${target}/issues/940#issuecomment-5712041088`
    &&current.historical_I23_ref.sha256===hash(historicalI23Body)
    &&current.subject.historical_I24_delta_sha256===binaryHash(historicalI23Head,historicalI24Head)
    &&current.historical_I24_ref.url===`https://github.com/${target}/issues/940#issuecomment-5712657386`
    &&current.historical_I24_ref.sha256===hash(historicalI24Body)
    &&current.execution_context.active_function==="implementation_executor"
    &&current.execution_context.actor_agent_id==="codex-cto/ci_sequence_fix"
    &&current.execution_context.checker==="/root/ci_sequence_plan_gate"
    &&current.authority_refs.length===1&&current.authority_refs[0].url===odUrl&&current.authority_refs[0].sha256===odHash
    &&current.historical_I22_ref.url===`https://github.com/${target}/issues/940#issuecomment-5711335296`
    &&current.historical_I22_ref.sha256===hash(supplyBody)
    &&current.historical_I21_ref.url===supply.historical_I21_ref.url&&current.historical_I21_ref.sha256===hash(handoffBody)
    &&Date.parse(current.bounds.expires_at)===Date.parse(expiry)
    &&current.bounds.execution_expires_at==="2026-09-17T22:00:00+09:00"
    &&current.bounds.active_minutes===35&&current.bounds.wall_minutes===50
    &&current.bounds.new_candidates===1&&current.bounds.cumulative_candidate_limit===23
    &&current.bounds.new_full_suite_runs===1&&current.bounds.cumulative_full_suite_limit===23
    &&current.bounds.new_private2_runs===1&&current.bounds.focused_metadata_runs_max===2
    &&current.bounds.diagnostic_probe_invocations_max===1&&current.bounds.correction_rounds===0
    &&current.bounds.publicCIstarts===0&&current.bounds.pushes===0&&current.bounds.protected_effects===0
    &&JSON.stringify([...current.allowed_paths].sort())===JSON.stringify([...handoff.allowed_paths].sort())
    &&JSON.stringify([...current.historical_repair_paths].sort())===JSON.stringify([...repairs,...fixturePaths].sort())
    &&JSON.stringify([...current.repair_paths].sort())===JSON.stringify([...repairs,...fixturePaths].sort())
    &&JSON.stringify([...current.implementation_paths].sort())===JSON.stringify(currentPaths)
    &&JSON.stringify([...current.validated_ci_sequence_paths].sort())===JSON.stringify(reviewedPaths),"current I25 supply mismatch");
  check(git("diff","--no-renames","--name-only",`${historicalI24Head}...${headSha}`).split("\n").filter(Boolean)
    .every(file=>currentImplementationPaths.includes(file)),"candidate repair outside current I25-A2 scope");
  const tree=git("rev-parse",`${headSha}^{tree}`);
  const actualPaths=git("diff","--name-only",`${base}...${headSha}`).split("\n").filter(Boolean).sort();
  check(git("diff","--no-renames","--name-only",`${base}...${headSha}`).split("\n").filter(Boolean)
    .every(file=>admittedPaths.includes(file)),"candidate deletion/rename outside supply");
  check(JSON.stringify(actualPaths)===JSON.stringify(admittedPaths),"I25-A2 actual135 cumulative paths required");
  check(JSON.stringify(actualPaths)===JSON.stringify([...changedFiles].sort()),"changed-files mismatch with actual candidate");
  const diff=hash(execFileSync("git",["diff","--binary","--full-index",`${base}...${headSha}`],{timeout:15000,maxBuffer:16*1024*1024}));
  const expected={schema_version:"shirube-ci-consumer-verdict/v1",target_repo:target,target_pr:963,cell_id:cell,risk_class:"R4",
    base_sha:base,origin_head_sha:origin,exact_head_sha:headSha,candidate_tree:tree,binary_diff_sha256:diff,
    handoff_comment_ref:currentConsumerRef,handoff_body_sha256:currentConsumerDigest,owner_decision_ref:odUrl,owner_decision_body_sha256:odHash,
    checker_agent:consumerRoles.checker_agent,maker_agent:consumerRoles.maker_agent,publisher:"watchout",verdict:"PASS_CONSUMER_COMPATIBILITY"};
  let found=0;
  for(const comment of await loadIssueComments(true)){
    const text=String(comment?.body??"");
    if(!text.includes("shirube-v3:ci-consumer-verdict")&&!text.includes("shirube_consumer_verdict:"))continue;
    let fields;
    try{fields=parseCiConsumerVerdict(text)}catch(error){
      // Never discard a malformed current-head record in favour of a valid one.
      if(text.includes(headSha))throw error;
      continue;
    }
    if(fields.exact_head_sha!==headSha)continue;
    check(comment.user?.login==="watchout"&&comment.author_association==="OWNER"
      &&comment.issue_url===`https://api.github.com/repos/${target}/issues/963`
      &&new RegExp(`^https://github.com/${target}/(?:pull|issues)/963#issuecomment-[1-9][0-9]*$`).test(comment.html_url??"")
      &&String(comment.id)===(comment.html_url??"").split("issuecomment-")[1],"consumer publisher/issue mismatch");
    for(const [key,value] of Object.entries(expected))check(fields[key]===value,`consumer ${key} mismatch`);
    for(const key of ["base_sha","origin_head_sha","exact_head_sha","candidate_tree"])check(sha40(fields[key]),`consumer ${key} type`);
    for(const key of ["binary_diff_sha256","handoff_body_sha256","owner_decision_body_sha256","evidence_sha256"])check(sha64(fields[key]),`consumer ${key} type`);
    for(const key of ["restore_success_ref","restore_reject_ref","runtime_adapter_ref"])
      check(/^(?:sha256:[0-9a-f]{64}|https:\/\/github\.com\/[^\s]+#issuecomment-[1-9][0-9]*)$/.test(fields[key]),`immutable ${key} required`);
    for(const key of ["issued_at","expires_at"])check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(fields[key])&&Number.isFinite(Date.parse(fields[key])),`UTC ${key} required`);
    check(Date.parse(fields.issued_at)<=now&&now<Date.parse(fields.expires_at)&&Date.parse(fields.expires_at)<=Date.parse(effectiveExpiry),"consumer expiry mismatch");
    found++;
  }
  check(found===1,`exactly one current-head consumer receipt required; found ${found}`);
  console.log(JSON.stringify({schema_version:"shirube-ci-supply-readback/v1",base,head:headSha,tree,binary_diff_sha256:diff,
    input_mode:fixturePath?"offline-fixture":"GitHub-API",execution_authorization:"NOT_GRANTED",source_admission:"CI_TEST_SUPPLY_ONLY",operational_truth:"NOT_EVALUATED"}));
}

function parseCiConsumerVerdict(text){
  const fail=()=>{throw Error("malformed current-head consumer record")};
  if(text.split("<!-- shirube-v3:ci-consumer-verdict -->").length!==2
    ||[...text.matchAll(/<!--\s*shirube-v3:ci-consumer-verdict[^>]*-->/g)].length!==1)fail();
  const blocks=[...text.matchAll(/^```ya?ml\s*\n([\s\S]*?)^```\s*$/gm)];
  if(blocks.length!==1)fail();
  const lines=blocks[0][1].trimEnd().split(/\r?\n/);
  if(lines.shift()!=="shirube_consumer_verdict:")fail();
  const keys="schema_version target_repo target_pr cell_id risk_class base_sha origin_head_sha exact_head_sha candidate_tree binary_diff_sha256 handoff_comment_ref handoff_body_sha256 owner_decision_ref owner_decision_body_sha256 checker_agent maker_agent publisher verdict restore_success_ref restore_reject_ref runtime_adapter_ref evidence_sha256 issued_at expires_at".split(" ");
  const fields={};
  for(const line of lines){
    const match=/^  ([a-z][a-z0-9_]*): (.+)$/.exec(line);if(!match||!keys.includes(match[1])||Object.hasOwn(fields,match[1]))fail();
    const [,key,raw]=match;
    if(key==="target_pr"){if(!/^[1-9][0-9]*$/.test(raw))fail();fields[key]=Number(raw)}
    else if(raw.startsWith('"')){try{fields[key]=JSON.parse(raw)}catch{fail()};if(typeof fields[key]!=="string")fail()}
    else{if(!/^[A-Za-z0-9][A-Za-z0-9_:/#.@-]*$/.test(raw)||/^(?:null|true|false)$/.test(raw))fail();fields[key]=raw}
  }
  if(Object.keys(fields).length!==keys.length)fail();return fields;
}

// Syntax only: callers MUST authenticate the exact API identity and raw body
// digest first. Markerless form is used solely for the pinned original OD.
function requireCiOwnerDecision(text,decisionId,marked){
  const fail=()=>{throw Error("owner decision source form mismatch")};
  const markers=[...text.matchAll(/<!--\s*shirube-v3:owner-decision[^>]*-->/g)];
  const expected="<!-- shirube-v3:owner-decision:"+decisionId+" -->";
  if(marked ? markers.length!==1||markers[0][0]!==expected : markers.length!==0)fail();
  const blocks=[...text.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  if(blocks.length!==1||[...blocks[0][1].matchAll(/"decision_id"\s*:/g)].length!==1)fail();
  let value;try{value=JSON.parse(blocks[0][1])}catch{fail()}
  if(!value||Array.isArray(value)||value.schema_version!=="shirube-owner-decision/v1"||value.decision_id!==decisionId
    ||value.decision!=="APPROVED"||value.owner!=="watchout"||value.control_source!=="watchout/agent-comms-mcp#940")fail();
  return value;
}

async function boundedGithubGet(url){
  if(new URL(url).origin!=="https://api.github.com")throw Error("GitHub pagination host mismatch");
  const token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN;
  if(!token)throw Error("GitHub token required for bounded CI source readback");
  const response=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:"error",headers:{Accept:"application/vnd.github+json",Authorization:`Bearer ${token}`,"X-GitHub-Api-Version":"2022-11-28"}});
  if(!response.ok)throw Error(`GitHub source HTTP ${response.status}`);
  return {value:await response.json(),next:nextLink(response.headers.get("link"))};
}

if (body.match(/\bmerge[- ]ready\b/i) && !labels.has("owner-exact-head-approved")) {
  errors.push("PR body must not claim merge-ready before owner exact-head approval.");
}

for (const warning of warnings) {
  console.log(`::warning::${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.log(`::error::${error}`);
  }
  process.exit(1);
}

if (sourceAdmissionOnly) {
  console.log("Shirube source-admission gate passed; release authority NOT_EVALUATED.");
} else {
  console.log("Shirube current-overlay gate passed.");
}

async function requireOwnerDecisionArtifact() {
  const comments = await loadIssueComments();
  const decisions = comments
    .map((comment, commentIndex) => parseOwnerDecisionComment(comment, commentIndex))
    .filter(Boolean);
  const exactDecisions = decisions.filter((decision) => {
    return decision.schema_version === "shirube-owner-decision/v1"
      && decision.target_repo === repo
      && String(decision.target_pr) === String(prNumber)
      && decision.exact_head_sha === headSha
      && decision.verdict === "APPROVED_EXACT_HEAD"
      && decision.actor === decision.commentAuthor
      && decision.decision_ref === decision.commentUrl
      && ["OWNER", "MEMBER", "COLLABORATOR"].includes(decision.authorAssociation);
  });

  if (exactDecisions.length === 0) {
    errors.push(
      [
        "Non-draft PRs require a machine-verifiable shirube_owner_decision comment for the current exact head.",
        `Expected schema_version=shirube-owner-decision/v1, target_repo=${repo}, target_pr=${prNumber}, exact_head_sha=${headSha}, verdict=APPROVED_EXACT_HEAD, merge_method=merge|squash|rebase, actor equal to the comment author, and decision_ref equal to the comment URL.`,
      ].join(" "),
    );
    return null;
  }

  const decisionsByRef = new Map(exactDecisions.map((decision) => [decision.decision_ref, decision]));
  const supersededRefs = new Set();
  for (const decision of exactDecisions) {
    if (!decision.supersedes_decision_ref) continue;
    const superseded = decisionsByRef.get(decision.supersedes_decision_ref);
    if (!superseded || superseded.commentIndex >= decision.commentIndex) {
      errors.push(
        `Owner decision ${decision.decision_ref} has invalid supersedes_decision_ref=${decision.supersedes_decision_ref}; it must reference a prior valid decision for the same exact head.`,
      );
      continue;
    }
    supersededRefs.add(superseded.decision_ref);
  }

  const currentDecisions = exactDecisions.filter((decision) => !supersededRefs.has(decision.decision_ref));
  if (currentDecisions.length !== 1) {
    errors.push(
      `Exact head ${headSha} requires exactly one authoritative owner decision after explicit supersession; found ${currentDecisions.length}: ${currentDecisions.map((decision) => decision.decision_ref).join(", ") || "<none>"}.`,
    );
    return null;
  }
  return currentDecisions[0];
}

function requireMergeMethodSelection(ownerDecision) {
  const mergeMethodLabels = [...labels]
    .filter((label) => label.startsWith(mergeMethodLabelPrefix));

  if (mergeMethodLabels.length !== 1) {
    errors.push(
      `Non-draft PRs require exactly one merge-method label; found ${mergeMethodLabels.length}: ${mergeMethodLabels.join(", ") || "<none>"}.`,
    );
    return;
  }

  const selectedMethod = mergeMethodLabels[0].slice(mergeMethodLabelPrefix.length);
  if (!supportedMergeMethods.has(selectedMethod)) {
    errors.push(
      `Unsupported merge method label ${mergeMethodLabels[0]}; supported methods are merge, squash, and rebase.`,
    );
    return;
  }
  if (requiredMergeMethod && selectedMethod !== requiredMergeMethod) {
    errors.push(
      `Execution requires merge_method=${requiredMergeMethod}, but the live label selects ${selectedMethod}.`,
    );
  }

  if (!ownerDecision) return;
  if (!supportedMergeMethods.has(ownerDecision.merge_method)) {
    errors.push(
      `Owner decision must select merge_method=merge, squash, or rebase; got ${ownerDecision.merge_method || "<empty>"}.`,
    );
    return;
  }
  if (ownerDecision.merge_method !== selectedMethod) {
    errors.push(
      `Owner decision merge_method=${ownerDecision.merge_method} does not match label ${mergeMethodLabels[0]}.`,
    );
  }
  if (requiredMergeMethod && ownerDecision.merge_method !== requiredMergeMethod) {
    errors.push(
      `Execution requires merge_method=${requiredMergeMethod}, but the authoritative owner decision selects ${ownerDecision.merge_method}.`,
    );
  }
}

async function loadIssueComments(bounded=false) {
  const commentsPath = stringArg(args.comments) ?? process.env.SHIRUBE_PR_COMMENTS_PATH ?? "";
  if (commentsPath) {
    const parsed = readJsonIfPresent(commentsPath);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.comments)) return parsed.comments;
    errors.push(`Owner decision comments file is not an array or { comments: [] }: ${commentsPath}`);
    return [];
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  if (!token || !repo || !prNumber) {
    errors.push("Non-draft PRs require GITHUB_TOKEN/GH_TOKEN and PR number to verify owner decision comments.");
    return [];
  }

  const comments = [];
  let url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`;
  if(bounded){
    for(let page=0;url&&page<10;page++){
      const result=await boundedGithubGet(url);
      if(!Array.isArray(result.value))throw Error("GitHub issue comments must be array");
      comments.push(...result.value);url=result.next;
    }
    if(url)throw Error("GitHub comment pagination cap exceeded");
    return comments;
  }
  while (url) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const responseText = await response.text();
      errors.push(`Failed to load PR comments for owner decision verification: HTTP ${response.status} ${responseText}`);
      return [];
    }
    const page = await response.json();
    if (!Array.isArray(page)) {
      errors.push("GitHub issue comments response was not an array.");
      return [];
    }
    comments.push(...page);
    url = nextLink(response.headers.get("link"));
  }
  return comments;
}

function parseOwnerDecisionComment(comment, commentIndex) {
  const text = String(comment?.body ?? "");
  if (!text.includes("shirube_owner_decision:")) return null;

  const fields = {};
  const lines = text.split(/\r?\n/u);
  const blockStart = lines.findIndex((line) => /^\s*shirube_owner_decision:\s*$/u.test(line));
  if (blockStart < 0) return null;
  const blockIndent = lines[blockStart].match(/^\s*/u)?.[0].length ?? 0;

  for (const line of lines.slice(blockStart + 1)) {
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/u)?.[0].length ?? 0;
    if (indent <= blockIndent) break;
    const match = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/u);
    if (!match) continue;
    const [, key, rawValue] = match;
    fields[key] = cleanScalar(rawValue);
  }

  return {
    schema_version: fields.schema_version,
    target_repo: fields.target_repo,
    target_pr: fields.target_pr,
    exact_head_sha: fields.exact_head_sha,
    verdict: fields.verdict,
    merge_method: fields.merge_method,
    supersedes_decision_ref: fields.supersedes_decision_ref,
    actor: fields.actor,
    decision_ref: fields.decision_ref,
    commentAuthor: String(comment?.user?.login ?? ""),
    authorAssociation: String(comment?.author_association ?? ""),
    commentUrl: String(comment?.html_url ?? ""),
    commentIndex,
  };
}

function cleanScalar(value) {
  return String(value ?? "")
    .trim()
    .replace(/^["'`]|["'`]$/gu, "");
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/u);
    if (match) return match[1];
  }
  return null;
}

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set([
    "repo", "event", "changed-files", "expected-head", "required-merge-method",
    "comments", "control-comments", "mode",
  ]);
  const invalid = (detail) => { throw new Error(`Invalid gate arguments: ${detail}`); };
  for (let index = 0; index < argv.length; index += 2) {
    const arg = argv[index];
    if (!arg.startsWith("--") || !supported.has(arg.slice(2))) invalid(`unknown argument ${arg}`);
    const key = arg.slice(2);
    if (Object.hasOwn(parsed, key)) invalid(`duplicate --${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || value.trim() !== value) invalid(`value required for --${key}`);
    parsed[key] = value;
  }
  if (parsed.mode !== undefined && !["full", "source-admission"].includes(parsed.mode)) invalid("unsupported mode");
  if (parsed.mode === "source-admission" && Object.hasOwn(parsed, "required-merge-method")) {
    invalid("source-admission cannot require a release merge method");
  }
  return parsed;
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readJsonIfPresent(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

function readChangedFiles(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function requireEqual(name, actual, expected) {
  if (actual !== expected) {
    errors.push(`${name} must be ${expected}; got ${actual || "<empty>"}.`);
  }
}

function requireExisting(filePath) {
  if (!existsSync(filePath)) {
    errors.push(`Required Shirube current-overlay artifact is missing: ${filePath}`);
  }
}

function requireAbsent(filePath) {
  if (existsSync(filePath)) {
    errors.push(`Obsolete Shirube full-adoption artifact must be removed: ${filePath}`);
  }
}

// Validate only direct scalar fields of a unique generated mapping. Historical
// nested fields, comments, duplicate sections/keys, aliases and quoted booleans
// cannot substitute for these current bindings. Complete YAML remains runtime-owned.
function requireCurrentScalars(filePath, section, expected) {
  const text = readText(filePath);
  if (!text) { errors.push(`Required file is missing or empty: ${filePath}`); return; }
  const lines = text.split(/\r?\n/);
  let selected = lines, indent = "";
  if (section) {
    const sectionKey = new RegExp(`^(?:${section}|"${section}"|'${section}'):`);
    const starts = lines.map((line,index) => sectionKey.test(line) ? index : -1).filter(index => index >= 0);
    if (starts.length !== 1 || lines[starts[0]] !== `${section}:`) { errors.push(`${filePath} requires one current ${section} mapping.`); return; }
    const start = starts[0] + 1;
    let end = start;
    while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
    selected = lines.slice(start,end); indent = "  ";
  }
  for (const [key,value] of Object.entries(expected)) {
    const prefix = `${indent}${key}:`;
    const keyPattern = new RegExp(`^${indent}(?:${key}|"${key}"|'${key}'):`);
    const matches = selected.filter(line => keyPattern.test(line));
    const literals = typeof value === "string"
      ? [value, JSON.stringify(value), `'${value.replaceAll("'", "''")}'`] : [String(value)];
    if (matches.length !== 1 || !matches[0].startsWith(prefix + " ") || !literals.includes(matches[0].slice(prefix.length).trim())) {
      errors.push(`${filePath} requires unique current ${section ? section + "." : ""}${key}: ${JSON.stringify(value)}.`);
    }
  }
}

function requireText(filePath, needles) {
  const text = readText(filePath);
  if (!text) {
    errors.push(`Required file is missing or empty: ${filePath}`);
    return;
  }
  for (const needle of needles) {
    if (!text.includes(needle)) errors.push(`${filePath} must include ${needle}.`);
  }
}

function requireTextCount(filePath, needle, expectedCount, message) {
  const text = readText(filePath);
  if (!text) {
    errors.push(`Required file is missing or empty: ${filePath}`);
    return;
  }
  const count = text.split(needle).length - 1;
  if (count !== expectedCount) errors.push(`${filePath}: ${message} Found ${count}.`);
}

function forbidText(filePath, needles, message) {
  const text = readText(filePath);
  if (!text) {
    errors.push(`Required file is missing or empty: ${filePath}`);
    return;
  }
  for (const needle of needles) {
    if (text.includes(needle)) errors.push(`${filePath}: ${message} Forbidden text: ${needle}.`);
  }
}

function requireRegex(filePath, pattern, message) {
  const text = readText(filePath);
  if (!text) {
    errors.push(`Required file is missing or empty: ${filePath}`);
    return;
  }
  if (!pattern.test(text)) errors.push(`${filePath}: ${message}`);
}

function requirePrBodyText(needles) {
  for (const needle of needles) {
    if (!body.includes(needle)) errors.push(`PR body must include ${needle}.`);
  }
}

function requirePullRequestTypes(filePath, requiredTypes) {
  const text = readText(filePath);
  if (!text) {
    errors.push(`Required workflow is missing or empty: ${filePath}`);
    return;
  }
  for (const activityType of requiredTypes) {
    const pattern = new RegExp(`^\\s*-\\s*${escapeRegExp(activityType)}\\s*$`, "mu");
    if (!pattern.test(text)) {
      errors.push(`${filePath} pull_request.types must include ${activityType}.`);
    }
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => pattern.test(filePath));
}

// Validate actual git raw modes/status without abbreviating source objects.
function isRegularFileModification(row) {
  return /^:100644 100644 [0-9a-f]{40} [0-9a-f]{40} M\t[^\t\n]+$/.test(row);
}
