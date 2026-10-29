import { LINE_BYTES, type Chat, type ChatEvents } from './chat.ts'
import { imageBlock } from './history.ts'
import { textOf, type Block, type Pool } from './pool.ts'
import { compressTask, mergeTask, tooLong } from './prompt.ts'
import { chatBlocks, mark, type Place } from './render.ts'
import { children, end, first, name, render, type Line } from './view.ts'

export type Template = {
  readonly headers: Readonly<Record<string, string>>
  readonly system: readonly Block[]
  readonly tools: readonly object[]
  readonly instructions: readonly { role: string; content: Block[] }[]
  readonly metadata?: unknown
}

export const COMPACTION_MODEL = 'claude-haiku-5-5'
const AT_ONCE = 8
const TRIES = 5
const DROPPED_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding', 'x-claude-code-agent-id', 'x-claude-code-agent-type'])

type Waiter = { readonly before: number; readonly resolve: () => void }

export class Compactor implements ChatEvents {
  private readonly messages: number[] = []
  private readonly merges: Line[] = []
  private readonly unbuilt = new Set<number>()
  private readonly failed: Line[] = []
  private readonly waiters: Waiter[] = []
  private readonly writing = new Map<string, Promise<void>>()
  private running = 0
  private template: Template | undefined

  constructor(
    private readonly chat: Chat,
    private readonly pool: Pool,
    private readonly sessionId: string,
  ) {}

  useTemplate(template: Template): void {
    if (this.template !== undefined) return
    this.template = template
    this.pump()
  }

  ready(line: Line): void {
    if (line.l === 0) {
      this.unbuilt.add(line.i)
      const at = this.messages.findIndex((id) => id > line.i)
      this.messages.splice(at === -1 ? this.messages.length : at, 0, line.i)
    } else {
      this.merges.push(line)
    }
    this.pump()
  }

  retryFailed(): void {
    for (const line of this.failed.splice(0)) this.ready(line)
  }

  isSummarized(from: number, to: number): boolean {
    return ![...this.unbuilt].some((id) => id >= from && id < to)
  }

  whenSummarized(before: number): Promise<void> {
    if (![...this.unbuilt].some((id) => id < before)) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push({ before, resolve }))
  }

  private unbuiltBefore(id: number): number {
    let found = 0
    for (const other of this.unbuilt) if (other < id) found += 1
    return found
  }

  private next(): Line | undefined {
    const message = this.messages[0]
    if (message !== undefined && this.unbuiltBefore(message) < AT_ONCE) {
      this.messages.shift()
      return { l: 0, i: message }
    }
    return this.merges.shift()
  }

  private pump(): void {
    if (this.template === undefined) return
    while (this.running < AT_ONCE) {
      const line = this.next()
      if (line === undefined) return
      this.running += 1
      this.compact(line, this.template)
        .catch((error: unknown) => {
          console.error(`totalrecall: compaction of ${name(line)} failed: ${error instanceof Error ? error.message : String(error)}`)
          this.failed.push(line)
        })
        .finally(() => {
          this.running -= 1
          this.pump()
        })
    }
  }

  private built(line: Line, text: string): void {
    this.chat.build(line, text)
    if (line.l !== 0) return
    this.unbuilt.delete(line.i)
    for (const waiter of this.waiters.splice(0)) {
      if ([...this.unbuilt].some((id) => id < waiter.before)) this.waiters.push(waiter)
      else waiter.resolve()
    }
  }

  private context(line: Line): Line[] {
    const boundary = line.l === 0 ? first(line) : end(line)
    const lines: Line[] = []
    for (const candidate of this.chat.compactionView.lines) {
      if (end(candidate) > boundary || !this.chat.isBuilt(candidate)) break
      lines.push(candidate)
    }
    return lines
  }

  private task(line: Line): Block[] {
    if (line.l === 0) {
      const message = this.chat.message(line.i)
      const [input, close] = compressTask(line.i, message.kind, message.text)
      return [{ type: 'text', text: input }, ...(message.images ?? []).map(imageBlock), { type: 'text', text: close }]
    }
    const [a, b] = children(line)
    return [{ type: 'text', text: mergeTask(name(a), name(b), render(a, this.chat), render(b, this.chat), first(line), end(line) - 1) }]
  }

  private async compact(line: Line, template: Template): Promise<void> {
    const view = chatBlocks(this.context(line).map((each) => render(each, this.chat)))
    const messages = template.instructions.map((message) => ({ role: message.role, content: [...message.content] }))
    const places: Place[] = messages.length === 0 ? [] : [{ message: messages.length - 1, block: messages.at(-1)!.content.length - 1 }]
    const into = messages.at(-1)?.role === 'user' ? messages.at(-1)! : messages[messages.push({ role: 'user', content: [] }) - 1]!
    if (view.marked >= 0) places.push({ message: messages.indexOf(into), block: into.content.length + view.marked })
    into.content.push(...view.blocks, ...this.task(line))
    const headers = Object.fromEntries(Object.entries(template.headers).filter(([header]) => !DROPPED_HEADERS.has(header)))
    const prefix = String(Bun.hash(JSON.stringify([template.system, template.tools, template.instructions, view.blocks.slice(0, view.marked + 1)])))
    let best: string | undefined
    for (let attempt = 0; attempt < TRIES; attempt += 1) {
      const body = {
        model: COMPACTION_MODEL,
        max_tokens: 32_000,
        system: template.system,
        tools: template.tools,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'xhigh' },
        ...(template.metadata === undefined ? {} : { metadata: template.metadata }),
        messages: mark(messages, places),
      }
      const reply = await this.whileWriting(prefix, (started) =>
        this.pool.complete(body, { ...headers, 'x-claude-code-session-id': this.sessionId }, started),
      )
      const text = textOf(reply.content).replace(/^\d+\+\d+\|/, '')
      if (text === '') throw new Error(`the model wrote no line (stop reason ${reply.stopReason ?? 'none'})`)
      if (best === undefined || Buffer.byteLength(text) < Buffer.byteLength(best)) best = text
      if (Buffer.byteLength(text) <= LINE_BYTES) break
      messages.push({ role: 'assistant', content: reply.content }, { role: 'user', content: [{ type: 'text', text: tooLong(text) }] })
    }
    this.built(line, best!)
  }

  private async whileWriting<T>(prefix: string, call: (started: () => void) => Promise<T>): Promise<T> {
    const writer = this.writing.get(prefix)
    if (writer !== undefined) {
      await writer
      return call(() => {})
    }
    let started = (): void => {}
    this.writing.set(prefix, new Promise((resolve) => (started = resolve)))
    try {
      return await call(started)
    } finally {
      started()
      this.writing.delete(prefix)
    }
  }
}
