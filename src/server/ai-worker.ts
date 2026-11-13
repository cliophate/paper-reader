import { createAiWorker } from './ai-worker-server.js'

if (process.getuid?.() === 0) throw new Error('The AI worker must run as a non-root user')

const worker = createAiWorker({
  secret: process.env.PAPER_AI_WORKER_SECRET || '',
  codexBin: process.env.CODEX_BIN || '/usr/local/bin/codex',
})
worker.server.listen(Number(process.env.PORT || 8081), process.env.HOST || '0.0.0.0')
process.once('SIGTERM', worker.stop)
process.once('SIGINT', worker.stop)
