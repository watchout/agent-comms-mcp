#!/bin/bash
# Channel Routing hook for Claude Code (SessionStart)
# ADR-033: Injects channel→project→bot mapping into context
# so that the agent knows which channel belongs to which project.
# Always exits 0 (informational only, never blocks)

project_dir="${CLAUDE_PROJECT_DIR:-.}"
routing_file="$project_dir/channel-routing.json"

if [ ! -f "$routing_file" ]; then
  exit 0
fi

# Read and format the routing table for context injection
table=$(node -e "
  const fs = require('fs');
  try {
    const r = JSON.parse(fs.readFileSync('$routing_file', 'utf8'));
    const ch = r.channels || {};
    const lines = Object.entries(ch).map(([id, v]) =>
      '  ' + id + ' → ' + v.project + ' (' + v.bot + ')' + (v.tag ? ' [' + v.tag + ']' : '')
    );
    console.log(lines.join('\n'));
  } catch { process.exit(0); }
")

if [ -z "$table" ]; then
  exit 0
fi

cat <<EOF
# Channel Routing Table (ADR-033)
Discord chat_id → project / responsible bot mapping:
$table

When receiving a message from a channel, check this table to identify the project and responsible bot.
If a message is intended for a different bot, inform the sender.
EOF

exit 0
