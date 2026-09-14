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

requireText(".shirube/repo-spec.yaml", [
  "schema_version: shirube-repo-spec/v1",
  'repo: "watchout/agent-comms-mcp"',
  'primary_control_source: "watchout/agent-comms-mcp#802"',
  "mirror_is_truth: false",
  "llm_final_authority: false",
  "owner_confirmation_required: true",
  ".github/workflows/shirube-rapid-lite-gates-report.yml",
]);

requireText(".shirube/execution-context.yaml", [
  "schema_version: shirube-execution-context/v1",
  "mode: rapid_lite_overlay_adoption",
  "repo: watchout/agent-comms-mcp",
  "relation: primary",
  "relation: framework_support",
  "relation: same_repo_control_source",
  "llm_final_authority_forbidden: true",
]);

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

requireText(".shirube/lifecycle-state.yaml", [
  "schema_version: shirube-lifecycle-state/rapid-lite/v1",
  "mode: rapid-lite",
  "profile: hotel-lite",
  "current_phase: HANDOFF_READY",
  "owner_must_not_merge_until_exact_head_decision: true",
]);

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
  if (pr.draft !== true) {
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
// binds the complete reviewed canonical object, including all 126 admitted integration paths. No remote event budget is inferred.
async function requireBoundedCiSupply() {
  const target="watchout/agent-comms-mcp", cell="CELL-AUN-940-NARROW-USE-CORRECTION-20260908-001";
  const base="0f772883db6f3b50772d3e4b82ce47795091f0a9", origin="565583c25963b7dfa9b4445543967d372091b336";
  const odUrl=`https://github.com/${target}/issues/940#issuecomment-5609700544`;
  const currentC8="c90541aca7f9a1582e56cdce23ab8acd806c0d5f";
  const odHash="59952776f1cfb5093040cb9318641f54721ef4f0f416ee278d1e426e980aef02";
  const expiry="2026-09-14T09:00:00Z", now=Date.now();
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
  check(sha40(headSha)&&pr.base?.sha===base&&now<Date.parse(expiry),"head/base/expiry mismatch");
  const ref=metadata("control_handoff_comment_ref"), digest=metadata("control_handoff_body_sha256");
  check(/^https:\/\/github\.com\/watchout\/agent-comms-mcp\/issues\/940#issuecomment-[1-9][0-9]*$/.test(ref)&&sha64(digest),"handoff pin invalid");
  check(ref===`https://github.com/${target}/issues/940#issuecomment-5658996537`
    &&digest==="33e3c0ae8d6dd045fd1bf1dddc319dc880bb1505507967674fe7ac02011f0c7c","exact published I required");
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
  const handoffBody=await load(ref,digest);
  const marker="<!-- shirube-v3:control-handoff:CH-CTO-AUN-POC-INTEGRATION-20260914-I9 -->";
  check(handoffBody.split(marker).length===2&&[...handoffBody.matchAll(/<!--\s*shirube-v3:control-handoff[^>]*-->/g)].length===1,"canonical marker must occur once");
  const blocks=[...handoffBody.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  check(blocks.length===1,"one current handoff JSON block required");
  const handoff=JSON.parse(blocks[0][1]);
  check(handoff.schema_version==="shirube-control-handoff/v1"
    &&handoff.handoff_id==="CH-CTO-AUN-POC-INTEGRATION-20260914-I9"
    &&handoff.subject.repository===target&&handoff.subject.pr===963
    &&handoff.subject.current_public_head===currentC8&&handoff.subject.base===base
    &&handoff.subject.c2==="8d38f3bd6a99a2f4615949dd747d708f8b6943d6"
    &&handoff.subject.seat_continuity==="81be7f051f85973bb9533e87d3258825082ad158"
    &&handoff.subject.was_companion==="e49abc24838227776dc01be111aeb035ec7c9aad"
    &&Date.parse(handoff.bounds.expires_at)===Date.parse(expiry)
    &&handoff.bounds.new_candidates===1&&handoff.bounds.cumulative_candidate_limit===9
    &&handoff.bounds.new_full_suite_runs===1&&handoff.bounds.cumulative_full_suite_limit===10
    &&handoff.bounds.new_private2_runs===1&&handoff.bounds.focused_runs===1
    &&handoff.bounds.correction_rounds===1&&handoff.bounds.two_callers_original_limit===20
    &&handoff.bounds.two_callers_consumed===23&&handoff.bounds.active_minutes===40
    &&handoff.bounds.local_completion_target==="2026-09-14T14:05:00+09:00"
    &&handoff.bounds.owned_fixture_setup_completion===1
    &&handoff.bounds.two_callers_additional_local_specimens===1&&handoff.bounds.two_callers_cumulative_limit===24
    &&handoff.subject.current_local_head===currentC8
    &&handoff.execution_context.active_function==="implementation_executor"
    &&handoff.execution_context.actor_agent_id==="codex-cto/latest_delivery"
    &&handoff.execution_context.checker==="/root/goal_gap"
    &&handoff.authority_refs.length===1&&handoff.authority_refs[0].url===odUrl
    &&handoff.authority_refs[0].sha256===odHash
    &&handoff.allowed_paths.length===126&&new Set(handoff.allowed_paths).size===126,"current integration supply mismatch");
  check(changedFiles.every(file=>handoff.allowed_paths.includes(file))
    &&changedFiles.filter(file=>file.startsWith(".github/workflows/")).every(file=>file===".github/workflows/pr-checks.yml"),"candidate path outside supply");
  const git=(...argv)=>execFileSync("git",argv,{encoding:"utf8",timeout:15000,maxBuffer:16*1024*1024}).trim();
  git("merge-base","--is-ancestor",origin,currentC8);
  git("merge-base","--is-ancestor",currentC8,headSha);
  git("merge-base","--is-ancestor",handoff.subject.c2,headSha);
  git("merge-base","--is-ancestor",handoff.subject.seat_continuity,headSha);
  git("merge-base","--is-ancestor",handoff.subject.current_local_head,headSha);
  const repairs=[".github/workflows/pr-checks.yml","docs/design/aun-bounded-admission.md",
    "scripts/shirube-current-overlay-check.mjs","tests/shirube-current-overlay-check.test.ts","tests/contract/test_queue_bounded_use_trace.test.ts"];
  check(JSON.stringify([...handoff.repair_paths].sort())===JSON.stringify(repairs.sort())
    &&git("diff","--no-renames","--name-only",`${handoff.subject.current_local_head}...${headSha}`).split("\n").filter(Boolean)
      .every(file=>repairs.includes(file)),"candidate repair outside current I9 scope");
  const tree=git("rev-parse",`${headSha}^{tree}`);
  const actualPaths=git("diff","--name-only",`${base}...${headSha}`).split("\n").filter(Boolean).sort();
  check(git("diff","--no-renames","--name-only",`${base}...${headSha}`).split("\n").filter(Boolean)
    .every(file=>handoff.allowed_paths.includes(file)),"candidate deletion/rename outside supply");
  check(JSON.stringify(actualPaths)===JSON.stringify([...changedFiles].sort()),"changed-files mismatch with actual candidate");
  const diff=hash(execFileSync("git",["diff","--binary","--full-index",`${base}...${headSha}`],{timeout:15000,maxBuffer:16*1024*1024}));
  const expected={schema_version:"shirube-ci-consumer-verdict/v1",target_repo:target,target_pr:963,cell_id:cell,risk_class:"R4",
    base_sha:base,origin_head_sha:origin,exact_head_sha:headSha,candidate_tree:tree,binary_diff_sha256:diff,
    handoff_comment_ref:ref,handoff_body_sha256:digest,owner_decision_ref:odUrl,owner_decision_body_sha256:odHash,
    checker_agent:"codex-cto/goal_gap",maker_agent:"codex-cto/latest_delivery",publisher:"watchout",verdict:"PASS_CONSUMER_COMPATIBILITY"};
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
    check(Date.parse(fields.issued_at)<=now&&now<Date.parse(fields.expires_at)&&Date.parse(fields.expires_at)<=Date.parse(expiry),"consumer expiry mismatch");
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

console.log("Shirube current-overlay gate passed.");

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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = value;
    index += 1;
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
