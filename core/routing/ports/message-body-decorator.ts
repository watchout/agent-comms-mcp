/**
 * Phase 5 §1.7 Port D — MessageBodyDecorator.
 *
 * Responsibility: append a literal `[CC: ...]` suffix to the message body
 * when `cc[]` is non-empty.
 *
 * §1.5: cc[] are NOT enqueued. They are surfaced to readers via a literal
 * body suffix (transparency over hidden metadata fields):
 *
 *     ${content}\n\n[CC: <@id1>, <@id2>]
 *
 * §5.2 (Open): exact format is dev-decided. We pick: blank-line separator
 * + `<@id>` Discord-mention syntax so the suffix is both human-readable
 * and renders as a mention chip on Discord.
 */
import type { AgentId } from '../../channel-policy'

export interface MessageBodyDecorator {
  decorate(content: string, cc: AgentId[]): string
}

export function createMessageBodyDecorator(): MessageBodyDecorator {
  return {
    decorate(content: string, cc: AgentId[]): string {
      if (!cc || cc.length === 0) return content
      const ccSuffix = `[CC: ${cc.map((id) => `<@${id}>`).join(', ')}]`
      return `${content}\n\n${ccSuffix}`
    },
  }
}
