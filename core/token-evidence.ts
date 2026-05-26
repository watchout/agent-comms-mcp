export const TOKEN_EVIDENCE_COLUMNS = [
  'agents.provider_token_source_ref',
  'agents.discord_token (legacy SQLite only)',
  'agents.metadata token reference/fingerprint',
  'connector_instances.metadata token reference/fingerprint',
  'connector_credentials.secret_ref',
  'connector_credentials.metadata token reference/fingerprint',
  'agent_ui_bindings.ui_token_ref',
  'agent_ui_bindings.metadata token reference/fingerprint',
]

const TOKEN_METADATA_KEYS = [
  'provider_token_source_ref',
  'token_source_ref',
  'discord_token_ref',
  'ui_token_ref',
  'token_ref',
  'token_fingerprint',
  'discord_token_fingerprint',
  'ui_token_fingerprint',
]

export interface TokenEvidenceAgentRow {
  provider_token_source_ref?: unknown
  discord_token?: unknown
  metadata?: unknown
}

export interface TokenEvidenceConnectorRow {
  metadata?: unknown
}

export interface TokenEvidenceCredentialRow {
  secret_ref?: unknown
  metadata?: unknown
}

export interface TokenEvidenceUiBindingRow {
  ui_token_ref?: unknown
  metadata?: unknown
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value === true
}

function collectMetadataTokenEvidence(metadata: Record<string, unknown>, prefix: string): string[] {
  const evidence: string[] = []
  for (const key of TOKEN_METADATA_KEYS) {
    if (hasValue(metadata[key])) evidence.push(`${prefix}.${key}`)
  }
  if (metadata.token_source_ref_set === true) evidence.push(`${prefix}.token_source_ref_set`)
  return evidence
}

export function collectTokenEvidence(input: {
  agent?: TokenEvidenceAgentRow | null
  connector?: TokenEvidenceConnectorRow | null
  credential?: TokenEvidenceCredentialRow | null
  uiBinding?: TokenEvidenceUiBindingRow | null
}): string[] {
  const evidence: string[] = []
  if (hasValue(input.agent?.provider_token_source_ref)) evidence.push('agents.provider_token_source_ref')
  if (hasValue(input.agent?.discord_token)) evidence.push('agents.discord_token')
  evidence.push(...collectMetadataTokenEvidence(parseJsonObject(input.agent?.metadata), 'agents.metadata'))
  evidence.push(...collectMetadataTokenEvidence(parseJsonObject(input.connector?.metadata), 'connector_instances.metadata'))
  if (hasValue(input.credential?.secret_ref)) evidence.push('connector_credentials.secret_ref')
  evidence.push(...collectMetadataTokenEvidence(parseJsonObject(input.credential?.metadata), 'connector_credentials.metadata'))
  if (hasValue(input.uiBinding?.ui_token_ref)) evidence.push('agent_ui_bindings.ui_token_ref')
  evidence.push(...collectMetadataTokenEvidence(parseJsonObject(input.uiBinding?.metadata), 'agent_ui_bindings.metadata'))
  return [...new Set(evidence)]
}
