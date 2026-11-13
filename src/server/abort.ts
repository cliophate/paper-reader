export async function abortable<T>(task: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return task()
  let cancel: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try {
    const result = await Promise.race([task(), aborted])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
