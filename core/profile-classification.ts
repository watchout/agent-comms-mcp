export type ProfileLike = {
  agent_id?: unknown
  agent_type?: unknown
  status?: unknown
  metadata?: unknown
  profile_enabled?: unknown
  disabled_at?: unknown
}

export type ProfileExclusionReason = 'disabled_profile' | 'test_profile' | null

export function normalizeText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const value = String(raw).trim()
  return value.length > 0 ? value : null
}

export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function profileEnabled(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  const value = String(raw).trim().toLowerCase()
  if (!value) return true
  return !['0', 'false', 'no', 'off', 'disabled'].includes(value)
}

export function isDisabledProfile(row: ProfileLike): boolean {
  if (!profileEnabled(row.profile_enabled)) return true
  if (normalizeText(row.disabled_at) !== null) return true
  const status = normalizeText(row.status)?.toLowerCase()
  if (status === 'disabled') return true
  const metadata = parseJsonObject(row.metadata)
  const lifecycle = normalizeText(metadata.lifecycle)?.toLowerCase()
  const profileClass = normalizeText(metadata.profile_class)?.toLowerCase()
  return lifecycle === 'disabled' || profileClass === 'disabled'
}

export function isTestProfile(row: ProfileLike): boolean {
  const metadata = parseJsonObject(row.metadata)
  if (metadata.test_profile === true) return true
  const lifecycle = normalizeText(metadata.lifecycle)?.toLowerCase()
  const profileClass = normalizeText(metadata.profile_class)?.toLowerCase()
  if (lifecycle === 'test' || lifecycle === 'disabled-test') return true
  if (profileClass === 'test' || profileClass === 'disabled-test') return true
  const agentType = normalizeText(row.agent_type)?.toLowerCase()
  if (agentType === 'test') return true
  const agentId = normalizeText(row.agent_id)?.toLowerCase() ?? ''
  return agentId === 'test' || /^test[-_]/.test(agentId) || /[-_]test$/.test(agentId)
}

export function profileExclusionReason(
  row: ProfileLike,
  options: { includeDisabledProfiles?: boolean; includeTestProfiles?: boolean } = {},
): ProfileExclusionReason {
  if (!options.includeDisabledProfiles && isDisabledProfile(row)) return 'disabled_profile'
  if (!options.includeTestProfiles && isTestProfile(row)) return 'test_profile'
  return null
}
