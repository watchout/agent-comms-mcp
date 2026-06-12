#!/bin/bash
# Skill Tracker hook for Claude Code (PreToolUse → Skill)
# Records skill activation to .framework/active-skill.json
# Always exits 0 (never blocks)

input=$(cat)

project_dir="${CLAUDE_PROJECT_DIR:-.}"

# Extract skill name from tool_input
skill_name=$(echo "$input" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const p=JSON.parse(d);console.log((p.tool_input||{}).skill||'')}catch{console.log('')}})")

# No skill name = unexpected, just allow
if [ -z "$skill_name" ]; then
  exit 0
fi

# Ensure .framework/ exists
framework_dir="$project_dir/.framework"
if [ ! -d "$framework_dir" ]; then
  mkdir -p "$framework_dir"
fi

# Write active-skill.json with timestamp
node -e "
  const fs = require('fs');
  const data = { skill: '$skill_name', activatedAt: new Date().toISOString() };
  fs.writeFileSync('$framework_dir/active-skill.json', JSON.stringify(data, null, 2));
"

exit 0
