export interface TokenUsage { input?: number; output?: number; total?: number }
export type ReportUsage = (usage: TokenUsage) => void
export type Admit = (signal?: AbortSignal, confirmSlot?: () => Promise<void>) => Promise<void>
export type AiAttempt = <T>(action: (report: ReportUsage, admit: Admit) => Promise<T>, deferAdmission?: boolean) => Promise<T>
export const untracked: AiAttempt = action => action(() => {}, async (_signal, confirmSlot) => { await confirmSlot?.() })

export function tokenUsage(input: unknown, output: unknown, total?: unknown): TokenUsage | undefined {
  const usage: TokenUsage = {}
  for (const [key, value] of [['input', input], ['output', output], ['total', total]] as const) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[key] = value
  }
  if (Object.keys(usage).length) return usage
}
