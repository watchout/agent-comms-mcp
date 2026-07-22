export type ShirubeD1ActivationMode = 'canary' | 'fleet'

export interface ShirubeD1RuntimeTarget {
  repository: string
  agent_id: string
  control_source: string
}

export const SHIRUBE_D1_FLEET_CONTROL_SOURCE = 'https://github.com/watchout/ai-dev-framework/issues/556' as const

export const SHIRUBE_D1_FLEET_TARGETS: readonly ShirubeD1RuntimeTarget[] = Object.freeze([
  Object.freeze({ repository: 'watchout/agent-comms-mcp', agent_id: 'dev-001', control_source: SHIRUBE_D1_FLEET_CONTROL_SOURCE }),
  Object.freeze({ repository: 'watchout/agent-memory', agent_id: 'kusabi', control_source: SHIRUBE_D1_FLEET_CONTROL_SOURCE }),
  Object.freeze({ repository: 'watchout/aun-platform', agent_id: 'aun', control_source: SHIRUBE_D1_FLEET_CONTROL_SOURCE }),
  Object.freeze({ repository: 'watchout/kodama', agent_id: 'kodama', control_source: SHIRUBE_D1_FLEET_CONTROL_SOURCE }),
  Object.freeze({ repository: 'watchout/misell', agent_id: 'misell', control_source: SHIRUBE_D1_FLEET_CONTROL_SOURCE }),
])

function targetKey(target: ShirubeD1RuntimeTarget): string | null {
  if (
    !target
    || typeof target !== 'object'
    || typeof target.repository !== 'string'
    || typeof target.agent_id !== 'string'
    || typeof target.control_source !== 'string'
  ) return null
  return `${target.repository}\n${target.agent_id}\n${target.control_source}`
}

export function isExactShirubeD1Fleet(targets: readonly ShirubeD1RuntimeTarget[]): boolean {
  if (targets.length !== SHIRUBE_D1_FLEET_TARGETS.length) return false
  const expected = new Set(SHIRUBE_D1_FLEET_TARGETS.map(targetKey))
  const actual = new Set(targets.map(targetKey))
  return !actual.has(null) && actual.size === expected.size && [...actual].every((key) => expected.has(key))
}
