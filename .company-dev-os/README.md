# Company Dev OS Runtime Overlay

This directory contains repository-local runtime settings generated from
`watchout/iyasaka-arc/company-dev-os/`.

These files are intentionally local to the repository so Codex, Claude, and
AUN/Discord routing can read the role boundary even after restart or
compaction.

Live AUN/Discord registration is not enabled by this directory. Treat
`aun-discord-runtime.dry-run.json` as a dry-run/staging input only.
