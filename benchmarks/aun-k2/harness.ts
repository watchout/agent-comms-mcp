import { createHash, randomUUID } from 'node:crypto'
import { cpus, platform, release, totalmem } from 'node:os'
import { Client } from 'pg'
import { K2_BENCHMARK_PROFILES, type K2ProfileName } from './profiles'

export interface K2BenchmarkContext {
  sourceSha: string
  treeHash: string
  configDigest: string
  policyDigest: string
  databaseVersion?: string
  generatedAt?: string
  runId?: string
}

function guardedFixtureTarget(): { url: string; name: string } {
  if (process.env.AUN_K2_DB_SCOPE !== 'isolated_disposable_fixture') {
    throw new Error('AUN_K2_DB_SCOPE must equal isolated_disposable_fixture for measured benchmark mode')
  }
  const url = process.env.AUN_K2_TEST_DATABASE_URL
  if (!url) throw new Error('AUN_K2_TEST_DATABASE_URL is required for measured benchmark mode')
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== url) {
    throw new Error('DATABASE_URL must be absent or equal AUN_K2_TEST_DATABASE_URL')
  }
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!name.startsWith('aun_k2_fixture_')) throw new Error(`unsafe K2 fixture database ${name}`)
  return { url, name }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function canonicalK2BenchmarkJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function k2BenchmarkDigest(value: unknown): string {
  return createHash('sha256').update(canonicalK2BenchmarkJson(value)).digest('hex')
}

function validateContext(context: K2BenchmarkContext): void {
  if (!/^[a-f0-9]{40}$/.test(context.sourceSha)) throw new Error('sourceSha must be a lowercase 40-character SHA')
  if (!/^[a-f0-9]{40}$/.test(context.treeHash)) throw new Error('treeHash must be a lowercase 40-character tree hash')
  for (const [name, digest] of [['configDigest', context.configDigest], ['policyDigest', context.policyDigest]]) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${name} must be a lowercase SHA-256 digest`)
  }
}

export function buildK2BenchmarkPlan(profileName: K2ProfileName, context: K2BenchmarkContext) {
  validateContext(context)
  const profile = K2_BENCHMARK_PROFILES[profileName]
  const subject = {
    schema_version: 'aun-k2-benchmark-plan/v1',
    profile,
    source_sha: context.sourceSha,
    tree_hash: context.treeHash,
    config_digest: context.configDigest,
    policy_digest: context.policyDigest,
    database_version: context.databaseVersion ?? 'not_observed_plan_only',
  }
  return {
    ...subject,
    execution: 'plan_only' as const,
    behavior_proven: false as const,
    production_apply: false as const,
    shared_database_connections: 0,
    real_model_calls: 0,
    provider_calls: 0,
    V1_calls: 0,
    hardware: {
      cpu: cpus()[0]?.model ?? 'unknown',
      logical_cpus: cpus().length,
      memory_bytes: totalmem(),
      platform: `${platform()} ${release()}`,
    },
    plan_digest: k2BenchmarkDigest(subject),
    generated_at: context.generatedAt ?? new Date().toISOString(),
    run_id: context.runId ?? randomUUID(),
  }
}

export async function runK2IdleBenchmark(profileName: K2ProfileName, context: K2BenchmarkContext) {
  validateContext(context)
  const target = guardedFixtureTarget()
  const profile = K2_BENCHMARK_PROFILES[profileName]
  const repetitions = []
  const seats = Array.from({ length: profile.seats }, (_, index) => `seat-${String(index + 1).padStart(3, '0')}`)
  const client = new Client({ connectionString: target.url })
  let actualQueryCount = 0
  let connectionClosed = false
  let databaseVersion = ''
  let observedDatabase = ''
  try {
    await client.connect()
    const versionResult = await client.query<{ server_version: string }>('SHOW server_version')
    actualQueryCount += 1
    databaseVersion = versionResult.rows[0]?.server_version ?? ''
    const databaseResult = await client.query<{ database_name: string }>('SELECT current_database()::text AS database_name')
    actualQueryCount += 1
    observedDatabase = databaseResult.rows[0]?.database_name ?? ''
    if (observedDatabase !== target.name) throw new Error(`database identity drift: expected ${target.name}, observed ${observedDatabase}`)
    if (!/^16(?:\.|$)/.test(databaseVersion)) throw new Error(`PostgreSQL 16 required, observed ${databaseVersion || 'unknown'}`)

    for (let repetition = 1; repetition <= profile.repetitions; repetition++) {
      const usageBefore = process.cpuUsage()
      const started = performance.now()
      let polls = 0
      let seatScanObservations = 0
      let maxRss = process.memoryUsage.rss()
      while (performance.now() - started < profile.idle_duration_ms) {
        await delay(Math.max(0, Math.min(profile.safety_poll_interval_ms, profile.idle_duration_ms - (performance.now() - started))))
        await client.query('SELECT 1 AS aun_k2_idle_safety_poll')
        actualQueryCount += 1
        polls += 1
        // One process-wide safety query supplies all frozen fake seat
        // projections; local iteration models result inspection only.
        for (const _seat of seats) seatScanObservations += 1
        maxRss = Math.max(maxRss, process.memoryUsage.rss())
      }
      const elapsedMs = performance.now() - started
      const cpu = process.cpuUsage(usageBefore)
      const cpuPercent = ((cpu.user + cpu.system) / 1_000) / elapsedMs * 100
      const pollQps = polls / (elapsedMs / 1_000)
      const rssMiB = maxRss / 1024 / 1024
      repetitions.push({
        repetition,
        elapsed_ms: elapsedMs,
        cpu_percent: cpuPercent,
        db_safety_poll_queries: polls,
        db_safety_poll_qps_per_process: pollQps,
        seat_count: seats.length,
        seat_scan_observations: seatScanObservations,
        rss_mib: rssMiB,
        real_model_calls: 0,
        provider_calls: 0,
        passed: cpuPercent < 1 && pollQps <= 0.5 && rssMiB <= 256,
      })
    }
  } finally {
    await client.end()
    connectionClosed = true
  }
  const plan = buildK2BenchmarkPlan(profileName, { ...context, databaseVersion })
  const dimensionsPresent = Boolean(
    observedDatabase && databaseVersion && actualQueryCount >= 2 &&
    repetitions.length === profile.repetitions && connectionClosed,
  )
  const result = {
    ...plan,
    schema_version: 'aun-k2-benchmark-result/v1',
    execution: 'guarded_disposable_postgresql_measurement' as const,
    behavior_proven: dimensionsPresent && repetitions.every(item => item.passed),
    database: {
      identity: observedDatabase,
      version: databaseVersion,
      required_major: 16,
      url_source: 'AUN_K2_TEST_DATABASE_URL',
      actual_query_count: actualQueryCount,
      safety_poll_query_count: repetitions.reduce((sum, item) => sum + item.db_safety_poll_queries, 0),
      connection_closed: connectionClosed,
      fixture_cleanup_owner: 'evidence_runner',
    },
    measurement_dimensions_present: dimensionsPresent,
    repetitions,
  }
  return { ...result, result_digest: k2BenchmarkDigest(result) }
}
