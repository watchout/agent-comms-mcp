// CELL-4MCP-AUN-001 — aun_agent_routing_profiles + SuiteEvent/v1 producer.
// Dispatch anchor: agent-comms-mcp#853. Contract: SPEC-4MCP-002 v0.2.

export { ensureRoutingProfilesSchema, ROUTING_PROFILE_COLUMNS } from './schema'
export {
  ensureSchema,
  getRoutingProfile,
  listRoutingProfiles,
  registerAgentRoutingProfile,
  updateAgentRoutingProfile,
  deactivateAgentRoutingProfile,
  retireAgentRoutingProfile,
  suiteEventsFor,
  rebuildRoutingProfilesFromLog,
  subjectStream,
  suiteEventId,
  NotMintedError,
  RegisterConflictError,
  RetiredAgentError,
  SUITE_CONTRACT_VERSION,
  SUITE_EVENT_TYPES,
  PRODUCER_MCP,
  ROUTING_PROFILE_PAYLOAD_SCHEMA,
  type RoutingProfileRow,
  type RoutingProfileInput,
} from './store'
