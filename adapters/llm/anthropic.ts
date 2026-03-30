import Anthropic from '@anthropic-ai/sdk'
import type { LLMAdapter, LLMMessage } from './types.js'

export class AnthropicAdapter implements LLMAdapter {
  provider = 'anthropic'
  private client: Anthropic
  private model: string

  constructor(apiKey: string, model = 'claude-sonnet-4-20250514') {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  async chat(systemPrompt: string, messages: LLMMessage[]): Promise<string> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    })
    const block = resp.content[0]
    return block.type === 'text' ? block.text : ''
  }
}
