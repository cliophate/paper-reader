import { listenAiSocket } from './ai-socket.js'
import { createAiWorker } from './ai-worker-server.js'

if (process.getuid?.() === 0) throw new Error('The AI worker must run as a non-root user')

const worker = createAiWorker({
  secret: process.env.PAPER_AI_WORKER_SECRET || '',
  codexBin: process.env.CODEX_BIN || '/usr/local/bin/codex',
})
await listenAiSocket(worker.server, process.env.PAPER_AI_WORKER_SOCKET || '/run/paper-ai/worker.sock')
process.once('SIGTERM', worker.stop)
process.once('SIGINT', worker.stop)
