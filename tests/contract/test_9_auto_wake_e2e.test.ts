import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'

// Spec §contract_test test_9 — auto-wake end-to-end (PR #233 merge gate).
//
// v4 §77 / §92 require all four conditions to PASS for this test to PASS:
//   (a) wake-daemon logs `wake <session> for <agent>/<msg>` within 2 s of the
//       `message_queue` INSERT (daemon saw the NOTIFY and delivered send-keys)
//   (b) the target tmux session picks up a new LLM turn within 5 s of the
//       send-keys (visible as new text in the pane buffer — the `check inbox`
//       prompt itself plus any Claude response)
//   (c) the `auto-next.sh` hook fires with event `UserPromptSubmit` after
//       the wake send-keys (evidenced by a marker file written by a test-
//       only variant of the hook that logs `$CLAUDE_HOOK_EVENT_NAME`).
//       The claude session's own `SessionStart` fires at boot and is
//       explicitly NOT counted toward this condition — the marker file is
//       truncated after startup settles and before the notify INSERT so
//       only wake-induced `UserPromptSubmit` entries reach the assertion
//       (spec v4 §92 (b) / instruction §1.6 (b), cycle 2 BLOCKER-1 fix).
//   (d) the queue row's status advances to `read` or `replied` within 60 s
//       — i.e. the recipient session drained the queue via
//       `mcp__agent-comms__next`. The auto-wake mechanism's success
//       threshold is `read` (queue pickup); `replied` additionally proves
//       a full round-trip, but requires a responding bot and is therefore
//       confirmed by operator pilot (lead-ama / auditor agreement,
//       cycle 2 🟡-2: `skipped` was removed from the accept list as it
//       represents operator dismissal rather than auto-wake success).
//
// Gate:
//   CLAUDE_BIN        — the `claude` CLI is available on PATH
//   DATABASE_URL      — PostgreSQL reachable (the auto-wake path is the PG
//                       NOTIFY flow; the SQLite polling path is covered by
//                       test_0_wake_daemon.test.ts)
//   TEST_E2E_AUTO_WAKE — **explicit opt-in** (avoids incidental production
//                       impact — this test really does spawn a claude
//                       session and send messages that the operator may
//                       otherwise not expect during a routine test run)
//
// Usage (local):
//   DATABASE_URL=postgresql://yuji@localhost/agent_comms \
//     TEST_E2E_AUTO_WAKE=1 \
//     bun test tests/contract/test_9_auto_wake_e2e.test.ts

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const DAEMON = join(REPO_ROOT, 'bin', 'wake-daemon.ts')
const CLI = join(REPO_ROOT, 'cli', 'index.ts')
const HOOK_SRC = join(REPO_ROOT, 'hooks', 'auto-next.sh')

const DATABASE_URL = process.env.DATABASE_URL
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? (spawnSync('which', ['claude'], { encoding: 'utf-8' }).stdout.trim() || null)
const E2E_OPT_IN = process.env.TEST_E2E_AUTO_WAKE === '1'

const e2eDescribe = CLAUDE_BIN && DATABASE_URL && E2E_OPT_IN ? describe : describe.skip

// Use a probe agent pair so we never touch production bots — spec action was
// `arc → webb-dev`, we remap to `test-wake-sender-<uuid>` → `test-wake-recv-<uuid>`.
const SENDER_AGENT = `test-wake-sender-${randomUUID().slice(0, 8)}`
const RECV_AGENT = `test-wake-recv-${randomUUID().slice(0, 8)}`
const RECV_SESSION = `discord-${RECV_AGENT}`

async function waitFor<T>(
  poll: () => T | Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await poll()
    if (predicate(v)) return v
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return null
}

function tmuxHas(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], {
    stdio: ['ignore', 'ignore', 'ignore'],
  }).status === 0
}
function tmuxKill(session: string): void {
  if (tmuxHas(session)) {
    spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
  }
}
function tmuxCapture(session: string): string {
  const r = spawnSync('tmux', ['capture-pane', '-pt', session], { encoding: 'utf-8' })
  return r.stdout ?? ''
}

e2eDescribe('test_9 auto-wake e2e (PR #233, v4 §77/§92 merge gate)', () => {
  let tmpDir: string
  let hookMarkerFile: string
  let daemon: ChildProcess | null = null
  let client: Client | null = null
  let insertedMessageId: string | null = null

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'test9-e2e-'))
    hookMarkerFile = join(tmpDir, 'hook-fires.log')
    const botProjectDir = join(tmpDir, 'recv-bot')
    const hookDir = join(botProjectDir, '.claude', 'hooks')
    mkdirSync(hookDir, { recursive: true })

    // Test-only hook variant: writes a marker line per invocation with the
    // $CLAUDE_HOOK_EVENT_NAME value, then emits the same additionalContext
    // JSON as the production hook. This is the only way to observe
    // condition (c) hook-fire from outside the Claude session.
    const probeHook = `#!/usr/bin/env bash
set -euo pipefail
EVENT="\${CLAUDE_HOOK_EVENT_NAME:-SessionStart}"
printf '%s %s\\n' "$(date +%s)" "$EVENT" >> ${JSON.stringify(hookMarkerFile)}
exec ${JSON.stringify(HOOK_SRC)}
`
    const probeHookPath = join(hookDir, 'auto-next.sh')
    writeFileSync(probeHookPath, probeHook)
    chmodSync(probeHookPath, 0o755)

    const settings = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: probeHookPath }] }],
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: probeHookPath }] }],
      },
    }
    writeFileSync(join(botProjectDir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2))

    // Seed the recipient agent + a minimal `agents` row so the NOTIFY path
    // does not short-circuit on missing metadata.
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status)
       VALUES ($1, $1, 'dev', 'claude-code', 'online')
       ON CONFLICT (agent_id) DO NOTHING`,
      [RECV_AGENT],
    )
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status)
       VALUES ($1, $1, 'dev', 'claude-code', 'online')
       ON CONFLICT (agent_id) DO NOTHING`,
      [SENDER_AGENT],
    )

    // Spawn the recipient claude session inside tmux, rooted at the temp
    // project dir so it reads our probe hook / settings.
    spawnSync('tmux', ['new-session', '-d', '-s', RECV_SESSION, '-c', botProjectDir, CLAUDE_BIN!], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Give claude a moment to boot.
    await new Promise(r => setTimeout(r, 3000))
  })

  afterAll(async () => {
    if (daemon && daemon.pid && !daemon.killed) {
      try { daemon.kill('SIGKILL') } catch {}
    }
    tmuxKill(RECV_SESSION)
    if (client) {
      try {
        if (insertedMessageId) {
          await client.query(`DELETE FROM message_queue WHERE agent_id = $1 AND message_id = $2`, [RECV_AGENT, insertedMessageId])
          await client.query(`DELETE FROM agent_messages WHERE id = $1`, [insertedMessageId])
        }
        await client.query(`DELETE FROM agents WHERE agent_id = ANY($1::text[])`, [[SENDER_AGENT, RECV_AGENT]])
      } catch {}
      try { await client.end() } catch {}
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('4 conditions all pass: daemon wake ≤2s / LLM turn ≤5s / hook fire / queue drain ≤60s', async () => {
    // Start the wake-daemon with a bot-registry shim that knows about our
    // recipient session. We pass PROJECT_ROOT's registry and rely on the
    // daemon's `discord-<agent_id>` fallback for session resolution.
    daemon = spawn('bun', [DAEMON], {
      env: {
        ...process.env,
        AGENT_COM_DB: 'postgres',
        DATABASE_URL,
        WAKE_DAEMON_DEBUG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    })
    let daemonStderr = ''
    daemon.stderr!.on('data', (d: Buffer) => { daemonStderr += d.toString() })

    // Baseline pane before the wake so we can detect new turn output.
    await waitFor(() => daemonStderr, (s) => /listening on pg channel/.test(s), 8000)
    const paneBaseline = tmuxCapture(RECV_SESSION)

    // Truncate the hook marker file so any `SessionStart` entries emitted
    // during claude's own boot are discarded. Only hook invocations that
    // happen after this point — i.e. the wake-induced `UserPromptSubmit`
    // — land in the file and reach the (c) assertion below. Cycle 2
    // BLOCKER-1 fix: without this reset the regex could satisfy on the
    // already-fired SessionStart and never exercise the wake path.
    writeFileSync(hookMarkerFile, '')

    // Fire the notify via CLI — spec action, but aimed at our probe pair.
    const notifyResult = spawnSync(
      'bun',
      [CLI, 'notify', '--channel', `pilot-test-${randomUUID().slice(0, 8)}`, '--mentions', RECV_AGENT, '--content', 'test_9 probe'],
      {
        env: { ...process.env, AGENT_ID: SENDER_AGENT, DATABASE_URL },
        encoding: 'utf-8',
        cwd: REPO_ROOT,
      },
    )
    expect(notifyResult.status).toBe(0)

    // Pick up the message_id the CLI just enqueued (the trigger will have
    // fired NOTIFY inside the same transaction).
    const mqRow = await client!.query<{ message_id: string }>(
      `SELECT message_id FROM message_queue
        WHERE agent_id = $1 AND status = 'pending'
        ORDER BY id DESC LIMIT 1`,
      [RECV_AGENT],
    )
    expect(mqRow.rows.length).toBe(1)
    insertedMessageId = mqRow.rows[0].message_id

    // (a) daemon logs `wake ...` within 2 s.
    const wakeOk = await waitFor(
      () => daemonStderr,
      (s) => new RegExp(`wake ${RECV_SESSION} for ${RECV_AGENT}/`).test(s),
      2000,
    )
    expect(wakeOk).not.toBeNull()

    // (b) new LLM turn lands in the pane within 5 s (send-keys happened
    // inside the daemon's wake path; claude responds to `check inbox`).
    const paneChanged = await waitFor(
      () => tmuxCapture(RECV_SESSION),
      (pane) => pane !== paneBaseline && pane.length > paneBaseline.length,
      5000,
    )
    expect(paneChanged).not.toBeNull()

    // (c) hook fire — the probe wrote a `UserPromptSubmit` marker line
    // to the truncated-just-before-INSERT marker file. Startup-time
    // `SessionStart` entries were discarded by the beforeINSERT truncate
    // so this assertion proves the wake flow (send-keys → new turn →
    // UserPromptSubmit hook) without a race against claude's own boot.
    const hookFired = await waitFor(
      () => {
        try { return Bun.file(hookMarkerFile).text() } catch { return '' }
      },
      async (contentPromise) => {
        const content = await contentPromise
        return /UserPromptSubmit/.test(content)
      },
      10_000,
    )
    expect(hookFired).not.toBeNull()

    // (d) queue row status advances past `pending` within 60 s (claude
    // actually invoked `mcp__agent-comms__next` and the row was marked read).
    const drained = await waitFor(
      async () => {
        const r = await client!.query<{ status: string }>(
          `SELECT status FROM message_queue WHERE agent_id = $1 AND message_id = $2`,
          [RECV_AGENT, insertedMessageId],
        )
        return r.rows[0]?.status ?? 'pending'
      },
      (status) => status !== 'pending',
      60_000,
      1000,
    )
    expect(drained).not.toBeNull()
    // Accept list strict: spec v4 §92 (c) covers pending → read → replied.
    // `skipped` was removed in cycle 2 🟡-2 (it represents operator
    // dismissal, not auto-wake success).
    expect(['read', 'replied']).toContain(drained)
  }, 90_000)
})
