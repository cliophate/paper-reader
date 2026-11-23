import type { AiActivityStore } from './ai-activity.js'
import { untracked, type AiAttempt } from './ai-usage.js'
import type { ActivityFeature } from '../shared/ai-activity.js'
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

export function runAiBatch(config: Config, feature: AiFeature, codexModel: string, instruction: string, input: unknown, schema: Record<string, unknown>, reasoningEffort?: 'low' | 'medium', signal?: AbortSignal, activity?: AiActivityStore, activityFeature: ActivityFeature = feature === 'shortlist' || feature === 'editor' ? 'briefing' : feature) {
  if (!aiEnabled(config)) throw new Error(AI_UNAVAILABLE)
  const provider = config.ai.provider === 'openai' ? 'openai' : 'codex'
  const model = provider === 'openai' ? config.openai[`${feature}Model`] : codexModel
  const track = activity?.attempt(activityFeature, provider, model, signal) ?? untracked
  const attempt: AiAttempt = (action, deferAdmission) => {
    const check = () => {
      const enabled = feature === 'discussion' ? config.ai.discussionEnabled : feature === 'headlines' ? config.headlines.enabled
        : feature === 'grouping' ? config.collections.enabled : config.ai.briefingsEnabled
      if (!enabled || !aiEnabled(config) || config.ai.provider !== provider) throw new Error(AI_UNAVAILABLE)
    }
    check()
    return track((report, admit) => action(report, (signal, confirmSlot) => { check(); return admit(signal, confirmSlot) }), deferAdmission)
  }
  if (provider === 'openai') return openaiBatch({ ...config.openai }, model, instruction, input, schema, signal, attempt)
  const background = Boolean(activity && activity.trigger !== 'manual')
  return attempt((report, admit) => runCodex(config.codex, model, instruction, input, schema, reasoningEffort, signal, report, background ? admit : undefined), background)
}

export function createAiChatModel(config: Config, activity?: AiActivityStore): ChatModel {
  return (input, signal, onText) => {
    if (!aiEnabled(config) || !config.ai.discussionEnabled) throw new Error(AI_UNAVAILABLE)
    const provider = config.ai.provider === 'openai' ? 'openai' : 'codex'
    const model = provider === 'openai' ? config.openai.discussionModel : config.codex.discussionModel
    const attempt = activity?.attempt('discussion', provider, model, signal) ?? untracked
    if (provider === 'openai') return openaiChat({ ...config.openai }, model, CHAT_INSTRUCTIONS, input, signal, onText, attempt)
    return attempt(report => createChatModel(config.codex.bin, model)(input, signal, onText, report))
  }
}
