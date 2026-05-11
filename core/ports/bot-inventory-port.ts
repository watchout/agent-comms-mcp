/**
 * BotInventoryPort (X1, incident #339 series cleanup).
 *
 * Canonical list of "production" bots (cto / arc / auditor / vice /
 * secretary / lead-ama). Spec §1.2 freezes the symmetry invariant:
 *
 *   isProductionBot(id) === true  ⇔  id ∈ listProductionBots()
 *
 * Both methods are derived from the same internal constant; per spec §3.3
 * production code is forbidden from inlining the bot-id set elsewhere.
 *
 * Spec: iyasaka-arc/agent-comms-mcp/specs/draft/2026-05-12-X1-config-port-bot-inventory-abstraction-instruction.md
 */

const PRODUCTION_BOT_IDS = Object.freeze([
  'cto',
  'arc',
  'auditor',
  'vice',
  'secretary',
  'lead-ama',
] as const)

const PRODUCTION_BOT_SET: ReadonlySet<string> = new Set<string>(PRODUCTION_BOT_IDS)

export interface BotInventoryPort {
  /** Whether the given agent id is in the production-bot list (unknown ids → false). */
  isProductionBot(agentId: string): boolean

  /** Frozen production-bot id list. Order is not part of the contract. */
  listProductionBots(): readonly string[]
}

export function createDefaultBotInventoryPort(): BotInventoryPort {
  return {
    isProductionBot(agentId: string): boolean {
      // The symmetry invariant is enforced by deriving both methods from the
      // same canonical set; the membership check goes through it, never an
      // independent literal.
      return PRODUCTION_BOT_SET.has(agentId)
    },
    listProductionBots(): readonly string[] {
      return PRODUCTION_BOT_IDS
    },
  }
}

/** Production singleton. */
export const defaultBotInventoryPort: BotInventoryPort = createDefaultBotInventoryPort()
