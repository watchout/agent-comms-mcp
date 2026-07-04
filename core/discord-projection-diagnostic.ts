import {
  outboundProjectionSkipCode,
  outboundProjectionSkipReason,
  resolveOutboundProjectionDecision,
  toEffectiveDeliveryOwnerResult,
  type DeliveryConsumerDiagnostic,
  type DeliveryConsumerEvidence,
  type EffectiveDeliveryOwnerResult,
  type OutboundProjectionDecision,
  type ProjectionConsumerSource,
  type Queryable,
} from './outbound-projection'
import {
  DISCORD_DELIVERY_CREDENTIAL_STATUSES,
  DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES,
  isDiscordDeliveryCredentialStatus,
} from './discord-token-resolution'

export type DiscordProjectionGoNoGo = 'GO' | 'NO_GO'
export type ProviderWriteCapability =
  | 'channel_binding_outbound'
  | 'provider_channel_access_write'
  | 'read_only'
  | 'missing'
  | 'unknown'

export interface DiscordProjectionDiagnosticInput {
  channelId: string
  threadId?: string | null
  senderAgentId: string
  recipientAgentIds: string[]
  fallbackAllowed?: boolean
  expectedDirectDelivery?: boolean
}

export interface DiscordProjectionDiagnosticFinding {
  code: string
  severity: 'blocker' | 'warning'
  message: string
  agent_id?: string | null
  consumer_agent_id?: string | null
  consumer_source?: ProjectionConsumerSource
  fallback_reason?: string | null
  evidence?: Record<string, unknown>
  repair_hint?: string
}

export interface DiscordProjectionEvidenceSummary {
  agent_id: string | null
  connector_instance_id: string | null
  credential_status: string | null
  channel_binding_id: string | null
  provider_channel_access_id: string | null
  provider_write_capability: ProviderWriteCapability
  diagnostics: DeliveryConsumerDiagnostic[]
}

export interface DiscordProjectionCredentialContract {
  runtime_login_credential_statuses: readonly string[]
  delivery_credential_statuses: readonly string[]
  runtime_login_delivery_status_policy: 'separate'
  runtime_delivery_status_contract: 'aligned' | 'drift'
  selected_delivery_credential_status: string | null
  selected_delivery_status_contract: 'satisfied' | 'violated' | 'unknown'
  selected_delivery_evidence_complete: boolean
  sender_direct_preferred_over_router: true
  fallback_requires_explicit_allowance: true
  selected_delivery_evidence_required: true
  no_live_discord_write: true
}

export interface DiscordProjectionDiagnosticReport {
  ok: boolean
  go_no_go: DiscordProjectionGoNoGo
  generated_at: string
  issue_ref: '#604'
  scope: {
    provider: 'discord'
    channel_id: string
    thread_id: string | null
    sender_agent_id: string
    recipient_agent_ids: string[]
  }
  expectation: {
    expected_direct_delivery: boolean
    expected_consumer_agent_id: string | null
    expected_consumer_source: ProjectionConsumerSource | null
    fallback_allowed: boolean
  }
  decision: {
    consumer_agent_id: string | null
    projection_identity_id: string | null
    delivery_connector_instance_id: string | null
    channel_binding_id: string | null
    credential_status: string | null
    provider_write_capability: ProviderWriteCapability
    fallback_allowed: boolean
    fallback_reason: string | null
    decision_source: ProjectionConsumerSource
    consumer_source: ProjectionConsumerSource
    projection_source: OutboundProjectionDecision['projectionSource']
    projection_fallback_reason: OutboundProjectionDecision['projectionFallbackReason']
    delivery_fallback_reason: OutboundProjectionDecision['deliveryFallbackReason']
    channel_external_id: string | null
    intended_projection_identity_id: string | null
    consumer_evidence: DeliveryConsumerEvidence | null
    delivery_diagnostics: DeliveryConsumerDiagnostic[]
  }
  effective_delivery_owner: EffectiveDeliveryOwnerResult
  evidence: {
    sender_direct: DiscordProjectionEvidenceSummary
    selected_consumer: DiscordProjectionEvidenceSummary
  }
  contract: DiscordProjectionCredentialContract
  primary_blocker: DiscordProjectionDiagnosticFinding | null
  blockers: DiscordProjectionDiagnosticFinding[]
  warnings: DiscordProjectionDiagnosticFinding[]
  policy: {
    read_only: true
    dry_run_default: true
    no_db_mutation: true
    no_discord_live_write: true
    no_state_daemon_restart: true
    no_next_inbox_fifo_drain: true
    no_prompt_driven_processing: true
  }
  recommended_next_commands: string[]
  mutation_performed: false
}

type ProjectionResolver = (
  db: Queryable,
  input: {
    channelId: string
    threadId?: string | null
    senderAgentId: string
    recipientAgentIds: string[]
    fallbackAllowed?: boolean
  },
) => Promise<OutboundProjectionDecision>

export interface DiscordProjectionDiagnosticOptions {
  now?: Date
  resolveDecision?: ProjectionResolver
}

function detailsString(diagnostic: DeliveryConsumerDiagnostic, key: string): string | null {
  const value = diagnostic.detail?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function credentialStatusFrom(
  evidence: DeliveryConsumerEvidence | null,
  diagnostics: DeliveryConsumerDiagnostic[],
): string | null {
  if (evidence?.credential_status) return evidence.credential_status
  for (const diagnostic of diagnostics) {
    const status = detailsString(diagnostic, 'credential_status')
    if (status) return status
  }
  return null
}

function firstDetailString(
  evidence: DeliveryConsumerEvidence | null,
  diagnostics: DeliveryConsumerDiagnostic[],
  evidenceKey: 'channel_binding_id' | 'provider_channel_access_id' | 'connector_instance_id',
): string | null {
  const evidenceValue = evidence?.[evidenceKey]
  if (typeof evidenceValue === 'string' && evidenceValue.trim().length > 0) return evidenceValue.trim()
  for (const diagnostic of diagnostics) {
    if (evidenceKey === 'connector_instance_id' && diagnostic.connector_instance_id) {
      return diagnostic.connector_instance_id
    }
    const value = detailsString(diagnostic, evidenceKey)
    if (value) return value
  }
  return null
}

function providerWriteCapabilityFrom(
  evidence: DeliveryConsumerEvidence | null,
  diagnostics: DeliveryConsumerDiagnostic[],
): ProviderWriteCapability {
  if (evidence?.channel_binding_id) return 'channel_binding_outbound'
  if (evidence?.provider_channel_access_id) return 'provider_channel_access_write'
  if (diagnostics.some((diagnostic) => diagnostic.code === 'provider_write_access_read_only')) return 'read_only'
  if (diagnostics.some((diagnostic) => diagnostic.code === 'write_binding_missing' || diagnostic.code === 'provider_write_access_missing')) return 'missing'
  return 'unknown'
}

function diagnosticsFor(
  decision: OutboundProjectionDecision,
  agentId: string | null,
  source?: ProjectionConsumerSource,
): DeliveryConsumerDiagnostic[] {
  return decision.deliveryDiagnostics.filter((diagnostic) => {
    if (agentId !== null && diagnostic.agent_id !== agentId) return false
    if (source && diagnostic.source !== source) return false
    return true
  })
}

function evidenceSummary(
  agentId: string | null,
  evidence: DeliveryConsumerEvidence | null,
  diagnostics: DeliveryConsumerDiagnostic[],
): DiscordProjectionEvidenceSummary {
  return {
    agent_id: agentId,
    connector_instance_id: firstDetailString(evidence, diagnostics, 'connector_instance_id'),
    credential_status: credentialStatusFrom(evidence, diagnostics),
    channel_binding_id: firstDetailString(evidence, diagnostics, 'channel_binding_id'),
    provider_channel_access_id: firstDetailString(evidence, diagnostics, 'provider_channel_access_id'),
    provider_write_capability: providerWriteCapabilityFrom(evidence, diagnostics),
    diagnostics,
  }
}

function fallbackReason(decision: OutboundProjectionDecision): string | null {
  const skip = outboundProjectionSkipReason(decision)
  if (skip) return outboundProjectionSkipCode(skip)
  return decision.deliveryFallbackReason ?? decision.projectionFallbackReason ?? (
    decision.consumerSource === 'channel_policy_adapter_owner' || decision.consumerSource === 'channel_policy_primary'
      ? decision.consumerSource
      : null
  )
}

function isFallbackConsumer(decision: OutboundProjectionDecision, senderAgentId: string): boolean {
  if (!decision.consumerAgentId) return false
  if (decision.consumerSource === 'channel_policy_adapter_owner' || decision.consumerSource === 'channel_policy_primary') return true
  return decision.consumerAgentId !== senderAgentId && decision.consumerSource !== 'sender_token_evidence'
}

function directSenderSelected(decision: OutboundProjectionDecision, senderAgentId: string): boolean {
  return decision.consumerAgentId === senderAgentId && decision.consumerSource === 'sender_token_evidence'
}

function selectedEvidenceComplete(summary: DiscordProjectionEvidenceSummary): boolean {
  if (!summary.agent_id) return false
  if (!summary.connector_instance_id) return false
  if (!summary.credential_status) return false
  return summary.provider_write_capability === 'channel_binding_outbound'
    || summary.provider_write_capability === 'provider_channel_access_write'
}

function finding(
  code: string,
  severity: 'blocker' | 'warning',
  message: string,
  extra: Omit<DiscordProjectionDiagnosticFinding, 'code' | 'severity' | 'message'> = {},
): DiscordProjectionDiagnosticFinding {
  const item: DiscordProjectionDiagnosticFinding = { code, severity, message, ...extra }
  if (!item.repair_hint) {
    const hint = repairHintFor(code)
    if (hint) item.repair_hint = hint
  }
  return item
}

function credentialContract(): DiscordProjectionCredentialContract {
  const runtimeStatuses = [...DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES]
  const deliveryStatuses = [...DISCORD_DELIVERY_CREDENTIAL_STATUSES]
  return {
    runtime_login_credential_statuses: runtimeStatuses,
    delivery_credential_statuses: deliveryStatuses,
    runtime_login_delivery_status_policy: 'separate',
    runtime_delivery_status_contract: 'drift',
    selected_delivery_credential_status: null,
    selected_delivery_status_contract: 'unknown',
    selected_delivery_evidence_complete: false,
    sender_direct_preferred_over_router: true,
    fallback_requires_explicit_allowance: true,
    selected_delivery_evidence_required: true,
    no_live_discord_write: true,
  }
}

function repairHintFor(code: string): string | null {
  switch (code) {
    case 'SENDER_CREDENTIAL_UNKNOWN':
      return 'Register and verify the sender Discord connector credential before expecting direct delivery.'
    case 'SENDER_CREDENTIAL_NOT_DELIVERY_ELIGIBLE':
      return 'Promote the sender Discord credential to active only after token identity and channel write permission are verified.'
    case 'SENDER_WRITE_EVIDENCE_MISSING':
      return 'Add or repair the sender outbound channel binding and provider write access evidence.'
    case 'SELECTED_DELIVERY_EVIDENCE_INCOMPLETE':
      return 'Repair the selected delivery consumer credential, connector, binding, and provider write evidence before enabling projection.'
    case 'FALLBACK_NOT_ALLOWED':
      return 'Either repair sender direct delivery evidence or explicitly permit fallback in channel policy for this channel.'
    case 'FALLBACK_POLICY_DENIED':
      return 'Fallback is denied by policy; repair direct delivery evidence or add an explicit governed fallback policy.'
    case 'DIRECT_DELIVERY_MISMATCH':
      return 'Inspect sender direct evidence first; fallback must not mask a missing or unusable sender delivery path.'
    case 'USABLE_SENDER_FELL_BACK_TO_ROUTER':
      return 'Keep sender direct delivery selected when sender credential, binding, and write evidence are usable.'
    case 'NO_ELIGIBLE_DELIVERY_CONSUMER':
      return 'Create one eligible Discord delivery connector with active credential, outbound binding, and write access.'
    case 'NO_DISCORD_ADAPTER_MAPPING':
      return 'Add the Discord channel adapter mapping before testing projection delivery.'
    default:
      return null
  }
}

function blockerPriority(code: string): number {
  switch (code) {
    case 'SENDER_CREDENTIAL_UNKNOWN':
    case 'SENDER_CREDENTIAL_NOT_DELIVERY_ELIGIBLE':
      return 10
    case 'SENDER_WRITE_EVIDENCE_MISSING':
      return 20
    case 'SELECTED_DELIVERY_EVIDENCE_INCOMPLETE':
      return 30
    case 'NO_DISCORD_ADAPTER_MAPPING':
    case 'NO_ELIGIBLE_DELIVERY_CONSUMER':
      return 40
    case 'USABLE_SENDER_FELL_BACK_TO_ROUTER':
      return 50
    case 'FALLBACK_NOT_ALLOWED':
    case 'FALLBACK_POLICY_DENIED':
      return 60
    case 'DIRECT_DELIVERY_MISMATCH':
      return 70
    default:
      return 100
  }
}

function primaryBlockerFor(blockers: DiscordProjectionDiagnosticFinding[]): DiscordProjectionDiagnosticFinding | null {
  if (blockers.length === 0) return null
  return [...blockers].sort((a, b) => blockerPriority(a.code) - blockerPriority(b.code))[0] ?? null
}

export async function buildDiscordProjectionDiagnosticReport(
  db: Queryable,
  input: DiscordProjectionDiagnosticInput,
  options: DiscordProjectionDiagnosticOptions = {},
): Promise<DiscordProjectionDiagnosticReport> {
  const channelId = input.channelId.trim()
  const senderAgentId = input.senderAgentId.trim()
  const recipientAgentIds = input.recipientAgentIds.map((id) => id.trim()).filter(Boolean)
  const threadId = input.threadId?.trim() || null
  const fallbackAllowed = input.fallbackAllowed === true
  const expectedDirectDelivery = input.expectedDirectDelivery !== false
  const resolveDecision = options.resolveDecision ?? resolveOutboundProjectionDecision
  const decision = await resolveDecision(db, {
    channelId,
    threadId,
    senderAgentId,
    recipientAgentIds,
    fallbackAllowed,
  })
  const selectedDiagnostics = diagnosticsFor(decision, decision.consumerAgentId)
  const senderDiagnostics = diagnosticsFor(decision, senderAgentId, 'sender_token_evidence')
  const selectedConsumer = evidenceSummary(decision.consumerAgentId, decision.consumerEvidence, selectedDiagnostics)
  const effectiveDeliveryOwner = toEffectiveDeliveryOwnerResult(decision, { fallbackAllowed })
  const senderDirect = evidenceSummary(
    senderAgentId,
    directSenderSelected(decision, senderAgentId) ? decision.consumerEvidence : null,
    senderDiagnostics,
  )
  const actualFallback = isFallbackConsumer(decision, senderAgentId)
  const senderUsable = senderDiagnostics.some((diagnostic) => diagnostic.code === 'eligible')
    || (directSenderSelected(decision, senderAgentId) && selectedEvidenceComplete(selectedConsumer))
  const reason = fallbackReason(decision)
  const blockers: DiscordProjectionDiagnosticFinding[] = []
  const warnings: DiscordProjectionDiagnosticFinding[] = []
  const skip = outboundProjectionSkipReason(decision)

  if (skip) {
    blockers.push(finding(outboundProjectionSkipCode(skip), 'blocker', skip, {
      fallback_reason: reason,
      evidence: { channel_external_id: decision.channelExternalId },
    }))
  }

  if (decision.consumerAgentId && !selectedEvidenceComplete(selectedConsumer)) {
    blockers.push(finding('SELECTED_DELIVERY_EVIDENCE_INCOMPLETE', 'blocker', 'selected delivery consumer does not have complete credential and write evidence', {
      agent_id: selectedConsumer.agent_id,
      consumer_agent_id: decision.consumerAgentId,
      consumer_source: decision.consumerSource,
      evidence: selectedConsumer,
    }))
  }

  if (expectedDirectDelivery && !directSenderSelected(decision, senderAgentId) && !(actualFallback && fallbackAllowed)) {
    blockers.push(finding('DIRECT_DELIVERY_MISMATCH', 'blocker', 'expected sender direct delivery, but resolver selected another consumer path', {
      agent_id: senderAgentId,
      consumer_agent_id: decision.consumerAgentId,
      consumer_source: decision.consumerSource,
      fallback_reason: reason,
      evidence: senderDirect,
    }))
  }

  if (expectedDirectDelivery && actualFallback && !fallbackAllowed) {
    blockers.push(finding('FALLBACK_NOT_ALLOWED', 'blocker', 'router/AUN fallback is not allowed for this diagnostic scope', {
      agent_id: senderAgentId,
      consumer_agent_id: decision.consumerAgentId,
      consumer_source: decision.consumerSource,
      fallback_reason: reason,
    }))
  }

  if (expectedDirectDelivery && actualFallback && senderUsable) {
    blockers.push(finding('USABLE_SENDER_FELL_BACK_TO_ROUTER', 'blocker', 'sender has usable direct delivery evidence, but resolver selected router/AUN fallback', {
      agent_id: senderAgentId,
      consumer_agent_id: decision.consumerAgentId,
      consumer_source: decision.consumerSource,
      fallback_reason: reason,
      evidence: senderDirect,
    }))
  }

  if (expectedDirectDelivery && !senderUsable) {
    const senderCodes = new Set(senderDiagnostics.map((diagnostic) => diagnostic.code))
    if (senderCodes.has('credential_missing')) {
      blockers.push(finding('SENDER_CREDENTIAL_UNKNOWN', 'blocker', 'sender credential is missing or unknown, so direct delivery cannot be marked successful', {
        agent_id: senderAgentId,
        evidence: senderDirect,
      }))
    } else if (senderCodes.has('credential_not_delivery_eligible')) {
      blockers.push(finding('SENDER_CREDENTIAL_NOT_DELIVERY_ELIGIBLE', 'blocker', 'sender credential is not in a delivery-eligible status', {
        agent_id: senderAgentId,
        evidence: senderDirect,
      }))
    } else if (
      senderCodes.has('write_binding_missing')
      || senderCodes.has('provider_write_access_missing')
      || senderCodes.has('provider_write_access_read_only')
    ) {
      if (!(actualFallback && fallbackAllowed)) {
        blockers.push(finding('SENDER_WRITE_EVIDENCE_MISSING', 'blocker', 'sender direct delivery lacks outbound binding or provider write capability', {
          agent_id: senderAgentId,
          evidence: senderDirect,
        }))
      }
    } else if (!directSenderSelected(decision, senderAgentId)) {
      blockers.push(finding('SENDER_DIRECT_EVIDENCE_UNKNOWN', 'blocker', 'sender direct delivery evidence is unknown', {
        agent_id: senderAgentId,
        evidence: senderDirect,
      }))
    }
  }

  if (actualFallback && fallbackAllowed && blockers.length === 0) {
    warnings.push(finding('FALLBACK_ALLOWED', 'warning', 'router/AUN fallback is explicitly allowed for this diagnostic scope', {
      agent_id: senderAgentId,
      consumer_agent_id: decision.consumerAgentId,
      consumer_source: decision.consumerSource,
      fallback_reason: reason,
    }))
  }

  const primaryBlocker = primaryBlockerFor(blockers)
  const ok = blockers.length === 0
  const contract = credentialContract()
  const hasSelectedDeliveryEvidence = selectedEvidenceComplete(selectedConsumer)
  const selectedStatus = selectedConsumer.credential_status
  const selectedDeliverySatisfied = hasSelectedDeliveryEvidence && isDiscordDeliveryCredentialStatus(selectedStatus)
  contract.runtime_delivery_status_contract = selectedDeliverySatisfied ? 'aligned' : 'drift'
  contract.selected_delivery_credential_status = selectedStatus
  contract.selected_delivery_status_contract = selectedStatus === null
    ? 'unknown'
    : selectedDeliverySatisfied
      ? 'satisfied'
      : 'violated'
  contract.selected_delivery_evidence_complete = hasSelectedDeliveryEvidence

  return {
    ok,
    go_no_go: ok ? 'GO' : 'NO_GO',
    generated_at: (options.now ?? new Date()).toISOString(),
    issue_ref: '#604',
    scope: {
      provider: 'discord',
      channel_id: channelId,
      thread_id: threadId,
      sender_agent_id: senderAgentId,
      recipient_agent_ids: recipientAgentIds,
    },
    expectation: {
      expected_direct_delivery: expectedDirectDelivery,
      expected_consumer_agent_id: expectedDirectDelivery ? senderAgentId : null,
      expected_consumer_source: expectedDirectDelivery ? 'sender_token_evidence' : null,
      fallback_allowed: fallbackAllowed,
    },
    decision: {
      consumer_agent_id: decision.consumerAgentId,
      projection_identity_id: decision.projectionIdentityId,
      delivery_connector_instance_id: selectedConsumer.connector_instance_id,
      channel_binding_id: selectedConsumer.channel_binding_id,
      credential_status: selectedConsumer.credential_status,
      provider_write_capability: selectedConsumer.provider_write_capability,
      fallback_allowed: fallbackAllowed,
      fallback_reason: reason,
      decision_source: decision.consumerSource,
      consumer_source: decision.consumerSource,
      projection_source: decision.projectionSource,
      projection_fallback_reason: decision.projectionFallbackReason,
      delivery_fallback_reason: decision.deliveryFallbackReason,
      channel_external_id: decision.channelExternalId,
      intended_projection_identity_id: decision.intendedProjectionIdentityId,
      consumer_evidence: decision.consumerEvidence,
      delivery_diagnostics: decision.deliveryDiagnostics,
    },
    effective_delivery_owner: effectiveDeliveryOwner,
    evidence: {
      sender_direct: senderDirect,
      selected_consumer: selectedConsumer,
    },
    contract,
    primary_blocker: primaryBlocker,
    blockers,
    warnings,
    policy: {
      read_only: true,
      dry_run_default: true,
      no_db_mutation: true,
      no_discord_live_write: true,
      no_state_daemon_restart: true,
      no_next_inbox_fifo_drain: true,
      no_prompt_driven_processing: true,
    },
    recommended_next_commands: ok
      ? []
      : ['Review blocker codes and repair connector credential/binding/write evidence before enabling Discord projection.'],
    mutation_performed: false,
  }
}

export function formatDiscordProjectionDiagnosticText(report: DiscordProjectionDiagnosticReport): string {
  const lines = [
    'Discord Projection Diagnostic',
    '',
    `Result: ${report.go_no_go}`,
    `Channel: ${report.scope.channel_id}${report.scope.thread_id ? ` thread=${report.scope.thread_id}` : ''}`,
    `From: ${report.scope.sender_agent_id}`,
    `To: ${report.scope.recipient_agent_ids.join(', ')}`,
    `Consumer: ${report.decision.consumer_agent_id ?? '(none)'}`,
    `Decision source: ${report.decision.decision_source}`,
    `Projection identity: ${report.decision.projection_identity_id ?? '(none)'}`,
    `Credential status: ${report.decision.credential_status ?? '(unknown)'}`,
    `Provider write: ${report.decision.provider_write_capability}`,
    `Binding: ${report.decision.channel_binding_id ?? '(none)'}`,
    `Connector: ${report.decision.delivery_connector_instance_id ?? '(none)'}`,
    `Sender credential status: ${report.evidence.sender_direct.credential_status ?? '(unknown)'}`,
    `Sender provider write: ${report.evidence.sender_direct.provider_write_capability}`,
    `Sender binding: ${report.evidence.sender_direct.channel_binding_id ?? '(none)'}`,
    `Sender connector: ${report.evidence.sender_direct.connector_instance_id ?? '(none)'}`,
    `Credential contract: ${report.contract.runtime_delivery_status_contract}`,
    `Credential policy: ${report.contract.runtime_login_delivery_status_policy}`,
    `Runtime login statuses: ${report.contract.runtime_login_credential_statuses.join(', ')}`,
    `Delivery statuses: ${report.contract.delivery_credential_statuses.join(', ')}`,
    `Selected delivery status contract: ${report.contract.selected_delivery_status_contract}`,
    `Sender direct priority: ${report.contract.sender_direct_preferred_over_router ? 'true' : 'false'}`,
    `Fallback allowed: ${report.decision.fallback_allowed ? 'true' : 'false'}`,
    `Fallback reason: ${report.decision.fallback_reason ?? '(none)'}`,
    `Effective delivery owner: ${report.effective_delivery_owner.ok ? `ok:${report.effective_delivery_owner.source}` : `blocked:${report.effective_delivery_owner.code}`}`,
    `Primary blocker: ${report.primary_blocker ? `${report.primary_blocker.code}: ${report.primary_blocker.message}` : '(none)'}`,
    `Primary repair: ${report.primary_blocker?.repair_hint ?? '(none)'}`,
    `Mutation performed: ${report.mutation_performed ? 'true' : 'false'}`,
  ]

  if (report.blockers.length > 0) {
    lines.push('', 'Blockers:')
    for (const blocker of report.blockers) {
      const repair = blocker.repair_hint ? ` Repair: ${blocker.repair_hint}` : ''
      lines.push(`- ${blocker.code}: ${blocker.message}${repair}`)
    }
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of report.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`)
    }
  }
  return `${lines.join('\n')}\n`
}
