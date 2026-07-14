import { createHash, randomUUID } from 'node:crypto'
import { cpus, totalmem } from 'node:os'
import { ACCEPTANCE, PROFILES, SPECIMEN_IDS, type ProfileName } from './profiles'

export interface PlanContext {
  sourceSha: string
  treeDigest: string
  databaseVersion?: string
  generatedAt?: string
  runId?: string
  hardware?: { cpu: string; memory_bytes: number }
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

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function buildBenchmarkPlan(profileName: ProfileName, context: PlanContext) {
  if (!/^[a-f0-9]{40}$/.test(context.sourceSha)) throw new Error('sourceSha must be a 40-character lowercase git SHA')
  if (!/^[a-f0-9]{40,64}$/.test(context.treeDigest)) throw new Error('treeDigest must be a lowercase git or SHA-256 digest')

  const profile = PROFILES[profileName]
  const acceptance = ACCEPTANCE.map(([id, predicate]) => ({ id, predicate, status: 'not_measured' as const, measured: null }))
  const configDigest = sha256({ schema_version: 'aun-k0-profile-set/v1', profiles: PROFILES })
  const policyDigest = sha256({
    schema_version: 'aun-k0-owner-acceptance/v1',
    acceptance: ACCEPTANCE,
    specimens: SPECIMEN_IDS,
  })

  const digestSubject = {
    schema_version: 'aun-k0-benchmark-plan-digest/v1',
    profile: profileName,
    source_sha: context.sourceSha,
    tree_digest: context.treeDigest,
    config_digest: configDigest,
    policy_digest: policyDigest,
    database: { kind: profile.database, version: context.databaseVersion ?? 'not_observed_plan_only' },
    payload_profile: profile.payload_profile,
    worker_count: profile.worker_count,
    profile_plan: profile,
    acceptance,
    specimens: SPECIMEN_IDS,
  }

  return {
    schema_version: 'aun-k0-benchmark-result/v1',
    mode: 'plan' as const,
    profile: profileName,
    contract_valid: acceptance.length === 15 && SPECIMEN_IDS.length === 12,
    behavior_proven: false as const,
    source_sha: context.sourceSha,
    tree_digest: context.treeDigest,
    config_digest: configDigest,
    policy_digest: policyDigest,
    database: digestSubject.database,
    hardware: context.hardware ?? {
      cpu: cpus()[0]?.model ?? 'unknown',
      memory_bytes: totalmem(),
    },
    payload_profile: profile.payload_profile,
    worker_count: profile.worker_count,
    acceptance,
    specimens: [...SPECIMEN_IDS],
    plan_digest: sha256(digestSubject),
    generated_at: context.generatedAt ?? new Date().toISOString(),
    run_id: context.runId ?? randomUUID(),
  }
}
