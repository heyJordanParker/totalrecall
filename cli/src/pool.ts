export type Block = { type: string; [field: string]: unknown }
export type Reply = { readonly content: Block[]; readonly stopReason: string | undefined }

export type StreamEvent = {
  type: string
  index?: number
  content_block?: Block
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string }
  error?: { type?: string; message?: string }
}

export class Accumulator {
  private readonly blocks: Block[] = []
  private readonly json: string[] = []
  stopReason: string | undefined

  add(event: StreamEvent): void {
    if (event.type === 'error') throw new Error(`${event.error?.type ?? 'error'}: ${event.error?.message ?? ''}`)
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

export const readStream = async (body: ReadableStream<Uint8Array>, started: () => void): Promise<Reply> => {
  const reply = new Accumulator()
  const decoder = new TextDecoder()
  let isStarted = false
  let pending = ''
  for await (const chunk of body) {
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
    const response = await this.send(`${this.baseUrl.replace(/\/$/, '')}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ ...body, stream: true }),
    })
    if (!response.ok || response.body === null) {
      throw new Error(`The pool answered ${response.status}: ${(await response.text()).slice(0, 500)}`)
    }
    return readStream(response.body, started)
  }
}
