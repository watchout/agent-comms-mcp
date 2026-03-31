/**
 * LLM Adapter interface definitions.
 * Provides a unified interface for multiple LLM providers.
 */

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LLMAdapterConfig {
  provider: 'anthropic' | 'openai' | 'google'
  apiKey: string
  model?: string
}

export interface LLMAdapter {
  /** Provider identifier */
  provider: string

  /** Send a chat completion request */
  chat(systemPrompt: string, messages: LLMMessage[]): Promise<string>
}
