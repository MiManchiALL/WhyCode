import type { WebPageWorkerRequest, WebPageWorkerResponse } from './protocol.ts'

const parentPort = process.parentPort
if (!parentPort) throw new Error('网页提取 Utility Process 缺少 parentPort')

parentPort.once('message', async (event) => {
  const request = event.data as WebPageWorkerRequest
  let response: WebPageWorkerResponse
  try {
    const { extractWebPage } = await import('./extract.ts')
    response = { id: request.id, ok: true, result: extractWebPage(request.document) }
  } catch {
    response = { id: request.id, ok: false, error: '网页正文提取失败' }
  }
  parentPort.postMessage(response)
  setTimeout(() => process.exit(response.ok ? 0 : 1), 0)
})
