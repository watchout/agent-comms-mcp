import type { LLMAdapter, LLMAdapterConfig } from './types.js'
import { AnthropicAdapter } from './anthropic.js'
import { OpenAIAdapter } from './openai.js'

export type { LLMAdapter, LLMAdapterConfig, LLMMessage } from './types.js'

export function createLLMAdapter(config: LLMAdapterConfig): LLMAdapter {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicAdapter(config.apiKey, config.model)
    case 'openai':
      return new OpenAIAdapter(config.apiKey, config.model)
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`)
  }
}

/**
 * Create an LLM adapter from environment variables.
 * - LLM_PROVIDER: 'anthropic' | 'openai' (default: 'anthropic')
 * - ANTHROPIC_API_KEY / OPENAI_API_KEY
 * - LLM_MODEL: optional model override
 */
export function createLLMAdapterFromEnv(): LLMAdapter {
  const provider = (process.env.LLM_PROVIDER || 'anthropic') as 'anthropic' | 'openai'

  let apiKey: string
  if (provider === 'anthropic') {
    apiKey = process.env.ANTHROPIC_API_KEY || ''
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic')
  } else {
    apiKey = process.env.OPENAI_API_KEY || ''
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai')
  }

  return createLLMAdapter({
    provider,
    apiKey,
    model: process.env.LLM_MODEL || undefined,
  })
}
