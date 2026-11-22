import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { ExtractionRules } from '../shared/feed-overrides.js'
import type { extractReadableArticle } from './article-extraction.js'
import type { ParsedFeed } from './feed-parser.js'
import { BackendValidationError } from './backend.js'

interface ExtractionResult {
  article: ReturnType<typeof extractReadableArticle>
  feed: ParsedFeed
}
export interface ExtractionTask<K extends keyof ExtractionResult = keyof ExtractionResult> {
  kind: K
  body: string
  url: string
}

export class ExtractionLimit extends Error {}
const EXTRACTION_TIMEOUT_MS = 3000

// Only send rewrite settings to the worker. Saved overrides can also contain a cookie.
export function extractionRules({ contentSelector, removeSelectors, lazyImages, stripTracking, trackingExcludedHosts }: ExtractionRules, kind: ExtractionTask['kind']) {
  if ((kind === 'article' && contentSelector) || removeSelectors.length || lazyImages || stripTracking) {
    return { contentSelector, removeSelectors, lazyImages, stripTracking, trackingExcludedHosts }
  }
}

// A feed preview often runs again after a small edit. Keep one idle DOM worker briefly.
let idle: Worker | undefined
let expiry: NodeJS.Timeout | undefined

function takeWorker() {
  if (idle) {
    const worker = idle
    idle = undefined
    clearTimeout(expiry)
    worker.ref()
    return worker
  }
  const source = import.meta.url.endsWith('.ts')
  const url = new URL(source ? './feed-extraction-worker.ts' : './feed-extraction-worker.js', import.meta.url)
  const options = { execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 192 } }
  const worker = source
    ? new Worker(`import { tsImport } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)}; await tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)});`, { ...options, eval: true })
    : new Worker(url, options)
  const discardIdle = () => {
    if (idle === worker) {
      idle = undefined
      clearTimeout(expiry)
    }
  }
  worker.on('error', discardIdle).once('exit', discardIdle)
  return worker
}

async function runWorker<K extends keyof ExtractionResult>(task: ExtractionTask<K>, rules: ExtractionRules | undefined,
  timeoutMs: number, signal?: AbortSignal): Promise<ExtractionResult[K]> {
  signal?.throwIfAborted()
  const worker = takeWorker()
  const deadline = AbortSignal.timeout(timeoutMs)
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline
  let reusable = false
  let cleanup = () => {}
  try {
    return await new Promise<ExtractionResult[K]>((resolve, reject) => {
      const abort = () => reject(signal?.aborted ? signal.reason : new ExtractionLimit('Extraction timed out.'))
      const failed = () => reject(new ExtractionLimit('The extraction worker stopped.'))
      const receive = (message: { value: ExtractionResult[K]; error?: string; limit?: string }) => {
        reusable = true
        if (message.limit) reject(new ExtractionLimit(message.limit))
        else if (message.error) reject(new BackendValidationError(message.error))
        else resolve(message.value)
      }
      stop.addEventListener('abort', abort, { once: true })
      worker.once('message', receive).once('error', failed).once('exit', failed)
      cleanup = () => {
        stop.removeEventListener('abort', abort)
        worker.off('message', receive).off('error', failed).off('exit', failed)
      }
      worker.postMessage({ ...task, rules })
    })
  } finally {
    cleanup()
    if (reusable && !idle) {
      idle = worker
      worker.unref()
      expiry = setTimeout(() => {
        idle = undefined
        void worker.terminate()
      }, 5000).unref()
    } else await worker.terminate()
  }
}

export async function extractWithOverrides<K extends keyof ExtractionResult>(task: ExtractionTask<K>, rules: ExtractionRules,
  warn: (reason: string) => void, signal?: AbortSignal, timeoutMs = EXTRACTION_TIMEOUT_MS): Promise<ExtractionResult[K]> {
  try { return await runWorker(task, rules, timeoutMs, signal) }
  catch (error) {
    if (!(error instanceof ExtractionLimit)) throw error
    const reason = error.message + ' Paper tried default extraction.'
    warn(reason)
    try { return await runWorker(task, undefined, EXTRACTION_TIMEOUT_MS, signal) }
    catch (fallbackError) {
      signal?.throwIfAborted()
      throw new BackendValidationError(reason + ' ' + (fallbackError instanceof Error ? fallbackError.message : 'Default extraction failed.'))
    }
  }
}
