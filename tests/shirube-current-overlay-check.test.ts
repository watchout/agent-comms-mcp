import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// Public immutable authority bodies are DATA for isolated parser fixtures only.
// No credentials/private source; a fixture PASS never grants execution authority.
const ciAuthorityFixtures=[
  {
    "id": 5602974560,
    "body": "# Owner decision — PR #963 narrow CI unblock\n\nOwnerの「承認します」を、直前の限定申請に対応づけて公開します。実装・検証の限定追加であり、merge・再起動・本番操作の承認ではありません。\n\n```json\n{\n  \"schema_version\": \"shirube-owner-decision/v1\",\n  \"decision_id\": \"OD-CTO-963-NARROW-CI-UNBLOCK-20260909-001\",\n  \"decision\": \"APPROVED\",\n  \"owner\": \"watchout\",\n  \"owner_utterance_verbatim\": \"承認します\",\n  \"recorded_by\": \"codex-cto/orchestration_controller\",\n  \"control_source\": \"watchout/agent-comms-mcp#940\",\n  \"cell_id\": \"CELL-AUN-940-NARROW-USE-CORRECTION-20260908-001\",\n  \"owner_goal_verbatim\": \"全体の開発高速チームの構築を成立させる\",\n  \"current_priority_verbatim\": \"私が中継することが必要ならやりますので、とにかくaun正常化を進めたいです\",\n  \"approved_request_ref\": {\n    \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5602019213\",\n    \"sha256\": \"f9a8a35fb486027628679fe76c31d8bab1606c85d4635b3b31fdfe128fe4617a\"\n  },\n  \"approved_request_id\": \"OR-CTO-963-NARROW-CI-UNBLOCK-20260909-001\",\n  \"subject\": {\n    \"pr\": \"https://github.com/watchout/agent-comms-mcp/pull/963\",\n    \"base\": \"0f772883db6f3b50772d3e4b82ce47795091f0a9\",\n    \"head\": \"565583c25963b7dfa9b4445543967d372091b336\",\n    \"tree\": \"ec0d7c789ad67d069a1b568c17ae60bf89fdea55\"\n  },\n  \"scope\": [\n    \"Add exactly3abovegate/doc/testpaths toexistingI44 for thissamePR/cell only. Preservegen5productdesign/21IDs; authorboundedgate amendmentplan/docs first and obtainindependentpreimplementationcheck. No newoverallframeworkdesign or automaticproductgen6.\",\n    \"Supplement bounded restoreCLI success/reject evidence in alreadyallowedrestoretest. Preservemaker/checkerseparation and rerun formal local15/private2 on each actualnewcandidate beforejoinedacceptance.\",\n    \"Publish genuine supportedcanonicalhandoff/evidence binding and updatePRbody once; do not fabricatemetadata/oldcell/R3. Afterindependentconsumerverification, apply only breaking-change-verified label once toPR963; no mergeenablinglabels.\",\n    \"Permit up to2new changed-input candidates(initialnarrowgate/consumer correction plusone in-scope returnedfindingfix), at most2normalpushes. No rebase/reset/forcepush/basechange.\",\n    \"Permit at most4additional Layer0 runstarts total, including labeled/edited/synchronize automaticallytriggered runs (body1+label1+pushes<=2). No manualrerun, no unchangedretryseekinggreen, no extraactionsaftercap. Prior34350598901 remainsFAIL. Recordevent/head/runid andnevercountpriorheadrun aslatestheadqualification.\",\n    \"Requireactual CI19/fullsuite and independentfullIG/rawjoin on qualifiednewhead. No source/test threshold/checkidentity/checkconditionwaiver; exacthead merge/runtime approvalremainsseparate.\"\n  ],\n  \"additional_allowed_paths\": [\n    \"scripts/shirube-current-overlay-check.mjs\",\n    \"tests/shirube-current-overlay-check.test.ts\",\n    \"docs/shirube/README.md\"\n  ],\n  \"inherited_handoff_ref\": {\n    \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5600600067\",\n    \"sha256\": \"a73638ab595370177bca7f08b7898dc2c11dbcaa3a0172d31481dc45093c76bf\",\n    \"body_equal\": true,\n    \"marker_equal\": true\n  },\n  \"allowed_product_paths\": [\n    \"docs/SSOT.md\",\n    \"docs/agent-com-message-queue-spec.md\",\n    \"docs/design/aun-bounded-admission.md\",\n    \"db/migrations/2026-09-08-queue-bounded-admission.up.sql\",\n    \"db/migrations/2026-09-08-queue-bounded-admission.down.sql\",\n    \"db/migrate.ts\",\n    \"db/migrate-sqlite.ts\",\n    \"core/queue-admission.ts\",\n    \"bin/aun/admission.ts\",\n    \"bin/aun.ts\",\n    \"cli/index.ts\",\n    \"server.ts\",\n    \"bin/aun/receive.ts\",\n    \"core/queue-work.ts\",\n    \"bin/aun/run-queue-work.ts\",\n    \"core/state-daemon/index.ts\",\n    \"core/state-daemon/types.ts\",\n    \"bin/state-daemon.ts\",\n    \"core/state-daemon/queue-work-activation-plan.ts\",\n    \"core/claim-ttl.ts\",\n    \"core/inbox-cursor.ts\",\n    \"core/outbound-projection.ts\",\n    \"adapters/outbound-consumer.ts\",\n    \"scripts/state-daemon-launchagent.ts\",\n    \"core/state-daemon/launchagent.ts\",\n    \"tests/contract/test_queue_bounded_admission.test.ts\",\n    \"tests/contract/test_queue_bounded_admission_postgres.test.ts\",\n    \"tests/contract/test_queue_bounded_retry.test.ts\",\n    \"tests/contract/test_queue_bounded_use_trace.test.ts\",\n    \"tests/contract/test_aun_targeted_receive.test.ts\",\n    \"tests/contract/test_aun_targeted_receive_pg.test.ts\",\n    \"tests/contract/test_aun_receive_wrapper.test.ts\",\n    \"tests/queue-work.test.ts\",\n    \"tests/run-queue-work-plan.test.ts\",\n    \"tests/state-daemon-queue-work-scheduler.test.ts\",\n    \"tests/cli-fail-skip-reclaim.test.ts\",\n    \"tests/outbound-consumer.test.ts\",\n    \"tests/outbound-projection.test.ts\",\n    \"tests/state-daemon-queue-work-activation-plan.test.ts\",\n    \"tests/contract/state-daemon/test_launchagent_restore.test.ts\",\n    \"tests/state-daemon-launchagent-fleet-mode.test.ts\",\n    \"tests/db-adapter.test.ts\",\n    \".github/workflows/pr-checks.yml\",\n    \"adapters/discord.ts\",\n    \"scripts/shirube-current-overlay-check.mjs\",\n    \"tests/shirube-current-overlay-check.test.ts\",\n    \"docs/shirube/README.md\"\n  ],\n  \"bounds\": {\n    \"new_changed_input_candidates\": 2,\n    \"normal_pushes\": 2,\n    \"pr_body_updates\": 1,\n    \"breaking_change_verified_label_applications\": 1,\n    \"additional_Layer0_run_starts\": 4,\n    \"CI_events_included\": [\n      \"edited\",\n      \"labeled\",\n      \"synchronize\"\n    ],\n    \"manual_reruns\": 0,\n    \"unchanged_resubmissions\": 0,\n    \"new_agents\": 0,\n    \"monitors\": 0,\n    \"product_design_generations\": 0,\n    \"expiry\": \"2026-09-11T00:00:00Z\"\n  },\n  \"required_sequence\": [\n    \"Author narrowly scoped CI-admission amendment plan; independent preimplementation Design Flow check; publish matching I handoff.\",\n    \"Implement only approved paths; preserve gen5 design and 21 fixed checks; add actual bounded restore CLI consumer success/reject proof.\",\n    \"Independently verify affected consumers and exact candidate. Publish real supported canonical handoff/evidence binding, update PR body once, and only after independent consumer verification apply breaking-change-verified once.\",\n    \"Retain previous FAIL run34350598901; record every additional event/head/run including intermediate runs. At most two normal changed-input pushes and four additional Layer0 starts total.\",\n    \"Require actual CI19 and unfiltered full suite plus independent full IG/raw same-candidate join. These do not authorize live operation or merge.\"\n  ],\n  \"forbidden\": [\n    \"Ready/merge/auto-merge/deploy and merge-enablinglabels\",\n    \"liveDB/schema/roles/profile/provider/queue/send/claim/restart/launchctl/TUIeffects\",\n    \"detectorrewrites/detection-avoidancecode, fakeR3/oldcell, requiredcheckorstandingauthorizationweakening\",\n    \"outside47paths productedits, unapproveddesignsemantics, private-sourcepublication, newagents/monitors\"\n  ],\n  \"unchanged_conditions\": \"No rebase/reset/amend/force-push/base change. No changes to detector, required-check identity/conditions/thresholds, shared standing-authority rules or frozen product gen5/21 IDs/USE01..09. Local isolated test-cluster effects only as inherited in published I; no live DB, schema, role, profile, provider, queue, send/claim, server/daemon/launchctl or TUI effects. Old runtime authorization remains expired.\",\n  \"next_action\": {\n    \"owner_agent\": \"codex-cto\",\n    \"owner_function\": \"orchestration_controller\",\n    \"action\": \"Route existing maker to bounded amendment-plan authoring, then independent gate and approved implementation/consumer/CI/full-IG sequence without another unchanged-scope owner ACK.\",\n    \"delivery\": \"Immutable canonical handoffs at #940, verified by URL/body SHA256, then native existing-agent followup_task.\",\n    \"handoff_method\": \"GitHub control_source plus native existing-agent delegation\",\n    \"input_refs\": [\n      {\n        \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5602019213\",\n        \"sha256\": \"f9a8a35fb486027628679fe76c31d8bab1606c85d4635b3b31fdfe128fe4617a\"\n      },\n      {\n        \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5600600067\",\n        \"sha256\": \"a73638ab595370177bca7f08b7898dc2c11dbcaa3a0172d31481dc45093c76bf\",\n        \"body_equal\": true,\n        \"marker_equal\": true\n      }\n    ],\n    \"scope\": \"Exact approved narrow CI unblock only\",\n    \"deliverable\": \"Independently accepted exact-head CI candidate or specific evidence-backed blocker; operational USE remains separate\",\n    \"completion_evidence\": \"Plan+gate+candidate raw evidence+consumer verdict+event ledger+CI19/fullsuite+independent IG\",\n    \"blocking\": false\n  }\n}\n```",
    "user": {
      "login": "watchout",
      "id": 1510239,
      "node_id": "MDQ6VXNlcjE1MTAyMzk=",
      "avatar_url": "https://avatars.githubusercontent.com/u/1510239?v=4",
      "gravatar_id": "",
      "url": "https://api.github.com/users/watchout",
      "html_url": "https://github.com/watchout",
      "followers_url": "https://api.github.com/users/watchout/followers",
      "following_url": "https://api.github.com/users/watchout/following{/other_user}",
      "gists_url": "https://api.github.com/users/watchout/gists{/gist_id}",
      "starred_url": "https://api.github.com/users/watchout/starred{/owner}{/repo}",
      "subscriptions_url": "https://api.github.com/users/watchout/subscriptions",
      "organizations_url": "https://api.github.com/users/watchout/orgs",
      "repos_url": "https://api.github.com/users/watchout/repos",
      "events_url": "https://api.github.com/users/watchout/events{/privacy}",
      "received_events_url": "https://api.github.com/users/watchout/received_events",
      "type": "User",
      "user_view_type": "public",
      "site_admin": false
    },
    "author_association": "OWNER",
    "html_url": "https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5602974560",
    "issue_url": "https://api.github.com/repos/watchout/agent-comms-mcp/issues/940"
  },
  {
    "id": 5604405614,
    "body": "<!-- shirube-v3:control-handoff:CH-CTO-963-CI-ADMISSION-IMPLEMENTATION-20260909-001 -->\n# Exact implementation handoff — PR963 CI unblock\n\n独立Design Flow gen2 PASSを受領済み。承認済み47paths・予定7filesの実装を既存担当へ渡します。まず実測付きclean candidateを返し、独立consumer確認後に限り指定CI操作へ進む。実装許可はReady・merge・本番適用許可ではありません。\n\n```yaml\nschema_version: \"shirube-v3/control_handoff/v1\"\nhandoff_id: \"CH-CTO-963-CI-ADMISSION-IMPLEMENTATION-20260909-001\"\ncontrol_source: \"https://github.com/watchout/agent-comms-mcp/issues/940\"\ncell:\n  id: \"CELL-AUN-940-NARROW-USE-CORRECTION-20260908-001\"\n  cell_type: \"product\"\n  risk_class: \"R4\"\n  goal: \"全体の開発高速チームの構築を成立させる\"\n  non_scope:\n    - \"Ready/merge/auto-merge/deploy and merge-enablinglabels\"\n    - \"liveDB/schema/roles/profile/provider/queue/send/claim/restart/launchctl/TUIeffects\"\n    - \"detectorrewrites/detection-avoidancecode, fakeR3/oldcell, requiredcheckorstandingauthorizationweakening\"\n    - \"outside47paths productedits, unapproveddesignsemantics, private-sourcepublication, newagents/monitors\"\nrepository:\n  name: \"watchout/agent-comms-mcp\"\n  pr: 963\n  base_sha: \"0f772883db6f3b50772d3e4b82ce47795091f0a9\"\n  origin_head_sha: \"565583c25963b7dfa9b4445543967d372091b336\"\nlifecycle_state: \"READY_FOR_IMPLEMENTATION\"\nphase: \"I\"\npr_role: \"implementation\"\ncompletes_cell: false\nexecution_context:\n  from:\n    agent_id: \"codex-cto\"\n    active_function: \"orchestration_controller\"\n  to:\n    agent_id: \"codex-cto/gen4_validation\"\n    active_function: \"implementation_executor\"\nowner_decision_refs:\n  -\n    url: \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5602974560\"\n    sha256: \"c64781ebc64f72b0191fb32e85cd87c96bcfa26eba56d5582cc8e1679cb3ff73\"\ndesign_sha256: \"19e6880d91c2675277c47fe30b993c813c2afa8727d2c360560a23b7eb204b06\"\nproduct_design_canonical_sha256: \"880b99e5514f9791968ba8971e9d526b59173732986c12a54e8db04413f1972e\"\nworkflow_supply:\n  scope: \"CI_TEST_SUPPLY_ONLY\"\n  workflow_paths:\n    - \".github/workflows/pr-checks.yml\"\n  candidate_binding: \"exact-event-head independent shirube_consumer_verdict on PR963\"\n  checker_agent: \"codex-cto/repair_independent_review\"\n  maker_agent: \"codex-cto/gen4_validation\"\n  publisher: \"watchout\"\n  bounds:\n    new_changed_input_candidates: 2\n    normal_pushes: 2\n    pr_body_updates: 1\n    breaking_change_verified_label_applications: 1\n    additional_Layer0_run_starts: 4\n    CI_events_included:\n      - \"edited\"\n      - \"labeled\"\n      - \"synchronize\"\n    manual_reruns: 0\n    unchanged_resubmissions: 0\n    new_agents: 0\n    monitors: 0\n    product_design_generations: 0\n    expiry: \"2026-09-11T00:00:00Z\"\nallowed_paths:\n  - \"docs/SSOT.md\"\n  - \"docs/agent-com-message-queue-spec.md\"\n  - \"docs/design/aun-bounded-admission.md\"\n  - \"db/migrations/2026-09-08-queue-bounded-admission.up.sql\"\n  - \"db/migrations/2026-09-08-queue-bounded-admission.down.sql\"\n  - \"db/migrate.ts\"\n  - \"db/migrate-sqlite.ts\"\n  - \"core/queue-admission.ts\"\n  - \"bin/aun/admission.ts\"\n  - \"bin/aun.ts\"\n  - \"cli/index.ts\"\n  - \"server.ts\"\n  - \"bin/aun/receive.ts\"\n  - \"core/queue-work.ts\"\n  - \"bin/aun/run-queue-work.ts\"\n  - \"core/state-daemon/index.ts\"\n  - \"core/state-daemon/types.ts\"\n  - \"bin/state-daemon.ts\"\n  - \"core/state-daemon/queue-work-activation-plan.ts\"\n  - \"core/claim-ttl.ts\"\n  - \"core/inbox-cursor.ts\"\n  - \"core/outbound-projection.ts\"\n  - \"adapters/outbound-consumer.ts\"\n  - \"scripts/state-daemon-launchagent.ts\"\n  - \"core/state-daemon/launchagent.ts\"\n  - \"tests/contract/test_queue_bounded_admission.test.ts\"\n  - \"tests/contract/test_queue_bounded_admission_postgres.test.ts\"\n  - \"tests/contract/test_queue_bounded_retry.test.ts\"\n  - \"tests/contract/test_queue_bounded_use_trace.test.ts\"\n  - \"tests/contract/test_aun_targeted_receive.test.ts\"\n  - \"tests/contract/test_aun_targeted_receive_pg.test.ts\"\n  - \"tests/contract/test_aun_receive_wrapper.test.ts\"\n  - \"tests/queue-work.test.ts\"\n  - \"tests/run-queue-work-plan.test.ts\"\n  - \"tests/state-daemon-queue-work-scheduler.test.ts\"\n  - \"tests/cli-fail-skip-reclaim.test.ts\"\n  - \"tests/outbound-consumer.test.ts\"\n  - \"tests/outbound-projection.test.ts\"\n  - \"tests/state-daemon-queue-work-activation-plan.test.ts\"\n  - \"tests/contract/state-daemon/test_launchagent_restore.test.ts\"\n  - \"tests/state-daemon-launchagent-fleet-mode.test.ts\"\n  - \"tests/db-adapter.test.ts\"\n  - \".github/workflows/pr-checks.yml\"\n  - \"adapters/discord.ts\"\n  - \"scripts/shirube-current-overlay-check.mjs\"\n  - \"tests/shirube-current-overlay-check.test.ts\"\n  - \"docs/shirube/README.md\"\nforbidden_paths:\n  - \"scripts/detect-breaking-changes.sh\"\n  - \"scripts/lib/cell-conformance.mjs\"\n  - \".shirube/**\"\n  - \"AGENTS.md\"\n  - \"package.json\"\n  - \"bun.lock\"\n  - \"secrets/**\"\n  - \".env*\"\nforbidden_operations:\n  - \"Ready/merge/auto-merge/deploy and merge-enablinglabels\"\n  - \"liveDB/schema/roles/profile/provider/queue/send/claim/restart/launchctl/TUIeffects\"\n  - \"detectorrewrites/detection-avoidancecode, fakeR3/oldcell, requiredcheckorstandingauthorizationweakening\"\n  - \"outside47paths productedits, unapproveddesignsemantics, private-sourcepublication, newagents/monitors\"\nstop_conditions:\n  - \"Missing independent DG or actual I publication\"\n  - \"Head/base/source/authority mismatch\"\n  - \"Consumer or required fixture failure\"\n  - \"Outside approved paths/semantics\"\n  - \"Event/candidate/expiry bound exhausted\"\nrequired_checks:\n  - \"D2 deterministic two-process/crash owner-recovery subcases within BA-CORE-F06; no new formal ID\"\n  - \"Supplemental overlay and actual restore CLI subprocess tests\"\n  - \"Local15/private2 on each clean candidate\"\n  - \"Existing Layer0 CI19 and unfiltered full suite\"\n  - \"Independent consumer receipt before label/optional push\"\n  - \"Independent full implementation gate and actual raw same-candidate join\"\n  - \"DG-R1 actual empty-main initialization/journal/crash recovery inside existing F06; DG-R2 collection-phase import and restore2/3 child outcomes, no test reduction\"\nrequired_evidence:\n  - \"Exact B/C/tree/diff/test hashes and sanitized raw logs/JUnit\"\n  - \"Canonical comment body/YAML digests and API identity readback\"\n  - \"Maker-external consumer verdict for exact current head\"\n  - \"Every edited/labeled/synchronize event head/run/attempt recorded including FAIL\"\n  - \"Frozen gen5 21 IDs, USE01–09 unchanged; applied/use pending\"\n  - \"D2 owner lock/receipt integrity, process-end/busy/crash recovery evidence and disclosed host-local reap.sqlite main and engine-owned -journal effects; no SQLite queue-backend admission\"\nacceptance:\n  - \"CI admission is limited to this repo/PR/cell/R4/OD and exact consumer-bound candidate\"\n  - \"All formal21 outcomes execute PASS across CI19/private2; local15 retained\"\n  - \"No merge/live/operational claim\"\nexpires_at: \"2026-09-11T00:00:00Z\"\nnext_action:\n  owner_agent: \"codex-cto/gen4_validation\"\n  owner_function: \"implementation_executor\"\n  action: \"After actual independent DG and this matching published I, implement the seven planned amendment files; supply consumer evidence and execute bounded PR963 event sequence, then return all raw evidence\"\n  handoff_method: \"Immutable #940 canonical handoff and existing native agent delivery\"\n  input_refs:\n    - \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5602974560\"\n    - \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5602992246\"\n    - \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5600600067\"\n    - \"sha256:19e6880d91c2675277c47fe30b993c813c2afa8727d2c360560a23b7eb204b06\"\n    - \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5603218866\"\n    - \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5603776869\"\n    - \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5603745316\"\n  scope: \"Exact OD47 paths; narrow CI amendment; no merge/live/Ready/extra events\"\n  deliverable: \"Current-head consumer/CI/independent IG evidence or one typed finding\"\n  completion_evidence: \"Actual tests/raw API/file readbacks and independent same-candidate join; no claimed operation\"\n  blocking: true\n  stop_reason: \"required_executor_and_independent_evidence_pending\"\n  expiry: \"2026-09-11T00:00:00Z\"\ndisposition_refs:\n  -\n    url: \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5603218866\"\n    sha256: \"8c69ba1f3de9608398571938b5e86ad474be7e9c324e21134a4e9f45796dc0af\"\n  -\n    url: \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5603776869\"\n    sha256: \"45a7282b358f76b9c3804e777aa302369a6436c37dfef3edcd89199845eda61b\"\namendment_generation: 2\namendment_baseline:\n  generation: 1\n  canonical_sha256: \"c4af7f3748e31e28182b32ad1281b6d5d6c69665f782d858f536f8a9305ef1fc\"\n  gate_ref:\n    url: \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5603745316\"\n    sha256: \"642a82b292f96559a3330681a982298fa8684e2a810327b7add04e182171ec1f\"\n```\n\n## Bound execution supply and explicit inherited replacements\n\n```json\n{\n  \"schema_version\": \"cto-bounded-implementation-supply/v1\",\n  \"handoff_id\": \"CH-CTO-963-CI-ADMISSION-IMPLEMENTATION-20260909-001\",\n  \"owner_decision_ref\": {\n    \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5602974560\",\n    \"sha256\": \"c64781ebc64f72b0191fb32e85cd87c96bcfa26eba56d5582cc8e1679cb3ff73\"\n  },\n  \"amendment_candidate_ref\": {\n    \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5604308084\",\n    \"sha256\": \"318c223c14d0d5a1b56b08b6888fcfc5084da7c732b66e27d34651c41c5b30e8\",\n    \"body_equal\": true,\n    \"marker_equal\": true\n  },\n  \"amendment_generation\": 2,\n  \"amendment_raw_sha256\": \"596872ae253e809f7ad8a722e5438c84e7353e48943790787c0fdc1486419542\",\n  \"amendment_canonical_sha256\": \"e538c46be0c8916449dc927b08e0793a3a5a19b8c2228b33b6af0b02043cb208\",\n  \"amendment_files\": [\n    {\n      \"path\": \"/Users/yuji/Developer/codex/control-artifacts/cto-learning/20260907/aun-minimum-use-correction-20260908/implementation/ci-admission-amendment/gen2/design.md\",\n      \"sha256\": \"19e6880d91c2675277c47fe30b993c813c2afa8727d2c360560a23b7eb204b06\"\n    },\n    {\n      \"path\": \"/Users/yuji/Developer/codex/control-artifacts/cto-learning/20260907/aun-minimum-use-correction-20260908/implementation/ci-admission-amendment/gen2/canonical-handoff.payload.json\",\n      \"sha256\": \"a24cfaf3102367cf2e91d916e966ae1b41134eb800c24a750b42c48a6ddea919\"\n    },\n    {\n      \"path\": \"/Users/yuji/Developer/codex/control-artifacts/cto-learning/20260907/aun-minimum-use-correction-20260908/implementation/ci-admission-amendment/gen2/pack.json\",\n      \"sha256\": \"596872ae253e809f7ad8a722e5438c84e7353e48943790787c0fdc1486419542\"\n    },\n    {\n      \"path\": \"/Users/yuji/Developer/codex/control-artifacts/cto-learning/20260907/aun-minimum-use-correction-20260908/implementation/ci-admission-amendment/gen2/source-readbacks.json\",\n      \"sha256\": \"4921f7db0241fe039401a25bd77e8c0331d6c993b950e76a4414836f44a97b9b\"\n    },\n    {\n      \"path\": \"/Users/yuji/Developer/codex/control-artifacts/cto-learning/20260907/aun-minimum-use-correction-20260908/implementation/ci-admission-amendment/gen2/validation.json\",\n      \"sha256\": \"760d39b53520d0ba165057fd69a76be0475981b9c77e9f41f723d2fbbce577ee\"\n    }\n  ],\n  \"product_gen5_design_ref\": {\n    \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5600405241\",\n    \"sha256\": \"3fab0f915c6e4e6c577c1963463fb46bb7e68eaf8291a652381e036fe9fb63f3\"\n  },\n  \"product_gen5_independent_DG_ref\": {\n    \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5600533790\",\n    \"sha256\": \"f82e3a215f0341cc0e012609dd761a4bfdc7bfd67673d026f6fd9a872f9d035d\",\n    \"body_equal\": true,\n    \"marker_equal\": true\n  },\n  \"predecessor_I_ref\": {\n    \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5600600067\",\n    \"sha256\": \"a73638ab595370177bca7f08b7898dc2c11dbcaa3a0172d31481dc45093c76bf\",\n    \"body_equal\": true,\n    \"marker_equal\": true\n  },\n  \"static_findings_disposition_ref\": {\n    \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5603218866\",\n    \"sha256\": \"8c69ba1f3de9608398571938b5e86ad474be7e9c324e21134a4e9f45796dc0af\"\n  },\n  \"execution_context\": {\n    \"from\": {\n      \"agent_id\": \"codex-cto\",\n      \"active_function\": \"orchestration_controller\"\n    },\n    \"to\": {\n      \"agent_id\": \"codex-cto/gen4_validation\",\n      \"active_function\": \"implementation_executor\"\n    }\n  },\n  \"current_scope\": \"Complete existing owner-approved nonlive PR963 CI unblock. First implement/test/clean-commit one candidate and return raw proof to controller for independent consumer verification. No self-gate. Controller immediately routes result; do not await generic owner ACK.\",\n  \"worktree\": {\n    \"path\": \"/Users/yuji/Developer/.worktrees/agent-comms-mcp-bounded-admission-20260908\",\n    \"branch\": \"codex/aun-bounded-admission-20260908\",\n    \"base_sha\": \"0f772883db6f3b50772d3e4b82ce47795091f0a9\",\n    \"origin_head_sha\": \"565583c25963b7dfa9b4445543967d372091b336\",\n    \"origin_tree\": \"ec0d7c789ad67d069a1b568c17ae60bf89fdea55\",\n    \"setup\": \"Resume existing CLEAN exact C0 worktree. This REPLACES the old gen5 29-file WIP setup/pins. No recreate/rebase/reset/base refresh; preserve unfamiliar changes and report exact drift.\"\n  },\n  \"planned_paths\": [\n    \"scripts/shirube-current-overlay-check.mjs\",\n    \"tests/shirube-current-overlay-check.test.ts\",\n    \"docs/shirube/README.md\",\n    \"tests/contract/state-daemon/test_launchagent_restore.test.ts\",\n    \"core/queue-admission.ts\",\n    \"tests/contract/test_queue_bounded_retry.test.ts\",\n    \"docs/design/aun-bounded-admission.md\"\n  ],\n  \"allowed_product_paths\": [\n    \"docs/SSOT.md\",\n    \"docs/agent-com-message-queue-spec.md\",\n    \"docs/design/aun-bounded-admission.md\",\n    \"db/migrations/2026-09-08-queue-bounded-admission.up.sql\",\n    \"db/migrations/2026-09-08-queue-bounded-admission.down.sql\",\n    \"db/migrate.ts\",\n    \"db/migrate-sqlite.ts\",\n    \"core/queue-admission.ts\",\n    \"bin/aun/admission.ts\",\n    \"bin/aun.ts\",\n    \"cli/index.ts\",\n    \"server.ts\",\n    \"bin/aun/receive.ts\",\n    \"core/queue-work.ts\",\n    \"bin/aun/run-queue-work.ts\",\n    \"core/state-daemon/index.ts\",\n    \"core/state-daemon/types.ts\",\n    \"bin/state-daemon.ts\",\n    \"core/state-daemon/queue-work-activation-plan.ts\",\n    \"core/claim-ttl.ts\",\n    \"core/inbox-cursor.ts\",\n    \"core/outbound-projection.ts\",\n    \"adapters/outbound-consumer.ts\",\n    \"scripts/state-daemon-launchagent.ts\",\n    \"core/state-daemon/launchagent.ts\",\n    \"tests/contract/test_queue_bounded_admission.test.ts\",\n    \"tests/contract/test_queue_bounded_admission_postgres.test.ts\",\n    \"tests/contract/test_queue_bounded_retry.test.ts\",\n    \"tests/contract/test_queue_bounded_use_trace.test.ts\",\n    \"tests/contract/test_aun_targeted_receive.test.ts\",\n    \"tests/contract/test_aun_targeted_receive_pg.test.ts\",\n    \"tests/contract/test_aun_receive_wrapper.test.ts\",\n    \"tests/queue-work.test.ts\",\n    \"tests/run-queue-work-plan.test.ts\",\n    \"tests/state-daemon-queue-work-scheduler.test.ts\",\n    \"tests/cli-fail-skip-reclaim.test.ts\",\n    \"tests/outbound-consumer.test.ts\",\n    \"tests/outbound-projection.test.ts\",\n    \"tests/state-daemon-queue-work-activation-plan.test.ts\",\n    \"tests/contract/state-daemon/test_launchagent_restore.test.ts\",\n    \"tests/state-daemon-launchagent-fleet-mode.test.ts\",\n    \"tests/db-adapter.test.ts\",\n    \".github/workflows/pr-checks.yml\",\n    \"adapters/discord.ts\",\n    \"scripts/shirube-current-overlay-check.mjs\",\n    \"tests/shirube-current-overlay-check.test.ts\",\n    \"docs/shirube/README.md\"\n  ],\n  \"allowed_control_paths\": [\n    \"/Users/yuji/Developer/codex/control-artifacts/cto-learning/20260907/aun-minimum-use-correction-20260908/implementation/ci-unblock/**\"\n  ],\n  \"inheritance\": \"Full published gen5 I and predecessor test/private-input construction apply, with explicit replacements below; their past consumed attempts remain historical, not erased. The canonical reviewed payload is unchanged. Its lifecycle READY_FOR_IMPLEMENTATION refers to this artifact, NOT GitHub Ready or live authorization.\",\n  \"replacements\": [\n    \"Exactly47 owner paths replace old44; seven planned edits only unless a concrete in-scope returned implementation finding requires another already-approved path.\",\n    \"Exact clean originC0 565583c replaces precommitWIP source state. Frozen productgen5 fivefiles/23predicates/21formal IDs/USE01..09 remain byte/semantic bound, not productgen6.\",\n    \"Current amendmentgen2 design/payload replace failed amendmentgen1; priorFAIL and all original artifact bytes retained.\",\n    \"Old2reviewedheads already consumed. New OD grants at most2 additional changed-input candidates/2normalpushes,1PRbody,1breaking-change-verified label,4additional Layer0starts INCLUDINGedited/labeled/synchronize; replaces oldoneCIperhead/labelban only for this exact bounded sequence. No allowance reset or extra D2attempt.\",\n    \"Exact independent consumer evidence must precede all E1-E3 events; maker cannot author consumer verdict or selflabel as proof. One approved label is only mechanical execution of published independent verdict.\",\n    \"Detector source/detection semantics/requiredchecks/conditions/thresholds/PG16+17services remain unchanged; no labelotherthanexplicitone, no fakeR3/oldcell.\",\n    \"D2 adds local SQLite engine main/journal file lifecycle inside same F06/DR08; no SQLite queue backend or live authority. R1/R2 actual-first-I fixture commitments must be executed, not designPASS substituting.\"\n  ],\n  \"ordered_work\": [\n    \"Independently read published OD/DG/I, exact files and current source/SSOT/AGENTS. Verify GithubPR openDraft C0/B labels[], localC0/tree clean, canonicalpayloadhash, all fivegen5 inputs and exactgen2 inputs. Inspect ownedfixture/privatepath permissions, endpoints and Bun/Ruby/PG17 prerequisites.\",\n    \"Update in-scope HOW docs before behavior; implement seven planned files to exact gen2design, preserving original rules. No product-level governance rewrite.\",\n    \"Construct actual A09 two-process named barriers/crash/reopen/invalid controls inside F06, and static-import restore2/3 actual CLI outcomes; run incremental changed-input tests without hiding real FAIL or zero-selectionINVALID. No added formalID/removedsubcase.\",\n    \"Produce clean committed C1 (normal additive commit, no amend). Capture B/C/tree/binarydiff/path/fourtest hashes. Run exact supplemental overlay/restore regression and standalone, local15/private2 with actual private input/candidate binding. Record all selected/executed/assertion/subcases, rawlogs/JUnitSHA and unchanged detector actual findings.\",\n    \"Return C1 local evidence and raw paths immediately to root for independent consumer gate. STOP GitHub body/push/label actions until actual root-published exact-C1 consumer receipt/readback arrives. This is maker-checker coordination, not a new owner approval.\",\n    \"After samecandidate independent receipt is delivered, implementation_executor owns E1 bodyonce, E2pushonce, E3oneverifiedlabel with exact fresh prerequisites and event/run ledger per design§5. No gate-function mutations. Record actual eventhead/run/attempt before next event; prior34350598901FAIL retained. No manualrerun/cancel/unlabel/body2.\",\n    \"Obtain actual required Layer0 CI19/unfilteredfullsuite/samecandidatecheckout evidence. Return immediately for full independent IG/rawjoin. If one true in-scope finding, use only remaining C2 after controller exact disposition, repeat fulllocal/private/supplemental and new independentconsumer BEFORE E4push. No extraevents/unchangedretry.\",\n    \"Return updated nonlive futureapplicationproposal including new SQLite main+journal and exactversion/config/DDL/role/legacywriter/rollback/normal2task proof. No live execution and no claim USE achieved.\"\n  ],\n  \"test_commands_source\": {\n    \"gen2_design\": {\n      \"url\": \"/Users/yuji/Developer/codex/control-artifacts/cto-learning/20260907/aun-minimum-use-correction-20260908/implementation/ci-admission-amendment/gen2/design.md\",\n      \"sha256\": \"19e6880d91c2675277c47fe30b993c813c2afa8727d2c360560a23b7eb204b06\"\n    },\n    \"sections\": \"§4/4a/5 exact supplied commands, fixture cuts, env bounds and event order; explicit constructed owned paths, no unresolved placeholder execution\",\n    \"inherited\": {\n      \"authoritative_commands\": \"Exact gen5 design.md sections3A-E and4, private-inputs.json and delivery_handoff.construction_supply. All predecessor isolated fixture/dependency/source/check boundaries remain. Preserve real FAIL vs INVALID.\",\n      \"local\": \"Fresh owned PG17 cluster/socket from mktemp; explicit DATABASE_URL, AGENT_COM_TEST_DATABASE_URL, AGENT_COM_BOUNDED_PG17_TEST_DATABASE_URL and unique *_test DB identities. No inherited /tmp/live fallback. Stage=local17 selects public15; stage=private selects actual F08/F10 only using owned private root/control and clean candidate C. Raw JUnit15+2=17; all subcases and assertion counts mandatory. Existing helper explicit environment argument avoids global env swapping. Stop only exact owned PG17 cluster; preserve logs.\",\n      \"ci\": \"Same existing required layer0 and PG16 service; gated disposable PG17 host5433. Explicit version/endpoint/migration checks blocking. Stage=ci, unfiltered bun test --timeout 30000 --reporter=junit --reporter-outfile=bounded-full.xml. Exact public19 each once/no skip/fail/error; private2 not selected, not zero/skip/pass fiction. Existing unrelated skips separately reported. Aggregate cannot undo upstream failures. Only sanitized public CI logs/JUnit/identity metadata uploaded.\",\n      \"evidence\": \"Candidate C exactbase/head/tree/diff/44pathinventory and4testfilehashes,5designfile hashes/canonical/input manifests, selected/executed/assertion/subcase counts, stage commands/exits/version/endpoints, raw logs/JUnit digests, PR/check IDs/run attempts and actual checkout/API subject identity. Private2 raw evidence retained under owned700private root and available to same independent checker. Sanitized public receipt only references hashes/identities/independentprivate receipt. Independent checker must compute actual files/API and enforce gen5 exact21union/local17 plus upstreamCI and maker!=checker; no maker-produced booleans establish truth.\",\n      \"invalid_vs_fail\": \"Missing prerequisites/zero selection is INVALID and nonzero/not PASS. A failed assertion is FAIL even if baseline reproduces it. No threshold relaxation, detector/label bypass, unsupported-case substitution or hidden unchanged rerun.\",\n      \"test_effect_boundary\": \"Isolated test cluster creation/migration/fixture roles/data, deterministic fixture workers/providers, child CLI processes and owned test-cluster cleanup are allowed. No connection or mutation to production agent_comms, no real notify/claim/queue, no live provider call, server/daemon startup or launchctl action.\",\n      \"private_supply\": \"Exact nine ADF gitobject files at66648e7b4dc71941936a7f052c3b80c78e7ce46d plus locked Commander13.1.0 installed with fixed --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --userconfig=/dev/null --registry=https://registry.npmjs.org command in private root; verify bytes before/after. Actual CLI registration adapter/Bun resolution, no mock/private core public copy. F10 exact DesignFlow seven-file package+all admitted pack/raw sources, typed whitelist acquisition rather than eval readback commands; existing host read-only auth may acquire immutable inputs but never passes credentials to fixture child or CI. Missing/raw-changed sources INVALID/nonzero. Full hashes and generation-pinned negative checks per design.\"\n    }\n  },\n  \"runtime_and_private_boundaries\": \"Isolated test cluster creation/migration/fixture roles/data, deterministic fixture workers/providers, child CLI processes and owned test-cluster cleanup are allowed. No connection or mutation to production agent_comms, no real notify/claim/queue, no live provider call, server/daemon startup or launchctl action. Exact nine ADF gitobject files at66648e7b4dc71941936a7f052c3b80c78e7ce46d plus locked Commander13.1.0 installed with fixed --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --userconfig=/dev/null --registry=https://registry.npmjs.org command in private root; verify bytes before/after. Actual CLI registration adapter/Bun resolution, no mock/private core public copy. F10 exact DesignFlow seven-file package+all admitted pack/raw sources, typed whitelist acquisition rather than eval readback commands; existing host read-only auth may acquire immutable inputs but never passes credentials to fixture child or CI. Missing/raw-changed sources INVALID/nonzero. Full hashes and generation-pinned negative checks per design.\",\n  \"budget\": {\n    \"new_changed_input_candidates\": 2,\n    \"normal_pushes\": 2,\n    \"pr_body_updates\": 1,\n    \"breaking_change_verified_label_applications\": 1,\n    \"additional_Layer0_run_starts\": 4,\n    \"CI_events_included\": [\n      \"edited\",\n      \"labeled\",\n      \"synchronize\"\n    ],\n    \"manual_reruns\": 0,\n    \"unchanged_resubmissions\": 0,\n    \"new_agents\": 0,\n    \"monitors\": 0,\n    \"product_design_generations\": 0,\n    \"expiry\": \"2026-09-11T00:00:00Z\"\n  },\n  \"budget_usage_at_dispatch\": {\n    \"additional_candidates\": 0,\n    \"normal_pushes\": 0,\n    \"pr_body_updates\": 0,\n    \"verified_label_applications\": 0,\n    \"additional_Layer0_starts\": 0\n  },\n  \"forbidden\": [\n    \"Ready/merge/auto-merge/deploy and merge-enablinglabels\",\n    \"liveDB/schema/roles/profile/provider/queue/send/claim/restart/launchctl/TUIeffects\",\n    \"detectorrewrites/detection-avoidancecode, fakeR3/oldcell, requiredcheckorstandingauthorizationweakening\",\n    \"outside47paths productedits, unapproveddesignsemantics, private-sourcepublication, newagents/monitors\",\n    \"Edit forbidden path: scripts/detect-breaking-changes.sh\",\n    \"Edit forbidden path: scripts/lib/cell-conformance.mjs\",\n    \"Edit forbidden path: .shirube/**\",\n    \"Edit forbidden path: AGENTS.md\",\n    \"Edit forbidden path: package.json\",\n    \"Edit forbidden path: bun.lock\",\n    \"Edit forbidden path: secrets/**\",\n    \"Edit forbidden path: .env*\",\n    \"No rebase/reset/amend/forcepush/auto-base-refresh/emptycommit/manualrerun/unchangedretry/extraPRmutation\",\n    \"Do not edit frozen gen1-gen5 product or either amendment generation, skills/AGENTS/validators; output new I evidence only\",\n    \"No local unfiltered fullsuite without existing PG16 fixture authority; no install/startDocker or inventPG16 lane\",\n    \"No private raw source or fullprivatefixture logs in public code/CI/GitHub\"\n  ],\n  \"stop_conditions\": [\n    \"Missing independent DG or actual I publication\",\n    \"Head/base/source/authority mismatch\",\n    \"Consumer or required fixture failure\",\n    \"Outside approved paths/semantics\",\n    \"Event/candidate/expiry bound exhausted\",\n    \"Unexpected head/base/body/label or unrelated worktree mutation\",\n    \"Evidence inaccessible/unsafe ownedcluster/privateinput prerequisites\",\n    \"In-scope returned finding needs controller disposition; genuinely new authority returns once\",\n    \"No progress3times or expiry9/11T00Z; preserve evidence, no successor loops\"\n  ],\n  \"return_contract\": {\n    \"to\": \"codex-cto/orchestration_controller\",\n    \"first_milestone\": \"Actual clean C1 + supplemental/local17 raw evidence, ready for existing independent consumer checker; no GitHub events yet\",\n    \"terminal\": \"CI/fullsuite/rawsubject proof for full independent IG or exact actionable blocker\",\n    \"usage\": \"USE01..09 pending, accepted actualnormaltasks0/2; no AUN/TEAM operationalPASS\",\n    \"privacy\": \"Sanitized public receipts only; existing independentchecker gets actual private files locally\"\n  },\n  \"next_action\": {\n    \"owner\": \"codex-cto/gen4_validation\",\n    \"owner_agent\": \"codex-cto/gen4_validation\",\n    \"owner_function\": \"implementation_executor\",\n    \"required_function\": \"implementation_executor\",\n    \"action\": \"Implement exact admitted amendment; deliver clean measured C1 for independent consumer gate, then continue delegated event sequence on published receipt\",\n    \"delivery\": \"Native existing-agent result plus new ci-unblock evidence directory; root coordinates/publishes verified gate receipts\",\n    \"handoff_method\": \"This canonical published I plus existing native followup_task\",\n    \"input_refs\": [\n      {\n        \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5602974560\",\n        \"sha256\": \"c64781ebc64f72b0191fb32e85cd87c96bcfa26eba56d5582cc8e1679cb3ff73\"\n      },\n      {\n        \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5604308084\",\n        \"sha256\": \"318c223c14d0d5a1b56b08b6888fcfc5084da7c732b66e27d34651c41c5b30e8\",\n        \"body_equal\": true,\n        \"marker_equal\": true\n      },\n      {\n        \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5600600067\",\n        \"sha256\": \"a73638ab595370177bca7f08b7898dc2c11dbcaa3a0172d31481dc45093c76bf\",\n        \"body_equal\": true,\n        \"marker_equal\": true\n      },\n      {\n        \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5603218866\",\n        \"sha256\": \"8c69ba1f3de9608398571938b5e86ad474be7e9c324e21134a4e9f45796dc0af\"\n      },\n      {\n        \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5604397915\",\n        \"sha256\": \"8dc743d83ae7417a6896f10dd12fe3f877004f6c04612117f919412500d7fda0\",\n        \"body_equal\": true,\n        \"marker_equal\": true,\n        \"author\": \"watchout\",\n        \"author_association\": \"OWNER\",\n        \"issue_url\": \"https://api.github.com/repos/watchout/agent-comms-mcp/issues/940\"\n      }\n    ],\n    \"scope\": \"Approved47paths/sevenplanned nonlive amendment/2newcandidates/4CIstarts\",\n    \"deliverable\": \"Measured scoped candidate and complete exact-head independent-consumer/CI evidence\",\n    \"completion_evidence\": \"Actual hashes/rawJUnit/API/independent acceptance; operational outcome remainsnotcomplete\",\n    \"blocking\": false,\n    \"retry_policy\": \"Changed-input incremental construction allowed;2newcandidate cap and onein-scope returnedfindingfix, no selfsuccessor; oldFAIL retained\",\n    \"expiry\": \"2026-09-11T00:00:00Z\",\n    \"escalation\": \"codex-cto/orchestration_controller; owner only for new authority\",\n    \"authorized_exhaustion_disposition\": \"Return precise failedpredicate/evidence/remainingcapacity once; stop affected effects and retain artifacts, root outcome uncompleted\"\n  },\n  \"independent_amendment_DG_ref\": {\n    \"url\": \"https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5604397915\",\n    \"sha256\": \"8dc743d83ae7417a6896f10dd12fe3f877004f6c04612117f919412500d7fda0\",\n    \"body_equal\": true,\n    \"marker_equal\": true,\n    \"author\": \"watchout\",\n    \"author_association\": \"OWNER\",\n    \"issue_url\": \"https://api.github.com/repos/watchout/agent-comms-mcp/issues/940\"\n  },\n  \"independent_DG_consumed\": \"Actual independentPASS all7/12/9, no findings; implementation fixtures NOT_RUN.\",\n  \"canonical_rendering\": {\n    \"payload_sha256\": \"a24cfaf3102367cf2e91d916e966ae1b41134eb800c24a750b42c48a6ddea919\",\n    \"actual_rendered_yaml_sha256\": \"340b75b3c6927d397502f94aa01209482260fb44042227d483fb8a3659d98ee0\",\n    \"rendering_note\": \"Root ordinary YAML rendering differs in formatting from author preview; actual unchanged extractor/normalizer parsed object equals exact reviewedpayload, missingfields0. This bytehash, not authorpreviewyamlhash, is the publication.\"\n  }\n}\n```",
    "user": {
      "login": "watchout"
    },
    "author_association": "OWNER",
    "html_url": "https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5604405614",
    "issue_url": "https://api.github.com/repos/watchout/agent-comms-mcp/issues/940"
  }
];
const ciBase="0f772883db6f3b50772d3e4b82ce47795091f0a9";
const ciOrigin="565583c25963b7dfa9b4445543967d372091b336";
function runBoundedGate(mutate:(x:any)=>void=()=>{}) {
  const git=(...a:string[])=>spawnSync("git",a,{cwd:repoRoot,encoding:"utf8"});
  const exact=git("rev-parse","HEAD").stdout.trim(),tree=git("rev-parse",exact+"^{tree}").stdout.trim();
  const files=git("diff","--name-only",ciBase+"..."+exact).stdout.trim().split("\n");
  const diff=git("diff","--binary",ciBase+"..."+exact).stdout;
  const digest=(x:string)=>createHash("sha256").update(x).digest("hex");
  const handoff=ciAuthorityFixtures[1],od=ciAuthorityFixtures[0];
  const fields:any={schema_version:"shirube-ci-consumer-verdict/v1",target_repo:"watchout/agent-comms-mcp",target_pr:963,
    cell_id:"CELL-AUN-940-NARROW-USE-CORRECTION-20260908-001",risk_class:"R4",base_sha:ciBase,origin_head_sha:ciOrigin,
    exact_head_sha:exact,candidate_tree:tree,binary_diff_sha256:digest(diff),handoff_comment_ref:handoff.html_url,
    handoff_body_sha256:digest(handoff.body),owner_decision_ref:od.html_url,owner_decision_body_sha256:digest(od.body),
    checker_agent:"codex-cto/repair_independent_review",maker_agent:"codex-cto/gen4_validation",publisher:"watchout",
    verdict:"PASS_CONSUMER_COMPATIBILITY",restore_success_ref:"sha256:"+"1".repeat(64),restore_reject_ref:"sha256:"+"2".repeat(64),
    runtime_adapter_ref:"sha256:"+"3".repeat(64),evidence_sha256:"4".repeat(64),issued_at:"2026-09-09T00:00:00Z",expires_at:"2026-09-11T00:00:00Z"};
  const value:any={body:baseBody(fields.cell_id,"R4")+"\nWorkflow Supply: CI_TEST_SUPPLY_ONLY\ncontrol_handoff_comment_ref: "+handoff.html_url
    +"\ncontrol_handoff_body_sha256: "+digest(handoff.body),files,fields,controls:structuredClone(ciAuthorityFixtures),
    repo:"watchout/agent-comms-mcp",pr:963,base:ciBase,head:exact,draft:true,labels:[],commentAuthor:"watchout",association:"OWNER",
    commentIssue:"https://api.github.com/repos/watchout/agent-comms-mcp/issues/963",commentSuffix:"",copies:1};
  mutate(value);
  const consumerBody="<!-- shirube-v3:ci-consumer-verdict -->\n\n\x60\x60\x60yaml\nshirube_consumer_verdict:\n"
    +Object.entries(value.fields).map(([k,v])=>"  "+k+": "+(typeof v==="number"?v:JSON.stringify(v))).join("\n")+value.commentSuffix+"\n\x60\x60\x60";
  const comments=Array.from({length:value.copies},(_,n)=>({id:n+1,body:consumerBody,user:{login:value.commentAuthor},
    author_association:value.association,issue_url:value.commentIssue,html_url:"https://github.com/watchout/agent-comms-mcp/pull/963#issuecomment-"+(n+1)}));
  const dir=mkdtempSync(join(tmpdir(),"bounded-ci-admission-"));
  try {
    const event=join(dir,"event.json"),changed=join(dir,"changed.txt"),consumer=join(dir,"consumer.json"),controls=join(dir,"control.json");
    writeFileSync(event,JSON.stringify({number:value.pr,pull_request:{number:value.pr,draft:value.draft,body:value.body,labels:value.labels.map((name:string)=>({name})),
      head:{sha:value.head},base:{sha:value.base}}}));
    writeFileSync(changed,value.files.join("\n")+"\n");writeFileSync(consumer,JSON.stringify(comments));writeFileSync(controls,JSON.stringify(value.controls));
    // Test-only host preload fixes the authorization clock, not a product bypass flag.
    return spawnSync("node",["--import","data:text/javascript,Date.now=()=>Date.parse('2026-09-10T00:00:00Z')",
      "scripts/shirube-current-overlay-check.mjs","--repo",value.repo,"--event",event,
      ...(value.omitChanged?[]:["--changed-files",changed]),"--comments",consumer,"--control-comments",controls],
      {cwd:repoRoot,encoding:"utf8",timeout:15000});
  } finally {rmSync(dir,{recursive:true,force:true})}
}
describe("bounded PR963 CI supply",()=>{
  test("A01/A02/A04 exact canonical R4 current-head supply, with or without informational label",()=>{
    for(const labels of [[],["breaking-change-verified"]]){
      const r=runBoundedGate(x=>x.labels=labels);expect(r.status,r.stdout+r.stderr).toBe(0);
      expect(r.stdout).toContain('"input_mode":"offline-fixture"');
    }
  });
  test("A03/A05 canonical, ownership, scope, stale/conflicting consumer and metadata negatives",()=>{
    const cases:Array<[string,(x:any)=>void]>=[
      ["wrong repo",x=>x.repo="watchout/other"],["wrong PR",x=>x.pr=999],["wrong base",x=>x.base="f".repeat(40)],
      ["missing paths",x=>x.omitChanged=true],["extra workflow",x=>x.files.push(".github/workflows/extra.yml")],
      ["extra runtime path",x=>x.files.push("config/outside.json")],["changed-files mismatch",x=>x.files.pop()],
      ["duplicate cell",x=>x.body+="\nCELL-ID: other"],["indented duplicate cell",x=>x.body+="\n CELL-ID: other"],
      ["wrong risk",x=>x.body=x.body.replace("Risk Tier: R4","Risk Tier: R3")],
      ["wrong scope",x=>x.body=x.body.replace("Workflow Supply: CI_TEST_SUPPLY_ONLY","Workflow Supply: MERGE")],
      ["old-cell contamination",x=>x.body+="\nCELL-MCP-SHIRUBE-RAPID-LITE-PILOT-001"],
      ["OD body drift",x=>x.controls[0].body+="changed"],["OD actor",x=>x.controls[0].user.login="maker"],
      ["handoff issue",x=>x.controls[1].issue_url=x.commentIssue],["handoff owner",x=>x.controls[1].author_association="MEMBER"],
      ["handoff missing",x=>x.controls.pop()],["handoff duplicate",x=>x.controls.push(x.controls[1])],
      ["raw pin drift",x=>x.body=x.body.replace(x.fields.handoff_body_sha256,"f".repeat(64))],
      ["maker-as-checker",x=>x.fields.checker_agent=x.fields.maker_agent],["wrong consumer actor",x=>x.commentAuthor="maker"],
      ["wrong consumer association",x=>x.association="MEMBER"],["wrong consumer issue",x=>x.commentIssue=x.controls[0].issue_url],
      ["consumer stale",x=>x.fields.exact_head_sha="f".repeat(40)],["consumer missing",x=>x.copies=0],
      ["consumer duplicate",x=>x.copies=2],["consumer FAIL",x=>x.fields.verdict="FAIL_CONSUMER_COMPATIBILITY"],
      ["wrong tree",x=>x.fields.candidate_tree="f".repeat(40)],["wrong diff",x=>x.fields.binary_diff_sha256="f".repeat(64)],
      ["wrong handoff ref",x=>x.fields.handoff_comment_ref=x.fields.owner_decision_ref],
      ["expired",x=>x.fields.expires_at="2026-09-09T00:00:00Z"],["future",x=>x.fields.issued_at="2026-09-11T00:00:00Z"],
      ["expiry broadened",x=>x.fields.expires_at="2099-09-11T00:00:00Z"],["ACK-only",x=>x.fields.restore_success_ref="ACK"],
      ["array head",x=>x.fields.exact_head_sha=[x.fields.exact_head_sha]],["nested",x=>x.fields.publisher={name:"watchout"}],
      ["extra key",x=>x.fields.extra="ignored"],["duplicate key",x=>x.commentSuffix="\n  publisher: \"watchout\""],
      ["yaml alias",x=>x.commentSuffix="\n  publisher: *watchout"],["yaml tag",x=>x.commentSuffix="\n  publisher: !!str watchout"],
      ["non-draft still gated",x=>x.draft=false],
    ];
    for(const [name,mutate]of cases){const r=runBoundedGate(mutate);expect(r.status,name+"\n"+r.stdout+r.stderr).not.toBe(0)}
    console.log(JSON.stringify({subcase:"CI-AMEND-A03/A05",negative_cases:cases.length,input_mode:"offline-fixture",effect_count:0}));
  });
});

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
