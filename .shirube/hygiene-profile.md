# hygiene profile — agent-comms-mcp

The pin lives only in `.github/workflows/hygiene.yml`. This adoption is report_only; findings remain failures and the check is not required.

```json
{
  "language": "ts",
  "lines": {
    "include": [
      "core/**",
      "adapters/**",
      "bin/**",
      "cli/**",
      "db/**",
      "entrypoints/**",
      "hooks/**",
      "scripts/**",
      "server.ts"
    ],
    "exclude": []
  },
  "exclude_generated": [
    ".hygiene/**"
  ],
  "large_file_allow": [
    "cli/index.ts",
    "server.ts",
    "core/fleet-runtime-v1-local-provider.ts",
    "bin/aun/bootstrap.ts",
    "core/eventlog/transport-contract.ts"
  ],
  "jscpd": {
    "extensions": [
      "ts",
      "tsx",
      "js",
      "mjs"
    ]
  },
  "exceptions": [],
  "limits": {
    "new_file_lines": 300,
    "pr_added_lines": 400,
    "pr_changed_files": 20,
    "large_file_bytes": 102400
  },
  "mode": "report_only"
}
```

The five large-file entries existed at adoption; #970 tracks V2 reduction and #977 tracks this adoption. They are explicit allowances, not claims that their size meets the default.

Production entries are server, CLI, bin, entrypoints, DB, hooks and scripts. Tests, benchmarks and demo are excluded from this first profile and remain follow-up scope in the switch plan. `bun` is a runtime builtin dependency. Core must not depend on adapters, bin, CLI or server; cycles are forbidden.

No baseline files or baseline caps are introduced here. Required checks, enforce_by and version_hold require their separate owner path. AB-01/02/03/04/05/06/07/08/10/11/12/13/18/23/24 are in scope; each run records which checks executed. Skipped checks are unobserved. AB-14 enforcement/rollback is pending, not passed.
