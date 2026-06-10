import { resolveTokenSourceRef, type TokenSourceEnv } from './token-source-ref'

export type DiscordCredentialPromotionReason =
  | 'already_active'
  | 'connector_credential_missing'
  | 'expected_identity_missing'
  | 'expected_identity_conflict'
  | 'binding_missing'
  | 'provider_write_access_missing'
  | 'token_unresolved'
  | 'token_identity_mismatch'
  | 'token_identity_verification_failed'
  | 'promoted'

export type DiscordCredentialPromotionResult = {
  ok: boolean
  promoted: boolean
  reason: DiscordCredentialPromotionReason
  agentId: string
  provider: 'discord'
  connectorInstanceId: string | null
  credentialId: string | null
  connectorStatusBefore: string | null
  credentialStatusBefore: string | null
  connectorStatusAfter: string | null
  credentialStatusAfter: string | null
  channelBindingId: string | null
  providerChannelAccessId: string | null
  expectedProviderSubjectId: string | null
  observedProviderSubjectId: string | null
  evidence: Record<string, unknown>
}

export type DiscordTokenIdentityVerificationInput = {
  token: string
  tokenSource: string
  provider: 'discord'
  agentId: string
  connectorInstanceId: string
  credentialId: string
  expectedProviderSubjectId: string
}

export type DiscordTokenIdentityVerificationResult = {
  ok: boolean
  providerSubjectId: string | null
  providerHandle?: string | null
  errorCode?: string
  evidence?: Record<string, unknown>
}

export type DiscordTokenIdentityVerifier = (
  input: DiscordTokenIdentityVerificationInput,
) => Promise<DiscordTokenIdentityVerificationResult>

export type ReconcileDiscordDeliveryCredentialPromotionOptions = {
  agentId: string
  channelId?: string | null
  actor?: string
  env?: TokenSourceEnv
  verifyTokenIdentity?: DiscordTokenIdentityVerifier
  now?: () => Date
}

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] } | any[]>
}

function rowsOf(result: { rows: any[] } | any[]): any[] {
  if (Array.isArray(result)) return result
  return Array.isArray(result.rows) ? result.rows : []
}

async function queryRows(db: Queryable, sql: string, params?: unknown[]): Promise<any[]> {
  try {
    return rowsOf(await db.query(sql, params))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/(does not exist|no such table|no such column|column .* does not exist)/i.test(message)) return []
    throw err
  }
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
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

function expectedSubjectFromProfile(raw: unknown, provider: 'discord'): string | null {
  const identity = parseJsonObject(raw)
  const identityProvider = firstString(identity.provider)
  if (identityProvider && identityProvider !== provider) return null
  return firstString(identity.subject_id ?? identity.provider_subject_id ?? identity.id)
}

function hasWriteCapability(raw: unknown): boolean {
  const capabilities = parseJsonObject(raw)
  return ['message_create', 'can_write', 'write', 'send_messages', 'outbound'].some((key) => {
    const value = capabilities[key]
    return value === true || value === 1 || value === 'true' || value === '1'
  })
}

function capabilityKeys(raw: unknown): string[] {
  const capabilities = parseJsonObject(raw)
  return Object.entries(capabilities)
    .filter(([, value]) => value === true || value === 1 || value === 'true' || value === '1')
    .map(([key]) => key)
    .sort()
}

function baseResult(
  options: {
    agentId: string
    reason: DiscordCredentialPromotionReason
    ok?: boolean
    promoted?: boolean
    connectorInstanceId?: string | null
    credentialId?: string | null
    connectorStatusBefore?: string | null
    credentialStatusBefore?: string | null
    connectorStatusAfter?: string | null
    credentialStatusAfter?: string | null
    channelBindingId?: string | null
    providerChannelAccessId?: string | null
    expectedProviderSubjectId?: string | null
    observedProviderSubjectId?: string | null
    evidence?: Record<string, unknown>
  },
): DiscordCredentialPromotionResult {
  return {
    ok: options.ok ?? false,
    promoted: options.promoted ?? false,
    reason: options.reason,
    agentId: options.agentId,
    provider: 'discord',
    connectorInstanceId: options.connectorInstanceId ?? null,
    credentialId: options.credentialId ?? null,
    connectorStatusBefore: options.connectorStatusBefore ?? null,
    credentialStatusBefore: options.credentialStatusBefore ?? null,
    connectorStatusAfter: options.connectorStatusAfter ?? options.connectorStatusBefore ?? null,
    credentialStatusAfter: options.credentialStatusAfter ?? options.credentialStatusBefore ?? null,
    channelBindingId: options.channelBindingId ?? null,
    providerChannelAccessId: options.providerChannelAccessId ?? null,
    expectedProviderSubjectId: options.expectedProviderSubjectId ?? null,
    observedProviderSubjectId: options.observedProviderSubjectId ?? null,
    evidence: options.evidence ?? {},
  }
}

export async function verifyDiscordBotTokenIdentity(
  input: DiscordTokenIdentityVerificationInput,
): Promise<DiscordTokenIdentityVerificationResult> {
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: {
      authorization: `Bot ${input.token}`,
      accept: 'application/json',
    },
  })
  const evidence: Record<string, unknown> = {
    provider_api: 'discord.users.@me',
    http_status: response.status,
  }
  if (!response.ok) {
    return {
      ok: false,
      providerSubjectId: null,
      errorCode: `discord_http_${response.status}`,
      evidence,
    }
  }

  const body = await response.json().catch(() => null)
  const providerSubjectId = firstString((body as any)?.id)
  const providerHandle = firstString((body as any)?.username)
  evidence.identity_resolved = providerSubjectId !== null
  evidence.provider_subject_match = providerSubjectId === input.expectedProviderSubjectId
  return {
    ok: providerSubjectId === input.expectedProviderSubjectId,
    providerSubjectId,
    providerHandle,
    evidence,
  }
}

async function expectedProviderIdentity(
  db: Queryable,
  agentId: string,
): Promise<{
  subjectId: string | null
  providerIdentityId: string | null
  conflict: boolean
  evidence: Record<string, unknown>
}> {
  const agentRows = await queryRows(
    db,
    `SELECT expected_provider_identity
       FROM agents
      WHERE agent_id = $1
      LIMIT 1`,
    [agentId],
  )
  const profileSubjectId = expectedSubjectFromProfile(agentRows[0]?.expected_provider_identity, 'discord')
  const identityRows = await queryRows(
    db,
    `SELECT provider_identity_id,
            provider_subject_id,
            COALESCE(status, 'expected') AS status
       FROM agent_provider_identities
      WHERE agent_id = $1
        AND provider = 'discord'
        AND COALESCE(status, 'expected') IN ('expected', 'verified')
      ORDER BY CASE COALESCE(status, 'expected') WHEN 'verified' THEN 0 ELSE 1 END,
               updated_at DESC,
               created_at DESC
      LIMIT 5`,
    [agentId],
  )
  const subjects = Array.from(new Set(identityRows.map((row) => firstString(row.provider_subject_id)).filter(Boolean))) as string[]
  const identitySubjectId = subjects[0] ?? null
  const subjectId = identitySubjectId ?? profileSubjectId
  const conflict = subjects.length > 1 || Boolean(profileSubjectId && identitySubjectId && profileSubjectId !== identitySubjectId)
  return {
    subjectId,
    providerIdentityId: firstString(identityRows[0]?.provider_identity_id),
    conflict,
    evidence: {
      profile_expected_subject_present: profileSubjectId !== null,
      identity_expected_subject_present: identitySubjectId !== null,
      provider_identity_id: firstString(identityRows[0]?.provider_identity_id),
    },
  }
}

async function connectorCredentialCandidate(db: Queryable, agentId: string): Promise<any | null> {
  const rows = await queryRows(
    db,
    `SELECT ci.connector_instance_id,
            COALESCE(ci.status, 'registered') AS connector_status,
            COALESCE(ci.trust_status, 'local') AS connector_trust_status,
            ci.disabled_at AS connector_disabled_at,
            cc.credential_id,
            COALESCE(cc.status, 'registered') AS credential_status,
            COALESCE(cc.trust_status, 'local') AS credential_trust_status,
            cc.secret_ref,
            cc.disabled_at AS credential_disabled_at,
            cc.revoked_at AS credential_revoked_at
       FROM connector_instances ci
       JOIN connector_credentials cc
         ON cc.connector_instance_id = ci.connector_instance_id
        AND cc.provider = ci.provider
        AND cc.agent_id = ci.agent_id
      WHERE ci.provider = 'discord'
        AND ci.agent_id = $1
        AND ci.connector_kind = 'chat_adapter'
        AND cc.credential_kind = 'bot_token'
        AND COALESCE(cc.secret_ref, '') <> ''
        AND COALESCE(ci.status, 'registered') IN ('registered', 'active')
        AND COALESCE(cc.status, 'registered') IN ('registered', 'active')
        AND COALESCE(ci.trust_status, 'local') NOT IN ('revoked', 'disabled')
        AND COALESCE(cc.trust_status, 'local') NOT IN ('revoked', 'disabled')
        AND ci.disabled_at IS NULL
        AND cc.disabled_at IS NULL
        AND cc.revoked_at IS NULL
      ORDER BY
        CASE WHEN ci.connector_uri = $2 THEN 0 ELSE 1 END,
        CASE COALESCE(ci.status, 'registered') WHEN 'active' THEN 0 ELSE 1 END,
        CASE COALESCE(cc.status, 'registered') WHEN 'active' THEN 0 ELSE 1 END,
        cc.updated_at DESC,
        cc.created_at DESC
      LIMIT 1`,
    [agentId, `discord://agents/${agentId}`],
  )
  return rows[0] ?? null
}

async function channelWriteEvidence(
  db: Queryable,
  input: { agentId: string; connectorInstanceId: string; channelId?: string | null },
): Promise<any | null> {
  const rows = await queryRows(
    db,
    `SELECT b.channel_binding_id,
            b.channel_id,
            b.priority,
            COALESCE(ca.external_id, b.channel_id) AS provider_channel_id,
            pca.provider_channel_access_id,
            pca.capabilities
       FROM channel_connector_bindings b
       LEFT JOIN channel_adapters ca
         ON ca.channel_id = b.channel_id
        AND ca.platform = b.provider
       JOIN provider_channel_access pca
         ON pca.provider = b.provider
        AND pca.connector_instance_id = b.connector_instance_id
        AND pca.provider_channel_id = COALESCE(ca.external_id, b.channel_id)
        AND (pca.agent_id IS NULL OR pca.agent_id = $3)
        AND COALESCE(pca.status, 'active') = 'active'
        AND COALESCE(pca.trust_status, 'local') NOT IN ('revoked', 'disabled')
      WHERE b.provider = 'discord'
        AND b.connector_instance_id = $1
        AND COALESCE(b.status, 'active') = 'active'
        AND b.binding_role IN ('outbound', 'bidirectional', 'projection')
        AND ($2 IS NULL OR b.channel_id = $2)
      ORDER BY b.priority,
               b.channel_binding_id,
               pca.provider_channel_access_id
      LIMIT 10`,
    [input.connectorInstanceId, input.channelId ?? null, input.agentId],
  )
  return rows.find((row) => hasWriteCapability(row.capabilities)) ?? null
}

async function insertPromotionAudit(
  db: Queryable,
  input: {
    actor: string
    agentId: string
    promotedAt: string
    connectorInstanceId: string
    credentialId: string
    connectorStatusBefore: string
    credentialStatusBefore: string
    channelBindingId: string
    providerChannelAccessId: string
    providerChannelId: string
    expectedProviderSubjectId: string
    observedProviderSubjectId: string
    providerIdentityId: string | null
    tokenSource: string
    capabilityKeys: string[]
    verifierEvidence: Record<string, unknown>
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      'connector_credential.delivery_promotion',
      input.actor,
      input.agentId,
      JSON.stringify({
        actor: input.actor,
        promoted_at: input.promotedAt,
        target_agent_id: input.agentId,
        provider: 'discord',
        connector_instance_id: input.connectorInstanceId,
        credential_id: input.credentialId,
        status_transition: {
          connector_instance: { from: input.connectorStatusBefore, to: 'active' },
          connector_credential: { from: input.credentialStatusBefore, to: 'active' },
        },
        evidence: {
          token_identity: {
            expected_provider_subject_id: input.expectedProviderSubjectId,
            observed_provider_subject_id: input.observedProviderSubjectId,
            provider_identity_id: input.providerIdentityId,
            token_source: input.tokenSource,
            verifier: input.verifierEvidence,
          },
          channel_write_capability: {
            channel_binding_id: input.channelBindingId,
            provider_channel_access_id: input.providerChannelAccessId,
            provider_channel_id: input.providerChannelId,
            capability_keys: input.capabilityKeys,
          },
        },
      }),
      'default',
    ],
  )
}

export async function reconcileDiscordDeliveryCredentialPromotion(
  db: Queryable,
  options: ReconcileDiscordDeliveryCredentialPromotionOptions,
): Promise<DiscordCredentialPromotionResult> {
  const agentId = options.agentId.trim()
  const actor = options.actor?.trim() || 'system'
  const now = options.now ?? (() => new Date())
  const verifier = options.verifyTokenIdentity ?? verifyDiscordBotTokenIdentity
  const candidate = await connectorCredentialCandidate(db, agentId)
  if (!candidate) {
    return baseResult({
      agentId,
      reason: 'connector_credential_missing',
    })
  }

  const connectorInstanceId = firstString(candidate.connector_instance_id)
  const credentialId = firstString(candidate.credential_id)
  const connectorStatusBefore = firstString(candidate.connector_status) ?? 'registered'
  const credentialStatusBefore = firstString(candidate.credential_status) ?? 'registered'
  if (!connectorInstanceId || !credentialId) {
    return baseResult({
      agentId,
      reason: 'connector_credential_missing',
      connectorInstanceId,
      credentialId,
      connectorStatusBefore,
      credentialStatusBefore,
    })
  }
  if (connectorStatusBefore === 'active' && credentialStatusBefore === 'active') {
    return baseResult({
      agentId,
      reason: 'already_active',
      ok: true,
      connectorInstanceId,
      credentialId,
      connectorStatusBefore,
      credentialStatusBefore,
      evidence: {
        status: 'already_active',
      },
    })
  }

  const expected = await expectedProviderIdentity(db, agentId)
  if (expected.conflict) {
    return baseResult({
      agentId,
      reason: 'expected_identity_conflict',
      connectorInstanceId,
      credentialId,
      connectorStatusBefore,
      credentialStatusBefore,
      expectedProviderSubjectId: expected.subjectId,
      evidence: expected.evidence,
    })
  }
  if (!expected.subjectId) {
    return baseResult({
      agentId,
      reason: 'expected_identity_missing',
      connectorInstanceId,
      credentialId,
      connectorStatusBefore,
      credentialStatusBefore,
      evidence: expected.evidence,
    })
  }

  const writeEvidence = await channelWriteEvidence(db, {
    agentId,
    connectorInstanceId,
    channelId: options.channelId ?? null,
  })
  if (!writeEvidence) {
    return baseResult({
      agentId,
      reason: options.channelId ? 'binding_missing' : 'provider_write_access_missing',
      connectorInstanceId,
      credentialId,
      connectorStatusBefore,
      credentialStatusBefore,
      expectedProviderSubjectId: expected.subjectId,
      evidence: {
        ...expected.evidence,
        channel_id: options.channelId ?? null,
      },
    })
  }

  const resolved = resolveTokenSourceRef(firstString(candidate.secret_ref), options.env ?? process.env)
  if (!resolved) {
    return baseResult({
      agentId,
      reason: 'token_unresolved',
      connectorInstanceId,
      credentialId,
      connectorStatusBefore,
      credentialStatusBefore,
      channelBindingId: firstString(writeEvidence.channel_binding_id),
      providerChannelAccessId: firstString(writeEvidence.provider_channel_access_id),
      expectedProviderSubjectId: expected.subjectId,
      evidence: {
        token_source_resolved: false,
        channel_write_capability_verified: true,
      },
    })
  }

  const verified = await verifier({
    token: resolved.token,
    tokenSource: resolved.source,
    provider: 'discord',
    agentId,
    connectorInstanceId,
    credentialId,
    expectedProviderSubjectId: expected.subjectId,
  }).catch((err) => ({
    ok: false,
    providerSubjectId: null,
    errorCode: 'token_identity_verifier_error',
    evidence: {
      error: err instanceof Error ? err.message : String(err),
    },
  }))
  if (!verified.ok || verified.providerSubjectId !== expected.subjectId) {
    return baseResult({
      agentId,
      reason: verified.providerSubjectId ? 'token_identity_mismatch' : 'token_identity_verification_failed',
      connectorInstanceId,
      credentialId,
      connectorStatusBefore,
      credentialStatusBefore,
      channelBindingId: firstString(writeEvidence.channel_binding_id),
      providerChannelAccessId: firstString(writeEvidence.provider_channel_access_id),
      expectedProviderSubjectId: expected.subjectId,
      observedProviderSubjectId: verified.providerSubjectId,
      evidence: {
        token_source_resolved: true,
        channel_write_capability_verified: true,
        verifier: verified.evidence ?? {},
        error_code: verified.errorCode ?? null,
      },
    })
  }

  const promotedAt = now().toISOString()
  await db.query(
    `UPDATE connector_instances
        SET status = CASE WHEN status = 'registered' THEN 'active' ELSE status END,
            trust_status = CASE WHEN trust_status = 'local' THEN 'verified' ELSE trust_status END,
            updated_at = now(),
            last_seen_at = COALESCE(last_seen_at, now())
      WHERE connector_instance_id = $1
        AND status IN ('registered', 'active')`,
    [connectorInstanceId],
  )
  await db.query(
    `UPDATE connector_credentials
        SET status = CASE WHEN status = 'registered' THEN 'active' ELSE status END,
            trust_status = CASE WHEN trust_status = 'local' THEN 'verified' ELSE trust_status END,
            last_verified_at = now(),
            updated_at = now()
      WHERE credential_id = $1
        AND status IN ('registered', 'active')`,
    [credentialId],
  )
  await insertPromotionAudit(db, {
    actor,
    agentId,
    promotedAt,
    connectorInstanceId,
    credentialId,
    connectorStatusBefore,
    credentialStatusBefore,
    channelBindingId: firstString(writeEvidence.channel_binding_id) ?? '',
    providerChannelAccessId: firstString(writeEvidence.provider_channel_access_id) ?? '',
    providerChannelId: firstString(writeEvidence.provider_channel_id) ?? firstString(writeEvidence.channel_id) ?? '',
    expectedProviderSubjectId: expected.subjectId,
    observedProviderSubjectId: verified.providerSubjectId,
    providerIdentityId: expected.providerIdentityId,
    tokenSource: resolved.source,
    capabilityKeys: capabilityKeys(writeEvidence.capabilities),
    verifierEvidence: verified.evidence ?? {},
  })

  return baseResult({
    agentId,
    reason: 'promoted',
    ok: true,
    promoted: true,
    connectorInstanceId,
    credentialId,
    connectorStatusBefore,
    credentialStatusBefore,
    connectorStatusAfter: 'active',
    credentialStatusAfter: 'active',
    channelBindingId: firstString(writeEvidence.channel_binding_id),
    providerChannelAccessId: firstString(writeEvidence.provider_channel_access_id),
    expectedProviderSubjectId: expected.subjectId,
    observedProviderSubjectId: verified.providerSubjectId,
    evidence: {
      token_source_resolved: true,
      token_identity_verified: true,
      channel_write_capability_verified: true,
      provider_identity_id: expected.providerIdentityId,
      capability_keys: capabilityKeys(writeEvidence.capabilities),
    },
  })
}
