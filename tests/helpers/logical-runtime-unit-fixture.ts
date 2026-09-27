import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import type { HostRuntimeInspector, HostRuntimeObservation } from '../../core/host-runtime-observer'
import type { SeatContextReceipt } from '../../core/seat-context-recovery'

// Unit-only seams. These are not OS/native provenance evidence; the separate
// nonpersist integration suites exercise actual processes and native originals.
export function unitRuntimeId(agentId: string): string {
  const hex = createHash('sha256').update(agentId).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function unitRuntimeAuthority(agentId: string) {
  const runtimeId = unitRuntimeId(agentId)
  return { runtime_instance_id: runtimeId, agent_id: agentId, runtime_kind: 'local_process', metadata: {},
    holder_agent_id: agentId, holder_runtime_instance_id: runtimeId, lease_id: `lease-${agentId}`,
    fencing_token: 1, acquired_at: '2026-05-07T23:51:00.000Z', authority_live: 1 }
}

export function unitRuntimeObservation(agentId: string, overrides: Partial<HostRuntimeObservation> = {}): HostRuntimeObservation {
  return { schema_version: 'seat-provider-observation/v1', agent_id: agentId, runtime_instance_id: unitRuntimeId(agentId),
    host_id: hostname(), process_id: 1234, process_started_at: '2026-05-07T23:50:00.000Z',
    provider_pid: 5678, provider_started_at: '2026-05-07T23:49:00.000Z', provider: 'codex',
    session_name: `${agentId}-session`, workspace: '/repo', observed_at: new Date().toISOString(),
    source: 'process_ancestry', verified: true, port: 19123, endpoint_uri: 'http://127.0.0.1:19123', ...overrides }
}

export const unitRuntimeInspector: HostRuntimeInspector = input => ({
  reasonCode: 'OBSERVED', observations: [unitRuntimeObservation(input.agentId)],
})

export async function unitNativeProof(input: {agentId: string; project: string; runtimeInstanceId: string}): Promise<SeatContextReceipt> {
  return { schema_version: 'seat-context-consumption/v1', agent_id: input.agentId, project: input.project,
    runtime_instance_id: input.runtimeInstanceId, target_runtime: 'codex',
    pack_id: `restart_pack:${input.agentId}:${input.project}:1789280000000`, response_digest: 'a'.repeat(64),
    work_digest: 'b'.repeat(64), invocation_digest: 'c'.repeat(64), transport_binding_digest: 'd'.repeat(64),
    completed_at: '2026-05-07T23:55:00.000Z', consumption: {runtime_instance_id: input.runtimeInstanceId,
      invocation_digest: 'c'.repeat(64), consumer: 'unit-fixture'} }
}

export function unitLogicalProof(agentId: string, project: string) {
  return { agent_id: agentId, project, runtime_instance_id: unitRuntimeId(agentId),
    pack_id: `restart_pack:${agentId}:${project}:1789280000000`, work_digest: 'b'.repeat(64), invocation_digest: 'c'.repeat(64) }
}
