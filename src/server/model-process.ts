import { spawn, type ChildProcess } from 'node:child_process'
import { AiError, stderrTail } from './ai-errors.js'

export function killModel(child: ChildProcess) {
  if (!child.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
}

export function modelEnvironment() {
  return { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1', CI: '1' }
}

export async function runModelProcess(bin: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal, input?: string) {
  if (signal?.aborted) throw new AiError('cancelled')
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { cwd, detached: true, env: modelEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })
    const diagnostics = stderrTail()
    let output = '', failure: AiError | undefined
    const stop = (error: AiError) => { failure ??= error; killModel(child) }
    const cancel = () => stop(new AiError('cancelled'))
    const timer = setTimeout(() => stop(new AiError('timeout')), timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', chunk => {
      if (failure) return
      output += String(chunk)
      if (output.length > 4 * 1024 * 1024) stop(new AiError('output_limit'))
    })
    child.stderr.on('data', chunk => diagnostics.append(chunk))
    child.stdin.on('error', () => { /* Exit status and stderr classify a closed input pipe. */ })
    child.on('error', () => stop(new AiError('spawn')))
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer)
      killModel(child)
      signal?.removeEventListener('abort', cancel)
      if (!failure && code !== 0) failure = diagnostics.failure(code, exitSignal)
      diagnostics.clear()
      if (failure) { failure.exitCode = code; failure.signal = exitSignal; reject(failure) }
      else resolve(output)
    })
    child.stdin.end(input)
    if (signal?.aborted) cancel()
  })
}
