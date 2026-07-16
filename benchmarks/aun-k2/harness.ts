import { createHash, randomUUID } from 'node:crypto'
import { cpus, platform, release, totalmem } from 'node:os'
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
  const profile = K2_BENCHMARK_PROFILES[profileName]
  const repetitions = []
  const seats = Array.from({ length: profile.seats }, (_, index) => `seat-${String(index + 1).padStart(3, '0')}`)
  for (let repetition = 1; repetition <= profile.repetitions; repetition++) {
    const usageBefore = process.cpuUsage()
    const started = performance.now()
    let polls = 0
    let seatScanObservations = 0
    let maxRss = process.memoryUsage.rss()
    while (performance.now() - started < profile.idle_duration_ms) {
      await Bun.sleep(Math.max(0, Math.min(profile.safety_poll_interval_ms, profile.idle_duration_ms - (performance.now() - started))))
      polls += 1
      // One process-wide safety query supplies all seat projections. Iterating
      // the frozen fake seats models result inspection without turning one
      // safety poll into N database queries.
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
      db_safety_poll_qps_per_process: pollQps,
      seat_count: seats.length,
      seat_scan_observations: seatScanObservations,
      rss_mib: rssMiB,
      real_model_calls: 0,
      provider_calls: 0,
      passed: cpuPercent < 1 && pollQps <= 0.5 && rssMiB <= 256,
    })
  }
  const plan = buildK2BenchmarkPlan(profileName, context)
  const result = {
    ...plan,
    schema_version: 'aun-k2-benchmark-result/v1',
    execution: 'isolated_fake_measurement' as const,
    behavior_proven: repetitions.every(item => item.passed),
    repetitions,
  }
  return { ...result, result_digest: k2BenchmarkDigest(result) }
}
