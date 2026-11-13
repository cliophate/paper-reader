import { spawn, type ChildProcess } from 'node:child_process'
import { AiError, codexEventFailure } from './ai-errors.js'

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_EVENT_LINE = 64 * 1024
const MAX_ERROR_EVENTS = 20

export function killModel(child: ChildProcess) {
  if (!child.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
}

export function modelEnvironment() {
  return { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1', CI: '1' }
}

export async function runModelProcess(bin: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal, input?: string, jsonEvents = false) {
  if (signal?.aborted) throw new AiError('cancelled')
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { cwd, detached: true, env: modelEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', line = '', skipping = false, failure: AiError | undefined
    const events: string[] = []
    const stop = (error: AiError) => { failure ??= error; killModel(child) }
    const cancel = () => stop(new AiError('cancelled'))
    const timer = setTimeout(() => stop(new AiError('timeout')), timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    // JSONL repeats the final message with escaping, so event mode keeps only small error events.
    // The result itself is read from --output-last-message, which has its own size limit.
    const keepEvent = (text: string) => {
      if (events.length < MAX_ERROR_EVENTS && /"type":"(?:error|turn\.failed)"/.test(text)) events.push(text)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (failure) return
      if (!jsonEvents) {
        output += chunk
        if (output.length > MAX_OUTPUT_BYTES) stop(new AiError('output_limit'))
        return
      }
      let newline: number
      while ((newline = chunk.indexOf('\n')) >= 0) {
        if (!skipping) keepEvent(line + chunk.slice(0, newline))
        line = ''; skipping = false
        chunk = chunk.slice(newline + 1)
      }
      if (skipping) return
      line += chunk
      if (line.length > MAX_EVENT_LINE) { line = ''; skipping = true }
    })
    child.stderr.resume()
    child.stdin.on('error', () => { /* Exit status and structured events classify a closed input pipe. */ })
    child.on('error', () => stop(new AiError('spawn')))
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer)
      killModel(child)
      signal?.removeEventListener('abort', cancel)
      if (jsonEvents && !skipping && line) keepEvent(line)
      if (!failure && code !== 0) failure = new AiError(jsonEvents ? codexEventFailure(events.join('\n')) : 'unknown', code, exitSignal)
      if (failure) { failure.exitCode = code; failure.signal = exitSignal; reject(failure) }
      else resolve(output)
    })
    child.stdin.end(input)
    if (signal?.aborted) cancel()
  })
}
