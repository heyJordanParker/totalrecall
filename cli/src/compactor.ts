import { LINE_BYTES, type Chat, type ChatEvents } from './chat.ts'
import { imageBlock } from './history.ts'
import { PoolError, textOf, type Block, type Pool, type Reply } from './pool.ts'
import { compressTask, headBytes, mergeTask, SYSTEM, tooLong } from './prompt.ts'
import { chatBlocks, mark, type Place } from './render.ts'
import { children, COMPACTION, end, first, flat, name, render, slot, type Line } from './view.ts'

export const COMPACTION_MODEL = 'claude-haiku-5-5'
export const AT_ONCE = 64
const TRIES = 5
const LONGEST_WAIT_MS = 60_000
const COMPACTION_SYSTEM: readonly Block[] = [
  { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
  { type: 'text', text: SYSTEM },
]

type Side = 0 | 1
type Waiter = { readonly before: number; readonly resolve: () => void }

const ctx = ({ l, i }: Line): number => (l === 0 ? i : (i + 1) * 2 ** l)

const insert = (sorted: number[], id: number): void => {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle]! < id) low = middle + 1
    else high = middle
  }
  if (sorted[low] !== id) sorted.splice(low, 0, id)
}

export class Compactor implements ChatEvents {
  private readonly queues: [number[][], number[][]] = [[], []]
  private readonly running = new Map<number, Side>()
  private readonly waiters: Waiter[] = []
  private readonly writing = new Map<string, Promise<void>>()
  private isPumping = false
  private isPumpedAgain = false

  constructor(
    private readonly chat: Chat,
    private readonly pool: Pool,
    private readonly sessionId: string,
    private readonly wait: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
  ) {}

  ready(line: Line): void {
    insert((this.queues[this.chat.lineSide(line)][line.l] ??= []), line.i)
    this.pump()
  }

  changed(): void {
    for (const waiter of this.waiters.splice(0)) {
      if (this.chat.unbuiltAt(0, 0) >= waiter.before) waiter.resolve()
      else this.waiters.push(waiter)
    }
  }

  isSummarized(from: number, to: number): boolean {
    return !this.chat.hasUnbuilt(0, from, to)
  }

  whenSummarized(before: number): Promise<void> {
    if (this.chat.unbuiltAt(0, 0) >= before) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push({ before, resolve }))
  }

  private runningOn(side: Side): number {
    let found = 0
    for (const each of this.running.values()) if (each === side) found += 1
    return found
  }

  private starts(side: Side): Line[] {
    const reach = this.chat.unbuiltAt(side, AT_ONCE - 1)
    const lines: Line[] = []
    this.queues[side].forEach((queue, l) => {
      for (let k = 0; k < queue.length && ctx({ l, i: queue[k]! }) <= reach; k += 1) lines.push({ l, i: queue[k]! })
    })
    return lines.sort((a, b) => ctx(a) - ctx(b) || b.l - a.l)
  }

  private pump(): void {
    if (this.isPumping) {
      this.isPumpedAgain = true
      return
    }
    this.isPumping = true
    try {
      do {
        this.isPumpedAgain = false
        for (const side of [0, 1] as const) {
          for (const line of this.starts(side)) {
            if (this.runningOn(side) >= AT_ONCE) break
            const queue = this.queues[side][line.l]!
            const at = queue.indexOf(line.i)
            if (at === -1) continue
            queue.splice(at, 1)
            if (this.running.has(slot(line)) || this.chat.isBuilt(line)) continue
            const source = this.chat.source(line)
            const isPictured = line.l === 0 && this.chat.message(line.i).images !== undefined
            if (Buffer.byteLength(source) <= LINE_BYTES && !isPictured) this.chat.build(line, source)
            else this.run(line, side)
          }
        }
      } while (this.isPumpedAgain)
    } finally {
      this.isPumping = false
    }
  }

  private run(line: Line, side: Side): void {
    this.running.set(slot(line), side)
    this.compact(line)
      .catch(async (error: unknown) => {
        console.error(`totalrecall: compaction of ${name(line)} failed: ${error instanceof Error ? error.message : String(error)}`)
        await this.wait(LONGEST_WAIT_MS)
        insert((this.queues[side][line.l] ??= []), line.i)
      })
      .finally(() => {
        this.running.delete(slot(line))
        this.pump()
      })
  }

  private context(line: Line): Line[] {
    const upto = Math.min(ctx(line), this.chat.unbuiltAt(this.chat.lineSide(line), 0))
    const lines = this.chat.compactionView.lines.filter((each) => end(each) <= upto && this.chat.isBuilt(each))
    let size = 0
    let from = lines.length
    while (from > 0 && size + this.chat.size(lines[from - 1]!) <= COMPACTION.high) size += this.chat.size(lines[--from]!)
    return lines.slice(from)
  }

  private task(line: Line, source: string): Block[] {
    if (line.l === 0) {
      const [input, close] = compressTask(line.i, source)
      return [{ type: 'text', text: input }, ...(this.chat.message(line.i).images ?? []).map(imageBlock), { type: 'text', text: close }]
    }
    const [a, b] = children(line)
    return [{ type: 'text', text: mergeTask(name(a), name(b), source, first(line), end(line) - 1) }]
  }

  private async compact(line: Line): Promise<void> {
    const source = this.chat.source(line)
    const view = chatBlocks(this.context(line).map((each) => render(each, this.chat)))
    const content = [...view.blocks, ...this.task(line, source)]
    const places: Place[] = view.marked >= 0 ? [{ message: 0, block: view.marked }] : []
    const prefix = String(Bun.hash(JSON.stringify(view.blocks.slice(0, view.marked + 1))))
    const headers = { 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': this.sessionId }
    const lines: string[] = []
    for (let note: Block[] = []; lines.length < TRIES; ) {
      const body = {
        model: COMPACTION_MODEL,
        max_tokens: 32_000,
        system: COMPACTION_SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        messages: mark([{ role: 'user', content: [...content, ...note] }], places),
      }
      const reply = await this.patiently(line, () => this.whileWriting(prefix, (started) => this.pool.complete(body, headers, started)))
      const isWhole = reply !== undefined && (reply.stopReason === 'end_turn' || reply.stopReason === 'stop_sequence')
      const text = isWhole ? textOf(reply.content).replace(/^\d+\+\d+\|/, '') : ''
      if (text === '') break
      lines.push(text)
      if (Buffer.byteLength(text) <= LINE_BYTES) break
      note = [{ type: 'text', text: tooLong(text) }]
    }
    if (lines.length === 0) console.error(`totalrecall: the model wrote no line for ${name(line)}, so its line is its source cut to ${LINE_BYTES} bytes`)
    const best = lines.reduce<string | undefined>((shortest, each) => (shortest === undefined || Buffer.byteLength(each) < Buffer.byteLength(shortest) ? each : shortest), undefined)
    this.chat.build(line, best ?? headBytes(flat(source), LINE_BYTES))
  }

  private async patiently(line: Line, call: () => Promise<Reply>): Promise<Reply | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const reply = await call()
        if (attempt > 0) console.error(`totalrecall: the compaction of ${name(line)} went through after ${attempt + 1} tries`)
        return reply
      } catch (error) {
        if (error instanceof PoolError && error.isLasting) {
          console.error(`totalrecall: the pool refused the compaction of ${name(line)} for good: ${error.message}`)
          return undefined
        }
        if (attempt === 0) console.error(`totalrecall: the compaction of ${name(line)} waits to try again: ${error instanceof Error ? error.message : String(error)}`)
        await this.wait(error instanceof PoolError && error.retryAfterMs !== undefined ? error.retryAfterMs : Math.min(1000 * 2 ** attempt, LONGEST_WAIT_MS))
      }
    }
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
