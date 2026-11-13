export const AI_QUEUE_WAIT_MS = 300_000
export const AI_FAILURES = ['auth', 'model_access', 'schema', 'timeout', 'spawn', 'output_limit', 'cancelled', 'busy', 'unknown'] as const
export type AiFailure = typeof AI_FAILURES[number]

const messages: Record<AiFailure, string> = {
  auth: 'AI login expired or was rejected. Log in to Codex in the worker again.',
  model_access: 'AI model access was rejected. Choose a model your account can use in Settings.',
  schema: 'AI returned an invalid response. Please try again.',
  timeout: 'AI took too long. Please try again.',
  spawn: 'The AI worker could not start Codex. Check its CLI installation.',
  output_limit: 'AI exceeded the response size limit. Please try again.',
  cancelled: 'Response stopped',
  busy: 'AI is busy, try again shortly.',
  unknown: 'AI request failed. Check the worker logs for the request ID, then try again.',
}

export class AiError extends Error {
  constructor(public category: AiFailure, public exitCode: number | null = null, public signal: NodeJS.Signals | null = null) {
    super(messages[category])
  }
}

// Inspect only a bounded diagnostic tail. Never retain it on an Error or log it.
export function classifyModelFailure(stderr: string): AiFailure {
  const tail = stderr.slice(-8192)
  if (/unauthorized|unauthenticated|authentication|invalid[_ -]?(?:api[_ -]?)?key|token.{0,30}(?:expired|invalid)|(?:login|log in|sign in).{0,30}(?:required|again)|\b401\b/i.test(tail)) return 'auth'
  if (/model.{0,80}(?:not found|does not exist|not supported|unsupported|access|permission)|(?:access|permission).{0,80}model|\bmodel_not_found\b|\b403\b/i.test(tail)) return 'model_access'
  if (/invalid.{0,30}schema|schema.{0,30}(?:invalid|validation|error)|invalid json/i.test(tail)) return 'schema'
  if (/timed? out|timeout|deadline exceeded/i.test(tail)) return 'timeout'
  return 'unknown'
}

export function stderrTail() {
  let tail = Buffer.alloc(0)
  return {
    append(chunk: Buffer) { tail = Buffer.concat([tail, chunk.subarray(-8192)]).subarray(-8192) },
    failure(code: number | null = null, signal: NodeJS.Signals | null = null) {
      const category = classifyModelFailure(tail.toString('utf8'))
      tail = Buffer.alloc(0)
      return new AiError(category, code, signal)
    },
    clear() { tail = Buffer.alloc(0) },
  }
}
