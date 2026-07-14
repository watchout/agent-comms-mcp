# AUN K0 benchmark harness

This directory defines deterministic **plans**, not runtime benchmark results.
It never starts a daemon, connects to a production database, calls a model, or
sends through a provider.

```bash
bun benchmarks/aun-k0/cli.ts --profile A0_correctness --plan --json
bun benchmarks/aun-k0/cli.ts --profile A1_reference --plan --json
bun benchmarks/aun-k0/cli.ts --profile A2_soak --plan --json
```

Every output contains the source/tree/config/policy digests, declared database,
observed hardware dimensions, payload profile, and worker count. The canonical
`plan_digest` excludes `generated_at`, `run_id`, and observed hardware values.
All acceptance entries are emitted as `not_measured`; `behavior_proven` is
always `false` in plan mode. Future Cells own execution and measured PASS/FAIL.

Profiles:

- `A0_correctness`: contract and crash-boundary correctness plan.
- `A1_reference`: 4-vCPU/8-GiB reference performance plan.
- `A2_soak`: 72-hour failure-injection release-candidate plan.

The authoritative owner predicates remain
`SPEC-AUN-SHIRUBE-001-acceptance.yaml` at SHA-256
`aa2e91055953439022ab65fc429ef86d9d280acc6a9fde6a46394694d44a85a5`.
