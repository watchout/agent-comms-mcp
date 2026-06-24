# AUN V2/V3 Foundation Premise Implementation Handoff

IMPL-ID: IMPL-MCP-AUN-FOUNDATION-001
SPEC-ID: SPEC-MCP-AUN-V2V3-FOUNDATION-001
CELL-ID: CELL-MCP-AUN-FOUNDATION-001
Risk Tier: R2

## Scope

This implementation handoff adds the #802 foundation premise artifacts for PR #805 while preserving the AUN V2 clean rebuild design prepared for #794.

## Implemented Artifacts

- `.shirube/specs/SPEC-MCP-AUN-V2V3-FOUNDATION-001.md`
- `.shirube/cells/CELL-MCP-AUN-FOUNDATION-001.yaml`
- `.shirube/impls/IMPL-MCP-AUN-FOUNDATION-001.md`
- `.shirube/audits/AUDIT-MCP-AUN-FOUNDATION-SPEC-001.yaml`
- `.shirube/audits/AUDIT-MCP-AUN-FOUNDATION-IMPL-001.yaml`
- `.shirube/evidence/EVIDENCE-MCP-AUN-FOUNDATION-001.yaml`
- `docs/aun/v2v3-premise.md`

## Preserved #794 Design Basis

The existing #794 design documents remain the architecture basis:

- clean core plus V1 compatibility edge;
- V1 deletion and isolation map;
- baton, turn, claim, lease, fence, and typed-outcome reconciliation;
- Codex build plan and solo execution contract;
- enterprise adoption gate;
- decision backlog.

## Protected Surfaces

This Cell does not change:

- runtime code;
- MCP/tool behavior;
- queue mutation;
- state-daemon behavior;
- provider delivery;
- Discord, tmux, or TUI behavior;
- database schema or migrations;
- secrets or credentials;
- dependencies or package metadata;
- active workflows;
- branch protection, rulesets, or required checks;
- AUN activation.

## Risk Mapping

This Cell is R2 because it is planning and premise specification only.

Shirube v1 risk tiers are R0 through R3 only. Live activation is treated as R3 protected runtime activation requiring human maintainer, release owner, security owner, CTO, and operator approval.

## #801 Treatment

#801 should remain HOLD_DRAFT and future registry policy material.

It must not be marked ready or merged from this PR.

It may be revised later after the V2/V3 premise and inventory gates pass.

## Validation Plan

Run and report:

```bash
git diff --check
ruby -ryaml -e 'Dir[".shirube/**/*.yaml"].sort.each { |f| YAML.load_file(f); puts f }'
bash scripts/detect-breaking-changes.sh origin/main
```

The breaking-change script is run only if available, without modifying scripts or dependencies.

## Handoff

After push, PR #805 remains draft. The next required gate is Shirube command review and repository owner/domain-designer review. Human maintainer merge authorization is required later.
