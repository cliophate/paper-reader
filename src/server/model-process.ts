import { spawn, type ChildProcess } from 'node:child_process'

export function killModel(child: ChildProcess) {
  if (!child.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
}

export function modelEnvironment() {
  return { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1', CI: '1' }
}

export async function runModelProcess(bin: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal, input?: string) {
  signal?.throwIfAborted()
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { cwd, detached: true, env: modelEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      killModel(child)
      error ? reject(error) : resolve(output)
    }
    const cancel = () => finish(new Error('Model request stopped'))
    const timer = setTimeout(() => finish(new Error('Model request timed out')), timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', chunk => {
      output += String(chunk)
      if (output.length > 4 * 1024 * 1024) finish(new Error('Model output exceeded the size limit'))
    })
    child.stderr.resume()
    child.stdin.on('error', () => finish(new Error('Model input connection closed')))
    child.on('error', () => finish(new Error('Could not start model process')))
    child.on('close', code => finish(code === 0 ? undefined : new Error('Model process failed. Check its login and model access.')))
    child.stdin.end(input)
    if (signal?.aborted) cancel()
  })
}
