#!/bin/bash
# cleanup-orphan-ports.sh
# Bot 起動前に、そのbotが使うポートの orphan プロセスを kill する。
# SessionStart hook から呼ばれる。
#
# Issue #248 の cascade-disconnect 真因: 旧版は port を使う全 PID を kill して
# いたため、並行起動中の別 bot の生きた MCP server まで巻き込み破壊していた。
# ARC root cause report (本日朝) + CTO directive (queue_id 9059/9060) で
# option A 採決: PPID==1 (init 引取済 = 真の orphan) のみ kill 対象とする。
#
# 使い方: cleanup-orphan-ports.sh <port>

PORT="$1"
if [ -z "$PORT" ]; then
  exit 0
fi

# PPID==1 のみ抽出。PPID!=1 (= 親 process 健在 = 生きた MCP / 他 SessionStart
# hook) は skip。`ps` 失敗時は PPID 不明扱いで skip (false-positive 回避)。
PIDS=$(lsof -ti :"$PORT" 2>/dev/null | xargs -I{} sh -c 'ppid=$(ps -o ppid= -p {} 2>/dev/null | tr -d " "); [ "$ppid" = "1" ] && echo {}')

if [ -n "$PIDS" ]; then
  echo "Killing orphan process(es) on port $PORT (PPID==1 only): $PIDS"
  echo "$PIDS" | xargs kill -9 2>/dev/null
  sleep 1
fi
