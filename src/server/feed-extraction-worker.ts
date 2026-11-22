import { parentPort } from 'node:worker_threads'
import type { ExtractionRules } from '../shared/feed-overrides.js'
import { extractReadableArticle } from './article-extraction.js'
import { ExtractionLimit, type ExtractionTask } from './feed-extraction.js'
import { parseFeed } from './feed-parser.js'

parentPort!.on('message', ({ kind, body, url, rules }: ExtractionTask & { rules?: ExtractionRules }) => {
  try {
    const value = kind === 'article' ? extractReadableArticle(body, url, rules) : parseFeed(body, url, rules)
    parentPort!.postMessage({ value })
  } catch (error) {
    parentPort!.postMessage(error instanceof ExtractionLimit ? { limit: error.message } :
      { error: error instanceof Error ? error.message : 'Extraction failed.' })
  }
})
