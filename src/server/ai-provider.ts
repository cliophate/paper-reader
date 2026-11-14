import type { Config } from './config.js'
import { AI_UNAVAILABLE, aiAvailability, aiExecutionConfigured } from './ai-client.js'
import { CHAT_INSTRUCTIONS, createChatModel, type ChatModel } from './chat-model.js'
import { runCodex } from './codex.js'
import { openaiBatch, openaiChat } from './openai.js'

export type AiFeature = 'discussion' | 'headlines' | 'grouping' | 'shortlist' | 'editor'

export function aiEnabled(config: Config) {
  return config.ai.enabled && config.ai.provider !== 'none'
}

export function providerConfigured(config: Config) {
  return aiEnabled(config) && (config.ai.provider === 'openai' ? Boolean(config.openai.baseUrl) : aiExecutionConfigured())
}

export async function providerAvailability(config: Config) {
  if (!aiEnabled(config)) return { available: false, message: 'AI is off. Select a provider and enable AI features in Settings.' }
  if (config.ai.provider === 'openai') return { available: true, message: 'OpenAI-compatible API selected. Use Test connection to verify the saved settings.' }
  return aiAvailability(config.codex.enabled)
}

export function runAiBatch(config: Config, feature: Exclude<AiFeature, 'discussion'>, codexModel: string, instruction: string, input: unknown, schema: Record<string, unknown>, reasoningEffort?: 'low' | 'medium', signal?: AbortSignal) {
  if (!aiEnabled(config)) throw new Error(AI_UNAVAILABLE)
  if (config.ai.provider === 'openai') return openaiBatch({ ...config.openai }, config.openai[`${feature}Model`], instruction, input, schema, signal)
  return runCodex(config.codex, codexModel, instruction, input, schema, reasoningEffort, signal)
}

export function createAiChatModel(config: Config): ChatModel {
  return (input, signal, onText) => {
    if (!aiEnabled(config)) throw new Error(AI_UNAVAILABLE)
    if (config.ai.provider === 'openai') return openaiChat({ ...config.openai }, config.openai.discussionModel, CHAT_INSTRUCTIONS, input, signal, onText)
    return createChatModel(config.codex.bin, config.codex.discussionModel)(input, signal, onText)
  }
}
