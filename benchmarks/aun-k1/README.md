# AUN K1 fixture benchmark plans

These commands emit deterministic plans only. They never connect to a database,
start a worker, invoke a provider, traverse V1, or activate runtime state.

```sh
bun benchmarks/aun-k1/cli.ts --profile A0_correctness --plan --json
bun benchmarks/aun-k1/cli.ts --profile A1_reference --plan --json
```

Execution against a disposable PostgreSQL fixture is owned by the K1 tests and
requires both `AUN_K1_DB_SCOPE=isolated_disposable_fixture` and a database name
beginning with `aun_k1_fixture_`.
