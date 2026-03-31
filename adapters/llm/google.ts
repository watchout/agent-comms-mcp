import { GoogleGenerativeAI } from '@google/generative-ai'
import type { LLMAdapter, LLMMessage } from './types.js'

export class GoogleAdapter implements LLMAdapter {
  provider = 'google'
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>

  constructor(apiKey: string, model = 'gemini-2.5-pro') {
    const genAI = new GoogleGenerativeAI(apiKey)
    this.model = genAI.getGenerativeModel({ model })
  }

  async chat(systemPrompt: string, messages: LLMMessage[]): Promise<string> {
    const chat = this.model.startChat({
      systemInstruction: systemPrompt,
      history: messages.slice(0, -1).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    })

    const lastMessage = messages[messages.length - 1]
    const result = await chat.sendMessage(lastMessage.content)
    return result.response.text()
  }
}
