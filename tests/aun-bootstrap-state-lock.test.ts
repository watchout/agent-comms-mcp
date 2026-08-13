import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBootstrapStateStore, bootstrapDigest } from '../core/aun-bootstrap-state'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aun-bootstrap-lock-'))
  roots.push(root)
  return { root, store: new FileBootstrapStateStore(root), agentId: 'lock-agent', runId: 'bootstrap-lock-run' }
}

function deadRecord(agentId: string, runId: string, nonce: string) {
  return {
    schema_version: 'aun-bootstrap-lock/v1', agent_id: agentId, run_id: runId,
    pid: 2_147_483_000, process_start_identity: 'a'.repeat(64),
    created_at: '2026-08-14T00:00:00.000Z', nonce,
  }
}

function seedDirectory(path: string, record: ReturnType<typeof deadRecord>, claim = false) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  writeFileSync(join(path, 'owner.json'), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  if (claim) mkdirSync(join(path, 'reclaim.complete'), { mode: 0o700 })
}

function releaseJournal(root: string, agentId: string, runId: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'shirube-v3/aun-bootstrap-run/v1', run_id: runId, agent_id: agentId,
    requested_runtime: 'codex', resolved_runtime: null, input_digest: 'a'.repeat(64), repo_root: root,
    workspace_root: root, repo_head: null, created_at: '2026-08-14T00:00:00.000Z',
    updated_at: '2026-08-14T00:00:01.000Z', terminal_status: null,
    lock_release_authorized_at: '2026-08-14T00:00:00.000Z',
    lock_released_at: '2026-08-14T00:00:01.000Z', lock_release_owner_nonce: null,
    stages: [], mutations: [], mutation_manifest_digest: bootstrapDigest([]), readback_bindings: null,
    evidence_refs: [], safe_D1_readback: {}, ...overrides,
  } as any
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: RegExp): Promise<string> {
  let output = ''
  while (!pattern.test(output)) {
    const next = await reader.read()
    if (next.done) break
    output += new TextDecoder().decode(next.value)
  }
  return output
}

const childFixture = process.env.AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE === 'hold'
  || process.env.AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE === 'reclaim'
  || process.env.AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE === 'delayed-reclaim'
  || process.env.AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE === 'pending-hold'
  || process.env.AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE === 'ready-hold'
  || process.env.AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE === 'snapshot-racer'
  || process.env.AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE === 'reclaim-hold'
  ? process.env.AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE
  : null

if (childFixture) {
  test(`bootstrap lock child ${childFixture}`, async () => {
    const store = new FileBootstrapStateStore(process.env.AUN_BOOTSTRAP_LOCK_CHILD_ROOT!, childFixture === 'delayed-reclaim'
      ? { beforeReclaimRename: () => {
          writeFileSync(process.env.AUN_BOOTSTRAP_LOCK_CHILD_READY!, 'ready\n', { mode: 0o600 })
          console.log('PAUSED')
          const wait = new Int32Array(new SharedArrayBuffer(4))
          while (!existsSync(process.env.AUN_BOOTSTRAP_LOCK_CHILD_GO!)) Atomics.wait(wait, 0, 0, 10)
          } }
      : childFixture === 'snapshot-racer'
        ? { afterInitialReservedSnapshot: () => {
            writeFileSync(process.env.AUN_BOOTSTRAP_LOCK_CHILD_READY!, 'snapshot\n', { mode: 0o600 })
            console.log('SNAPSHOT')
            const wait = new Int32Array(new SharedArrayBuffer(4))
            while (!existsSync(process.env.AUN_BOOTSTRAP_LOCK_CHILD_GO!)) Atomics.wait(wait, 0, 0, 10)
          } }
      : childFixture === 'reclaim-hold'
        ? { afterReclaimRename: () => {
            writeFileSync(process.env.AUN_BOOTSTRAP_LOCK_CHILD_READY!, 'reclaimed\n', { mode: 0o600 })
            console.log('RECLAIMED')
            const wait = new Int32Array(new SharedArrayBuffer(4))
            while (true) Atomics.wait(wait, 0, 0, 1000)
          } }
      : childFixture === 'pending-hold' || childFixture === 'ready-hold'
        ? { acquireDurability: (event: string) => {
            const awaited = childFixture === 'pending-hold' ? 'after-pending-publish' : 'after-ready-rename'
            if (event !== awaited) return
            console.log(childFixture === 'pending-hold' ? 'PENDING' : 'READY')
            const wait = new Int32Array(new SharedArrayBuffer(4))
            while (true) Atomics.wait(wait, 0, 0, 1000)
          } }
      : {})
    const agentId = process.env.AUN_BOOTSTRAP_LOCK_CHILD_AGENT!
    const runId = process.env.AUN_BOOTSTRAP_LOCK_CHILD_RUN!
    const reader = Bun.stdin.stream().getReader()
    const readCommand = async () => {
      let value = ''
      while (!value.includes('\n')) {
        const next = await reader.read()
        if (next.done) break
        value += new TextDecoder().decode(next.value)
      }
      return value.trim()
    }
    if (childFixture === 'reclaim' && await readCommand() !== 'GO') throw new Error('missing GO barrier')
    try {
      store.acquireLock(agentId, runId, {
        reclaimStaleSameRun: childFixture !== 'hold' && childFixture !== 'snapshot-racer',
      })
      console.log(childFixture === 'hold' ? 'LOCKED' : 'WON')
    } catch {
      console.log('BUSY')
      return
    }
    if (await readCommand() !== 'RELEASE') throw new Error('missing RELEASE command')
    store.releaseLock(agentId, runId)
    console.log('RELEASED')
  })
} else describe('aun bootstrap durable per-agent lock', () => {
  test('official same-run resume reclaims one dead structured owner and releases exactly', () => {
    const { root, store, agentId, runId } = fixture()
    const dir = join(root, agentId)
    seedDirectory(join(dir, '.lock'), deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000001'))
    store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    const installed = JSON.parse(readFileSync(join(dir, '.lock', 'owner.json'), 'utf8'))
    expect(installed).toMatchObject({ schema_version: 'aun-bootstrap-lock/v1', agent_id: agentId, run_id: runId, pid: process.pid })
    expect(readdirSync(dir).filter((name) => name.startsWith('.lock.reclaim-'))).toHaveLength(1)
    store.releaseLock(agentId, runId)
    expect(readdirSync(dir).filter((name) => name === '.lock' || name.startsWith('.lock.release-'))).toEqual([])
  })

  test('a completed same-run reclaim generation remains as the permanent ABA tombstone', () => {
    const { root, store, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const record = deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000002')
    seedDirectory(join(dir, `.lock.reclaim-${record.nonce}`), record, true)
    store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    store.releaseLock(agentId, runId)
    expect(readdirSync(dir).filter((name) => name === '.lock' || name.startsWith('.lock.release-'))).toEqual([])
    const fresh = new FileBootstrapStateStore(root)
    fresh.acquireLock(agentId, 'fresh-run-after-reclaim')
    fresh.releaseLock(agentId, 'fresh-run-after-reclaim')
    expect(readdirSync(dir).filter((name) => name === '.lock' || name.startsWith('.lock.release-'))).toEqual([])
  })

  test('release re-fsyncs and strictly rereads an already completed reclaim generation', () => {
    const { root, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const record = deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000014')
    seedDirectory(join(dir, `.lock.reclaim-${record.nonce}`), record, true)
    const trace: string[] = []
    const store = new FileBootstrapStateStore(root, {
      reclaimDurability: (event) => trace.push(event),
    })
    store.acquireLock(agentId, 'fresh-release-durability')
    store.releaseLock(agentId, 'fresh-release-durability')
    expect(trace).toEqual([
      'before-marker-fsync',
      'after-marker-fsync',
      'before-tomb-fsync',
      'after-tomb-fsync',
      'after-strict-reread',
    ])
    expect(readdirSync(join(dir, `.lock.reclaim-${record.nonce}`)).sort()).toEqual([
      'owner.json', 'reclaim.complete',
    ])
  })

  test('recovery durability-closes an observed ready generation before reclaim rename', () => {
    const { root, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const record = deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000021')
    seedDirectory(join(dir, '.lock'), record)
    mkdirSync(join(dir, '.lock', 'acquire.ready'), { mode: 0o700 })
    const trace: string[] = []
    const store = new FileBootstrapStateStore(root, {
      readyObserverDurability: (event) => trace.push(event),
    })

    store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    expect(trace).toEqual([
      'after-marker-fsync',
      'after-lock-fsync',
      'after-agent-fsync',
      'after-strict-reread',
    ])
    expect(readdirSync(join(dir, `.lock.reclaim-${record.nonce}`)).sort()).toEqual([
      'acquire.ready', 'owner.json', 'reclaim.complete',
    ])
    store.releaseLock(agentId, runId)
  })

  test('acquire retry closes every injected reclaim marker and tomb durability window before ready', () => {
    for (const boundary of ['after-marker-mkdir', 'before-marker-fsync', 'before-tomb-fsync'] as const) {
      const { root, agentId, runId } = fixture()
      const dir = join(root, agentId)
      const record = deadRecord(agentId, runId, `00000000-0000-4000-8000-0000000000${boundary.length}`)
      seedDirectory(join(dir, '.lock'), record)
      const trace: string[] = []
      let injected = false
      const store = new FileBootstrapStateStore(root, {
        reclaimDurability: (event) => {
          trace.push(event)
          if (!injected && event === boundary) {
            injected = true
            throw new Error(`injected ${boundary}`)
          }
        },
      })
      expect(() => store.acquireLock(agentId, runId, { reclaimStaleSameRun: true }))
        .toThrow(`injected ${boundary}`)
      expect(existsSync(join(dir, '.lock'))).toBe(false)
      expect(readdirSync(dir).some((name) => name.startsWith('.lock.release-'))).toBe(false)
      store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
      store.releaseLock(agentId, runId)
      expect(trace).toContain(boundary)
      expect(trace.at(-1)).toBe('after-strict-reread')
      expect(readdirSync(join(dir, `.lock.reclaim-${record.nonce}`)).sort()).toEqual([
        'owner.json', 'reclaim.complete',
      ])
    }
  })

  test('ordinary acquire permanently quarantines exact empty stage residue', () => {
    const { root, store, agentId } = fixture()
    const dir = join(root, agentId)
    const nonce = '00000000-0000-4000-8000-000000000015'
    mkdirSync(join(dir, `.lock.stage-${nonce}`), { recursive: true, mode: 0o700 })
    store.acquireLock(agentId, 'fresh-after-empty-stage')
    store.releaseLock(agentId, 'fresh-after-empty-stage')
    expect(existsSync(join(dir, `.lock.stage-${nonce}`))).toBe(false)
    expect(existsSync(join(dir, `.lock.completed-stage-${nonce}`))).toBe(true)
    expect(readdirSync(join(dir, `.lock.completed-stage-${nonce}`))).toEqual([])
  })

  test('all staged-write fault boundaries recover to permanent quarantine without official reclaim', () => {
    for (const boundary of [
      'afterStageMkdir',
      'afterStagePartialOwnerWrite',
      'afterStageOwnerFsync',
      'afterStageFsync',
    ] as const) {
      const { root, agentId } = fixture()
      const crashing = new FileBootstrapStateStore(root, {
        [boundary]: () => { throw new Error(`injected ${boundary}`) },
      })
      expect(() => crashing.acquireLock(agentId, `fault-${boundary}`)).toThrow(`injected ${boundary}`)
      const dir = join(root, agentId)
      const staged = readdirSync(dir).filter((name) => name.startsWith('.lock.stage-'))
      expect(staged).toHaveLength(1)

      const fresh = new FileBootstrapStateStore(root)
      fresh.acquireLock(agentId, `fresh-${boundary}`)
      fresh.releaseLock(agentId, `fresh-${boundary}`)
      expect(readdirSync(dir).filter((name) => name.startsWith('.lock.stage-'))).toEqual([])
      expect(readdirSync(dir).filter((name) => name.startsWith('.lock.completed-stage-'))).toHaveLength(1)
    }
  })

  test('a deterministic completed reclaim tombstone defeats an arbitrarily delayed ABA rename', () => {
    const { root, store, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const record = deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000008')
    const tombstone = join(dir, `.lock.reclaim-${record.nonce}`)
    seedDirectory(join(dir, '.lock'), record)
    store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    expect(existsSync(tombstone)).toBe(true)
    expect(() => renameSync(join(dir, '.lock'), tombstone)).toThrow()
    const liveOwner = JSON.parse(readFileSync(join(dir, '.lock', 'owner.json'), 'utf8'))
    expect(liveOwner).toMatchObject({ pid: process.pid, run_id: runId })
    store.releaseLock(agentId, runId)
  })

  test('marker-only post-rename crash residue is recovered only by official same-run flow', () => {
    const { root, store, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const record = deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000007')
    seedDirectory(join(dir, `.lock.reclaim-${record.nonce}`), record)
    expect(() => store.acquireLock(agentId, runId)).toThrow('NO_GO_BOOTSTRAP_BUSY')
    expect(existsSync(join(dir, `.lock.reclaim-${record.nonce}`))).toBe(true)
    store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    store.releaseLock(agentId, runId)
    expect(readdirSync(dir).filter((name) => name === '.lock' || name.startsWith('.lock.release-'))).toEqual([])
  })

  test('official recovery completes every same-run generation in place before fresh ordinary work', () => {
    const { root, store, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const records = [10, 11, 12].map((suffix) => deadRecord(
      agentId, runId, `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    ))
    const tombstones = records.slice(0, 2).map((record) => {
      const path = join(dir, `.lock.reclaim-${record.nonce}`)
      seedDirectory(path, record)
      return path
    })
    seedDirectory(join(dir, '.lock'), records[2]!)
    store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    store.releaseLock(agentId, runId)
    const allTombstones = [...tombstones, join(dir, `.lock.reclaim-${records[2]!.nonce}`)]
    for (const path of allTombstones) {
      expect(existsSync(path)).toBe(true)
      expect(readdirSync(path).sort()).toEqual(['owner.json', 'reclaim.complete'])
    }
    const fresh = new FileBootstrapStateStore(root)
    fresh.acquireLock(agentId, 'fresh-after-three-generations')
    fresh.releaseLock(agentId, 'fresh-after-three-generations')
    for (const path of allTombstones) expect(existsSync(path)).toBe(true)
  })

  test('completed release marker crash residue is archived before a fresh ordinary acquire', () => {
    const { root, store, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const record = deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000009')
    const releasePath = join(dir, `.lock.release-${record.nonce}`)
    seedDirectory(releasePath, record)
    expect(() => store.acquireLock(agentId, 'fresh-after-release-marker')).toThrow('NO_GO_BOOTSTRAP_BUSY')
    const state = {
      schema_version: 'shirube-v3/aun-bootstrap-run/v1', run_id: runId, agent_id: agentId,
      requested_runtime: 'codex', resolved_runtime: null, input_digest: 'a'.repeat(64), repo_root: root,
      workspace_root: root, repo_head: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      terminal_status: null, lock_release_authorized_at: new Date().toISOString(), lock_released_at: null,
      lock_release_owner_nonce: null,
      stages: [], mutations: [], mutation_manifest_digest: bootstrapDigest([]), readback_bindings: null,
      evidence_refs: [], safe_D1_readback: {},
    } as any
    store.save(state)
    store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    expect(existsSync(releasePath)).toBe(false)
    expect(readdirSync(dir).some((name) => name === `.lock.completed-release-${record.nonce}`)).toBe(true)
    store.releaseLock(agentId, runId)
  })

  test('official recovery clamps a missing release receipt to future authorization before publishing', () => {
    const { root, store, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const record = deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000019')
    const releasePath = join(dir, `.lock.release-${record.nonce}`)
    seedDirectory(releasePath, record)
    const authorizedAt = new Date(Date.now() + 60_000).toISOString()
    store.save(releaseJournal(root, agentId, runId, {
      lock_release_authorized_at: authorizedAt,
      lock_released_at: null,
      lock_release_owner_nonce: null,
    }))

    store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    expect(store.load(agentId, runId)).toMatchObject({
      lock_release_authorized_at: authorizedAt,
      lock_released_at: authorizedAt,
      lock_release_owner_nonce: record.nonce,
    })
    expect(existsSync(releasePath)).toBe(false)
    expect(existsSync(join(dir, `.lock.completed-release-${record.nonce}`))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, '.lock', 'owner.json'), 'utf8'))).toMatchObject({
      agent_id: agentId, run_id: runId, pid: process.pid,
    })
    store.releaseLock(agentId, runId)

    const repeat = new FileBootstrapStateStore(root)
    repeat.acquireLock(agentId, runId)
    repeat.releaseLock(agentId, runId)
    const fresh = new FileBootstrapStateStore(root)
    fresh.acquireLock(agentId, 'fresh-after-future-authorization')
    fresh.releaseLock(agentId, 'fresh-after-future-authorization')
    expect(readdirSync(dir).filter((name) => name === '.lock' || name.startsWith('.lock.release-'))).toEqual([])
  })

  test('a distinct observer durability-closes a post-archive-rename crash before publishing', () => {
    const { root, agentId } = fixture()
    const dir = join(root, agentId)
    const crashing = new FileBootstrapStateStore(root, {
      afterCompletedReleaseRename: () => { throw new Error('injected after completed release rename') },
    })
    crashing.acquireLock(agentId, 'archive-crash-run')
    expect(() => crashing.releaseLock(agentId, 'archive-crash-run')).toThrow(
      'injected after completed release rename',
    )
    expect(existsSync(join(dir, '.lock'))).toBe(false)
    expect(readdirSync(dir).filter((name) => name.startsWith('.lock.release-'))).toEqual([])
    const firstArchive = readdirSync(dir).find((name) => name.startsWith('.lock.completed-release-'))!
    const firstOwner = readFileSync(join(dir, firstArchive, 'owner.json'), 'utf8')

    const trace: string[] = []
    const observer = new FileBootstrapStateStore(root, {
      completedReleaseObserverDurability: (event) => {
        trace.push(event)
        if (event === 'after-strict-reread') expect(existsSync(join(dir, '.lock'))).toBe(false)
      },
    })
    observer.acquireLock(agentId, 'ordinary-after-archive-crash')
    expect(trace).toEqual(['after-archive-fsync', 'after-agent-fsync', 'after-strict-reread'])
    expect(existsSync(join(dir, '.lock'))).toBe(true)
    expect(readFileSync(join(dir, firstArchive, 'owner.json'), 'utf8')).toBe(firstOwner)
    observer.releaseLock(agentId, 'ordinary-after-archive-crash')
    expect(existsSync(join(dir, firstArchive))).toBe(true)
    expect(readdirSync(dir).filter((name) => name === '.lock' || name.startsWith('.lock.release-'))).toEqual([])
  })

  test('official recovery durably upgrades an exact legacy release receipt missing only owner nonce', () => {
    const { root, store, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const record = deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000016')
    const releasePath = join(dir, `.lock.release-${record.nonce}`)
    seedDirectory(releasePath, record)
    const state = releaseJournal(root, agentId, runId)
    delete state.lock_release_owner_nonce
    store.save(state)

    store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    const upgraded = store.load(agentId, runId)!
    expect(upgraded).toMatchObject({
      agent_id: agentId, run_id: runId,
      lock_release_authorized_at: '2026-08-14T00:00:00.000Z',
      lock_released_at: '2026-08-14T00:00:01.000Z',
      lock_release_owner_nonce: record.nonce,
    })
    expect(existsSync(releasePath)).toBe(false)
    expect(existsSync(join(dir, `.lock.completed-release-${record.nonce}`))).toBe(true)
    store.releaseLock(agentId, runId)
  })

  test('legacy release recovery rejects schema, nonce, time, and owner drift without effects', () => {
    for (const variant of [
      'unknown-schema', 'missing-schema', 'mismatch', 'present-null', 'noncanonical', 'preauthorization', 'foreign',
    ] as const) {
      const { root, store, agentId, runId } = fixture()
      const dir = join(root, agentId)
      const nonce = '00000000-0000-4000-8000-000000000017'
      const record = deadRecord(agentId, variant === 'foreign' ? 'foreign-run' : runId, nonce)
      const releasePath = join(dir, `.lock.release-${nonce}`)
      seedDirectory(releasePath, record)
      const state = releaseJournal(root, agentId, runId, variant === 'unknown-schema'
        ? { schema_version: 'shirube-v3/aun-bootstrap-run/v2' }
        : variant === 'mismatch'
        ? { lock_release_owner_nonce: '00000000-0000-4000-8000-000000000018' }
        : variant === 'present-null'
          ? { lock_release_owner_nonce: null }
          : variant === 'noncanonical'
            ? { lock_released_at: '2026-08-14T00:00:01Z' }
            : variant === 'preauthorization'
              ? { lock_released_at: '2026-08-13T23:59:59.000Z' }
              : {})
      if (variant === 'foreign') delete state.lock_release_owner_nonce
      if (variant === 'missing-schema') delete state.schema_version
      store.save(state)
      const journalPath = join(dir, `${runId}.json`)
      const journalBefore = readFileSync(journalPath, 'utf8')
      const releaseBefore = readFileSync(join(releasePath, 'owner.json'), 'utf8')
      expect(() => store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })).toThrow(
        'NO_GO_BOOTSTRAP_BUSY',
      )
      expect(readFileSync(journalPath, 'utf8')).toBe(journalBefore)
      expect(readFileSync(join(releasePath, 'owner.json'), 'utf8')).toBe(releaseBefore)
      expect(existsSync(releasePath)).toBe(true)
      expect(existsSync(join(dir, `.lock.completed-release-${nonce}`))).toBe(false)
      expect(existsSync(join(dir, '.lock'))).toBe(false)
    }
  })

  test('live, foreign, legacy, corrupt, and regular-acquire marker locks are immutable NO_GO', () => {
    for (const variant of ['live', 'foreign', 'legacy', 'corrupt', 'marker'] as const) {
      const { root, store, agentId, runId } = fixture()
      const dir = join(root, agentId)
      mkdirSync(dir, { recursive: true })
      if (variant === 'legacy') writeFileSync(join(dir, '.lock'), `${runId}\n`, { mode: 0o600 })
      else if (variant === 'corrupt') seedDirectory(join(dir, '.lock'), { ...deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000003'), process_start_identity: 'bad' })
      else if (variant === 'marker') seedDirectory(join(dir, '.lock.reclaim-00000000-0000-4000-8000-000000000004'), deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000004'))
      else if (variant === 'foreign') seedDirectory(join(dir, '.lock'), deadRecord(agentId, 'bootstrap-foreign', '00000000-0000-4000-8000-000000000005'))
      else {
        store.acquireLock(agentId, runId)
        const before = bootstrapDigest(readFileSync(join(dir, '.lock', 'owner.json'), 'utf8'))
        expect(() => new FileBootstrapStateStore(root).acquireLock(agentId, runId, { reclaimStaleSameRun: true })).toThrow('NO_GO_BOOTSTRAP_BUSY')
        expect(bootstrapDigest(readFileSync(join(dir, '.lock', 'owner.json'), 'utf8'))).toBe(before)
        store.releaseLock(agentId, runId)
        continue
      }
      const before = readdirSync(dir).sort()
      expect(() => store.acquireLock(agentId, runId, { reclaimStaleSameRun: variant !== 'marker' })).toThrow('NO_GO_BOOTSTRAP_BUSY')
      expect(readdirSync(dir).sort()).toEqual(before)
    }
  })

  test('a child SIGKILL owner is reclaimed by an official same-run acquire without manual deletion', async () => {
    const { root, store, agentId, runId } = fixture()
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE: 'hold',
        AUN_BOOTSTRAP_LOCK_CHILD_ROOT: root,
        AUN_BOOTSTRAP_LOCK_CHILD_AGENT: agentId,
        AUN_BOOTSTRAP_LOCK_CHILD_RUN: runId,
      },
    })
    const reader = child.stdout.getReader()
    const first = await readUntil(reader, /LOCKED|BUSY/)
    expect(first).toContain('LOCKED')
    child.kill('SIGKILL')
    expect(await child.exited).not.toBe(0)
    expect(existsSync(join(root, agentId, '.lock'))).toBe(true)
    store.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    store.releaseLock(agentId, runId)
    expect(readdirSync(join(root, agentId)).filter((name) => name === '.lock' || name.startsWith('.lock.release-'))).toEqual([])
  })

  test('two process reclaimers cross one barrier; exactly one holds the live winner lock', async () => {
    const { root, agentId, runId } = fixture()
    const dir = join(root, agentId)
    seedDirectory(join(dir, '.lock'), deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000006'))
    const children = [0, 1].map(() => Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE: 'reclaim',
        AUN_BOOTSTRAP_LOCK_CHILD_ROOT: root,
        AUN_BOOTSTRAP_LOCK_CHILD_AGENT: agentId,
        AUN_BOOTSTRAP_LOCK_CHILD_RUN: runId,
      },
    }))
    for (const child of children) { child.stdin.write('GO\n'); child.stdin.flush() }
    const readers = children.map((child) => child.stdout.getReader())
    const outcomes = await Promise.all(readers.map((reader) => readUntil(reader, /WON|BUSY/)))
    expect(outcomes.filter((outcome) => outcome.includes('WON'))).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.includes('BUSY'))).toHaveLength(1)
    const owner = JSON.parse(readFileSync(join(dir, '.lock', 'owner.json'), 'utf8'))
    expect(children.some((child) => child.pid === owner.pid)).toBe(true)
    const winner = children[outcomes.findIndex((outcome) => outcome.includes('WON'))]!
    winner.stdin.write('RELEASE\n'); winner.stdin.flush(); winner.stdin.end()
    expect(await winner.exited).toBe(0)
    for (const child of children) if (child !== winner) expect(await child.exited).toBe(0)
    expect(readdirSync(dir).filter((name) => name === '.lock' || name.startsWith('.lock.release-'))).toEqual([])
  })

  test('a forced delayed process cannot steal a fresh live owner after permanent-generation CAS', async () => {
    const { root, agentId, runId } = fixture()
    const dir = join(root, agentId)
    seedDirectory(join(dir, '.lock'), deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000013'))
    const ready = join(root, 'delayed.ready')
    const go = join(root, 'delayed.go')
    const delayed = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE: 'delayed-reclaim',
        AUN_BOOTSTRAP_LOCK_CHILD_ROOT: root,
        AUN_BOOTSTRAP_LOCK_CHILD_AGENT: agentId,
        AUN_BOOTSTRAP_LOCK_CHILD_RUN: runId,
        AUN_BOOTSTRAP_LOCK_CHILD_READY: ready,
        AUN_BOOTSTRAP_LOCK_CHILD_GO: go,
      },
    })
    const delayedReader = delayed.stdout.getReader()
    expect(await readUntil(delayedReader, /PAUSED/)).toContain('PAUSED')
    expect(existsSync(ready)).toBe(true)
    const winner = new FileBootstrapStateStore(root)
    winner.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    winner.releaseLock(agentId, runId)
    const fresh = new FileBootstrapStateStore(root)
    fresh.acquireLock(agentId, 'fresh-live-after-winner')
    const freshOwnerBefore = readFileSync(join(dir, '.lock', 'owner.json'), 'utf8')
    writeFileSync(go, 'go\n', { mode: 0o600 })
    expect(await readUntil(delayedReader, /BUSY/)).toContain('BUSY')
    expect(await delayed.exited).toBe(0)
    expect(readFileSync(join(dir, '.lock', 'owner.json'), 'utf8')).toBe(freshOwnerBefore)
    fresh.releaseLock(agentId, 'fresh-live-after-winner')
  })

  test('post-publish admission aborts across a reclaim introduced after the initial snapshot', () => {
    const { root, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const old = deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000020')
    const reclaimPath = join(dir, `.lock.reclaim-${old.nonce}`)
    seedDirectory(join(dir, '.lock'), old)

    let injected = false
    const ordinary = new FileBootstrapStateStore(root, {
      afterInitialReservedSnapshot: () => {
        if (injected) return
        injected = true
        const interruptedRecovery = new FileBootstrapStateStore(root, {
          afterReclaimRename: () => { throw new Error('injected durable reclaim pause') },
        })
        expect(() => interruptedRecovery.acquireLock(agentId, runId, { reclaimStaleSameRun: true }))
          .toThrow('injected durable reclaim pause')
        expect(existsSync(reclaimPath)).toBe(true)
        expect(existsSync(join(dir, '.lock'))).toBe(false)
      },
    })

    expect(() => ordinary.acquireLock(agentId, 'ordinary-snapshot-racer')).toThrow('NO_GO_BOOTSTRAP_BUSY')
    expect(existsSync(reclaimPath)).toBe(true)
    expect(readFileSync(join(reclaimPath, 'owner.json'), 'utf8')).toBe(`${JSON.stringify(old)}\n`)
    expect(existsSync(join(dir, '.lock'))).toBe(false)
    expect(readdirSync(dir).filter((name) => name.startsWith('.lock.aborted-acquire-'))).toHaveLength(1)

    const recovery = new FileBootstrapStateStore(root)
    recovery.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    expect(readdirSync(join(dir, '.lock')).sort()).toEqual(['acquire.ready', 'owner.json'])
    recovery.releaseLock(agentId, runId)
    const fresh = new FileBootstrapStateStore(root)
    fresh.acquireLock(agentId, 'fresh-after-snapshot-race')
    fresh.releaseLock(agentId, 'fresh-after-snapshot-race')
    expect(readdirSync(dir).filter((name) => name === '.lock' || name.startsWith('.lock.release-'))).toEqual([])
  })

  test('real process barriers prevent a snapshotted ordinary acquire crossing an interrupted official reclaim', async () => {
    const { root, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const old = deadRecord(agentId, runId, '00000000-0000-4000-8000-000000000022')
    seedDirectory(join(dir, '.lock'), old)
    const snapshotReady = join(root, 'snapshot-ready')
    const allowSnapshot = join(root, 'allow-snapshot')
    const reclaimReady = join(root, 'reclaim-ready')

    const ordinary = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE: 'snapshot-racer',
        AUN_BOOTSTRAP_LOCK_CHILD_ROOT: root,
        AUN_BOOTSTRAP_LOCK_CHILD_AGENT: agentId,
        AUN_BOOTSTRAP_LOCK_CHILD_RUN: 'ordinary-snapshot-process',
        AUN_BOOTSTRAP_LOCK_CHILD_READY: snapshotReady,
        AUN_BOOTSTRAP_LOCK_CHILD_GO: allowSnapshot,
      },
    })
    const ordinaryReader = ordinary.stdout.getReader()
    expect(await readUntil(ordinaryReader, /SNAPSHOT/)).toContain('SNAPSHOT')

    const recovery = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE: 'reclaim-hold',
        AUN_BOOTSTRAP_LOCK_CHILD_ROOT: root,
        AUN_BOOTSTRAP_LOCK_CHILD_AGENT: agentId,
        AUN_BOOTSTRAP_LOCK_CHILD_RUN: runId,
        AUN_BOOTSTRAP_LOCK_CHILD_READY: reclaimReady,
      },
    })
    const recoveryReader = recovery.stdout.getReader()
    expect(await readUntil(recoveryReader, /RECLAIMED/)).toContain('RECLAIMED')
    recovery.kill('SIGKILL')
    expect(await recovery.exited).not.toBe(0)

    writeFileSync(allowSnapshot, 'go\n', { mode: 0o600 })
    expect(await readUntil(ordinaryReader, /BUSY|WON/)).toContain('BUSY')
    expect(await ordinary.exited).toBe(0)
    expect(existsSync(join(dir, '.lock'))).toBe(false)
    const reclaimPath = join(dir, `.lock.reclaim-${old.nonce}`)
    expect(readFileSync(join(reclaimPath, 'owner.json'), 'utf8')).toBe(`${JSON.stringify(old)}\n`)
    expect(readdirSync(dir).filter((name) => name.startsWith('.lock.aborted-acquire-'))).toHaveLength(1)

    const retry = new FileBootstrapStateStore(root)
    retry.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    expect(readdirSync(join(dir, '.lock')).sort()).toEqual(['acquire.ready', 'owner.json'])
    retry.releaseLock(agentId, runId)
  })

  test('pending publish failure archives exact no-effect ownership before fresh work', () => {
    const { root, agentId } = fixture()
    const dir = join(root, agentId)
    const crashing = new FileBootstrapStateStore(root, {
      acquireDurability: (event) => {
        if (event === 'after-pending-publish') throw new Error('injected pending publish crash')
      },
    })
    expect(() => crashing.acquireLock(agentId, 'pending-crash')).toThrow('injected pending publish crash')
    expect(existsSync(join(dir, '.lock'))).toBe(false)
    expect(readdirSync(dir).filter((name) => name.startsWith('.lock.aborted-acquire-'))).toHaveLength(1)
    const fresh = new FileBootstrapStateStore(root)
    fresh.acquireLock(agentId, 'fresh-after-pending-crash')
    expect(readdirSync(join(dir, '.lock')).sort()).toEqual(['acquire.ready', 'owner.json'])
    fresh.releaseLock(agentId, 'fresh-after-pending-crash')
  })

  test('a SIGKILLed published pending lock is abort-only and ordinary work recovers it', async () => {
    const { root, agentId } = fixture()
    const dir = join(root, agentId)
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE: 'pending-hold',
        AUN_BOOTSTRAP_LOCK_CHILD_ROOT: root,
        AUN_BOOTSTRAP_LOCK_CHILD_AGENT: agentId,
        AUN_BOOTSTRAP_LOCK_CHILD_RUN: 'pending-killed-run',
      },
    })
    const reader = child.stdout.getReader()
    expect(await readUntil(reader, /PENDING/)).toContain('PENDING')
    expect(readdirSync(join(dir, '.lock')).sort()).toEqual(['acquire.pending', 'owner.json'])
    child.kill('SIGKILL')
    expect(await child.exited).not.toBe(0)

    const ordinary = new FileBootstrapStateStore(root)
    ordinary.acquireLock(agentId, 'ordinary-after-killed-pending')
    expect(readdirSync(join(dir, '.lock')).sort()).toEqual(['acquire.ready', 'owner.json'])
    expect(readdirSync(dir).filter((name) => name.startsWith('.lock.aborted-acquire-'))).toHaveLength(1)
    ordinary.releaseLock(agentId, 'ordinary-after-killed-pending')
  })

  test('a SIGKILL after ready rename is durability-closed before official recovery admission', async () => {
    const { root, agentId, runId } = fixture()
    const dir = join(root, agentId)
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        AUN_BOOTSTRAP_LOCK_CHILD_FIXTURE: 'ready-hold',
        AUN_BOOTSTRAP_LOCK_CHILD_ROOT: root,
        AUN_BOOTSTRAP_LOCK_CHILD_AGENT: agentId,
        AUN_BOOTSTRAP_LOCK_CHILD_RUN: runId,
      },
    })
    const reader = child.stdout.getReader()
    expect(await readUntil(reader, /READY/)).toContain('READY')
    expect(readdirSync(join(dir, '.lock')).sort()).toEqual(['acquire.ready', 'owner.json'])
    child.kill('SIGKILL')
    expect(await child.exited).not.toBe(0)

    const trace: string[] = []
    const recovery = new FileBootstrapStateStore(root, {
      readyObserverDurability: (event) => trace.push(event),
    })
    recovery.acquireLock(agentId, runId, { reclaimStaleSameRun: true })
    expect(trace).toEqual([
      'after-marker-fsync',
      'after-lock-fsync',
      'after-agent-fsync',
      'after-strict-reread',
    ])
    const reclaim = readdirSync(dir).find((name) => name.startsWith('.lock.reclaim-'))!
    expect(readdirSync(join(dir, reclaim)).sort()).toEqual([
      'acquire.ready', 'owner.json', 'reclaim.complete',
    ])
    recovery.releaseLock(agentId, runId)
  })
})
