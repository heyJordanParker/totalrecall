export type Block = { type: string; [field: string]: unknown }
export type Reply = { readonly content: Block[]; readonly stopReason: string | undefined }

export type StreamEvent = {
  type: string
  index?: number
  content_block?: Block
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string }
  error?: { type?: string; message?: string }
}

const LASTING_STATUSES = new Set([400, 413])
const IDLE_MS = 300_000

export class PoolError extends Error {
  constructor(
    message: string,
    readonly isLasting: boolean,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message)
  }
}

const retryAfter = (headers: Headers): number | undefined => {
  const seconds = Number(headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

export class Accumulator {
  private readonly blocks: Block[] = []
  private readonly json: string[] = []
  stopReason: string | undefined

  add(event: StreamEvent): void {
    if (event.type === 'error') {
      throw new PoolError(`${event.error?.type ?? 'error'}: ${event.error?.message ?? ''}`, event.error?.type === 'invalid_request_error', undefined)
    }
    if (event.type === 'content_block_start' && event.index !== undefined && event.content_block !== undefined) {
      this.blocks[event.index] = { ...event.content_block }
      this.json[event.index] = ''
    }
    if (event.type === 'content_block_delta' && event.index !== undefined && event.delta !== undefined) {
      const block = this.blocks[event.index]
      const { delta } = event
      if (block === undefined) return
      if (delta.type === 'text_delta') block['text'] = `${String(block['text'] ?? '')}${delta.text ?? ''}`
      if (delta.type === 'thinking_delta') block['thinking'] = `${String(block['thinking'] ?? '')}${delta.thinking ?? ''}`
      if (delta.type === 'signature_delta') block['signature'] = delta.signature ?? ''
      if (delta.type === 'input_json_delta') this.json[event.index] = `${this.json[event.index] ?? ''}${delta.partial_json ?? ''}`
    }
    if (event.type === 'content_block_stop' && event.index !== undefined && this.json[event.index]) {
      this.blocks[event.index]!['input'] = JSON.parse(this.json[event.index]!)
    }
    if (event.type === 'message_delta' && event.delta?.stop_reason !== undefined) this.stopReason = event.delta.stop_reason
  }

  get content(): Block[] {
    return this.blocks.filter((block) => block !== undefined)
  }
}

export const readStream = async (body: ReadableStream<Uint8Array>, started: () => void, heard: () => void = () => {}): Promise<Reply> => {
  const reply = new Accumulator()
  const decoder = new TextDecoder()
  let isStarted = false
  let pending = ''
  for await (const chunk of body) {
    heard()
    pending += decoder.decode(chunk, { stream: true })
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline).trimEnd()
      pending = pending.slice(newline + 1)
      if (line.startsWith('data:')) {
        if (!isStarted) {
          isStarted = true
          started()
        }
        reply.add(JSON.parse(line.slice(5).trim()) as StreamEvent)
      }
      newline = pending.indexOf('\n')
    }
  }
  return { content: reply.content, stopReason: reply.stopReason }
}

export const textOf = (content: readonly Block[]): string =>
  content
    .filter((block) => block.type === 'text')
    .map((block) => String(block['text'] ?? ''))
    .join('')
    .trim()

export class Pool {
  constructor(
    private readonly baseUrl: string,
    private readonly send: typeof fetch = fetch,
  ) {}

  async complete(body: object, headers: Record<string, string>, started: () => void = () => {}): Promise<Reply> {
    const idle = new AbortController()
    let timer = setTimeout(() => idle.abort(), IDLE_MS)
    const heard = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(), IDLE_MS)
    }
    try {
      const response = await this.send(`${this.baseUrl.replace(/\/$/, '')}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ ...body, stream: true }),
        signal: idle.signal,
      })
      if (!response.ok || response.body === null) {
        throw new PoolError(`The pool answered ${response.status}: ${(await response.text()).slice(0, 500)}`, LASTING_STATUSES.has(response.status), retryAfter(response.headers))
      }
      const reply = await readStream(response.body, started, heard)
      if (reply.stopReason === undefined) throw new PoolError('The pool ended the reply before the model finished it.', false, undefined)
      return reply
    } catch (error) {
      if (error instanceof PoolError) throw error
      throw new PoolError(`The pool did not answer: ${error instanceof Error ? error.message : String(error)}`, false, undefined)
    } finally {
      clearTimeout(timer)
    }
  }
}
