import OpenAI from 'openai'
import type { LLMAdapter, LLMMessage } from './types.js'

export class OpenAIAdapter implements LLMAdapter {
  provider = 'openai'
  private client: OpenAI
  private model: string

  constructor(apiKey: string, model = 'gpt-4o') {
    this.client = new OpenAI({ apiKey })
    this.model = model
  }

  async chat(systemPrompt: string, messages: LLMMessage[]): Promise<string> {
    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ],
    })
    return resp.choices[0]?.message?.content ?? ''
  }
}
