/**
 * Phase 5 §1.7 Port D — MessageBodyDecorator.
 *
 * Responsibility: append literal observer suffixes to the message body when
 * `cc[]` or `fyi[]` are non-empty.
 *
 * §1.5: cc[] are NOT enqueued. They are surfaced to readers via a literal
 * body suffixes (transparency over hidden metadata fields):
 *
 *     ${content}\n\n[CC: <@id1>, <@id2>]\n[FYI: <@id3>]
 *
 * §5.2 (Open): exact format is dev-decided. We pick: blank-line separator
 * + `<@id>` Discord-mention syntax so the suffix is both human-readable
 * and renders as a mention chip on Discord.
 */
import type { AgentId } from '../../channel-policy'

export interface MessageBodyDecorator {
  decorate(content: string, cc: AgentId[], fyi?: AgentId[]): string
}

export function createMessageBodyDecorator(): MessageBodyDecorator {
  return {
    decorate(content: string, cc: AgentId[], fyi: AgentId[] = []): string {
      const suffixes: string[] = []
      if (cc && cc.length > 0) {
        suffixes.push(`[CC: ${cc.map((id) => `<@${id}>`).join(', ')}]`)
      }
      if (fyi && fyi.length > 0) {
        suffixes.push(`[FYI: ${fyi.map((id) => `<@${id}>`).join(', ')}]`)
      }
      if (suffixes.length === 0) return content
      return `${content}\n\n${suffixes.join('\n')}`
    },
  }
}
