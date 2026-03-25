#!/bin/bash
# Daily backup of agent_comms database to ConoHa server
# Add to crontab: 0 3 * * * bash ~/Developer/agent-comms-mcp/scripts/backup-to-conoha.sh

set -euo pipefail

BACKUP_DIR="/tmp/agent-comms-backup"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="agent_comms_${TIMESTAMP}.sql.gz"
CONOHA_HOST="${CONOHA_HOST:-}"
CONOHA_USER="${CONOHA_USER:-}"
CONOHA_BACKUP_DIR="${CONOHA_BACKUP_DIR:-/var/backups/agent-comms}"

mkdir -p "$BACKUP_DIR"

# Dump and compress
/opt/homebrew/opt/postgresql@17/bin/pg_dump agent_comms | gzip > "$BACKUP_DIR/$BACKUP_FILE"

# Transfer to ConoHa
if [ -n "$CONOHA_HOST" ]; then
  ssh "$CONOHA_USER@$CONOHA_HOST" "mkdir -p $CONOHA_BACKUP_DIR"
  scp "$BACKUP_DIR/$BACKUP_FILE" "$CONOHA_USER@$CONOHA_HOST:$CONOHA_BACKUP_DIR/"
  # Keep only last 30 days on remote
  ssh "$CONOHA_USER@$CONOHA_HOST" "find $CONOHA_BACKUP_DIR -name '*.sql.gz' -mtime +30 -delete"
  echo "Backup transferred: $BACKUP_FILE"
else
  echo "CONOHA_HOST not set, backup saved locally: $BACKUP_DIR/$BACKUP_FILE"
fi

# Clean local temp
rm -f "$BACKUP_DIR/$BACKUP_FILE"
