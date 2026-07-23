const MAX_ERROR_BODY_BYTES = 8 * 1024

async function readLimitedBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let body = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ERROR_BODY_BYTES) {
        await reader.cancel()
        return `${body}${decoder.decode(value.slice(0, Math.max(0, MAX_ERROR_BODY_BYTES - (total - value.byteLength))))}…`
      }
      body += decoder.decode(value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export async function assertResponseOk(response: Response, provider: string): Promise<void> {
  if (response.ok) return
  const body = (await readLimitedBody(response)).trim()
  throw new Error(`${provider} error ${response.status}${body ? `: ${body}` : ''}`)
}
