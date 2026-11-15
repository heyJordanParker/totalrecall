import { afterAll, expect, setSystemTime, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chat, type Entry as Imported } from '../src/chat.ts'
import { COMPACTION_MODEL, Compactor } from '../src/compactor.ts'
import { Filter, OWN_TOOLS, type Tool } from '../src/filter.ts'
import type { ApiMessage } from '../src/history.ts'
import { Pool, type Block } from '../src/pool.ts'
import { Sessions } from '../src/sessions.ts'

type Entry = { from: number; until: number; ttl: number }
type Use = { read: number; write: number; input: number; n: number }
type Uses = Record<'turn' | 'compaction', Use>
type Step = { tool: string; echo: string; echoMs: number }
type Turn = { at: number; prompt: string; steps: Step[]; reply: string }
type Body = { model: string; tools?: unknown; thinking?: unknown; output_config?: unknown; system?: Block[]; messages: ApiMessage[]; cache_control?: unknown }

const LOOK = 20
const FIRST = 1500
const TTL: Record<string, number> = { '5m': 300e3, '1h': 3600e3 }
const DEVICE = 'mac:/work'
const HEADERS = { 'x-claude-code-session-id': 's1' }
const TOOLS: Tool[] = [
  { name: 'Bash', description: 'Runs a command.', input_schema: { type: 'object' } },
  { name: OWN_TOOLS.zoom, description: 'zoom', input_schema: { type: 'object' } },
]
const SYSTEM: Block[] = [
  { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.325; cc_entrypoint=cli;' },
  { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral', ttl: '1h' } },
  { type: 'text', text: `Claude Code's own prompt. ${'p'.repeat(20_000)}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
]
const CONTEXT: Block = { type: 'text', text: `<system-reminder>\nContents of /work/CLAUDE.md (project instructions, checked into the codebase):\n\n${'i'.repeat(30_000)}\n</system-reminder>` }

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

let now = Date.UTC(2026, 9, 1)
let seed = 1
const queue: { at: number; go: () => void }[] = []

const rand = (): number => {
  seed = (seed * 48271) % 2147483647
  return seed / 2147483647
}

const span = (a: number, b: number): number => a * (b / a) ** rand()

const text = (a: number, b: number): string => randomBytes(Math.ceil(span(a, b) * 0.75)).toString('base64')

const later = (ms: number, go: () => void): void => {
  const at = now + ms
  const k = queue.findIndex((event) => event.at > at)
  queue.splice(k < 0 ? queue.length : k, 0, { at, go })
}

const after = (ms: number): Promise<void> => new Promise((resolve) => later(ms, resolve))

const drain = async (): Promise<void> => {
  while (queue.length > 0) {
    const event = queue.shift()!
    now = Math.max(now, event.at)
    setSystemTime(new Date(now))
    event.go()
    for (let k = 0; k < 8; k += 1) await new Promise((resolve) => setImmediate(resolve))
  }
}

const settle = async (): Promise<void> => {
  setSystemTime(new Date(now))
  for (let idle = 0; idle < 4; idle = queue.length > 0 ? 0 : idle + 1) {
    await drain()
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

const ttlOf = (mark: unknown): number => TTL[(mark as { ttl?: string }).ttl ?? '5m']!

const cached = (): ((body: Body) => Use) => {
  const cache = new Map<string, Entry>()
  return (body) => {
    const head = JSON.stringify([body.model, body.tools, body.thinking, body.output_config])
    const blocks: Block[] = [...(body.system ?? []), ...body.messages.flatMap((message) => (message.content as Block[]).map((block) => ({ ...block, role: message.role })))]
    const marks = blocks.flatMap((block, k) => (block['cache_control'] !== undefined ? [{ k, ttl: ttlOf(block['cache_control']) }] : []))
    if (body.cache_control !== undefined) marks.push({ k: blocks.length - 1, ttl: ttlOf(body.cache_control) })
    expect(marks.length).toBeLessThanOrEqual(4)
    const keys: string[] = []
    const ends: number[] = []
    for (const { cache_control: _mark, ...block } of blocks) {
      const shown = JSON.stringify(block)
      keys.push(hash((keys.at(-1) ?? head) + shown))
      ends.push((ends.at(-1) ?? 0) + shown.length)
    }
    const live = (k: number): boolean => {
      const entry = cache.get(keys[k]!)
      return entry !== undefined && entry.from <= now && entry.until >= now
    }
    let hit = -1
    for (const { k: mark } of marks) {
      for (let k = mark; k > mark - LOOK && k >= 0; k -= 1) {
        if (live(k)) {
          hit = Math.max(hit, k)
          break
        }
      }
    }
    if (hit >= 0) {
      const entry = cache.get(keys[hit]!)!
      entry.until = now + entry.ttl
    }
    for (const { k, ttl } of marks) {
      if (k > hit && !live(k)) cache.set(keys[k]!, { from: now + FIRST, until: now + ttl, ttl })
    }
    const read = hit < 0 ? 0 : ends[hit]!
    const last = Math.max(-1, ...marks.map(({ k }) => k))
    const write = Math.max(0, (last < 0 ? 0 : ends[last]!) - read)
    return { read, write, input: ends.at(-1)! - read - write, n: 1 }
  }
}

const count = (use: Use, into: Use, uncacheable = 0): void => {
  for (const key of ['read', 'write', 'input', 'n'] as const) into[key] += use[key]
  into.input -= uncacheable
}

const events = (block: Block, stop: string): object[] => [
  { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
  { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } },
  block.type === 'tool_use'
    ? { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block['input']) } }
    : { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block['text'] } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop } },
  { type: 'message_stop' },
]

const stream = (all: object[]): Response => {
  const sse = (some: object[]): Uint8Array => new TextEncoder().encode(some.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
  const ms = span(3000, 9000)
  return new Response(
    new ReadableStream({
      start(out) {
        later(FIRST, () => out.enqueue(sse(all.slice(0, 1))))
        later(ms, () => {
          out.enqueue(sse(all.slice(1)))
          out.close()
        })
      },
    }),
  )
}

const taskSize = (messages: ApiMessage[]): number => {
  const content = messages[0]!.content as Block[]
  const close = content.findIndex((block) => String(block['text'] ?? '').endsWith('</chat>'))
  return content.slice(close + 1).reduce((size, { cache_control: _mark, ...block }) => size + JSON.stringify({ ...block, role: 'user' }).length, 0)
}

const replay = () => {
  const folder = mkdtempSync(join(tmpdir(), 'totalrecall-cache-'))
  folders.push(folder)
  const uses: Uses = { turn: { read: 0, write: 0, input: 0, n: 0 }, compaction: { read: 0, write: 0, input: 0, n: 0 } }
  const anthropic = cached()
  const send = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body
    expect(body.model).toBe(COMPACTION_MODEL)
    count(anthropic(body), uses.compaction, taskSize(body.messages))
    const isRetry = (body.messages[0]!.content as Block[]).some((block) => String(block['text'] ?? '').startsWith('Too long:'))
    const line = `user: ${'x'.repeat(!isRetry && rand() < 0.25 ? 600 : 120 + Math.floor(rand() * 330))}`
    return stream(events({ type: 'text', text: line }, 'end_turn'))
  }) as unknown as typeof fetch
  const chat = new Chat(join(folder, 'chat'))
  const compactor = new Compactor(chat, new Pool('http://pool', send), 'totalrecall-compaction', (ms) => after(ms))
  chat.listen(compactor)
  const filter = new Filter(chat, compactor, new Sessions(join(folder, 'sessions')), () => false, 60_000)
  const history: ApiMessage[] = []
  let requests = 0

  const claudeCode = (messages: ApiMessage[]): Body => ({
    model: 'claude-opus-5-5',
    system: SYSTEM,
    tools: TOOLS,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    messages: messages.map((message, index) =>
      index === messages.length - 1
        ? { ...message, content: (message.content as Block[]).map((block, k, all) => (k === all.length - 1 ? { ...block, cache_control: { type: 'ephemeral', ttl: '1h' } } : block)) }
        : message,
    ),
  })

  const ask = async (messages: ApiMessage[], block: Block): Promise<void> => {
    const id = `r${(requests += 1)}`
    const body = claudeCode(messages)
    const answer = await filter.request(DEVICE, { id, path: '/v1/messages', headers: HEADERS, body: { ...body, max_tokens: 64_000, stream: true } })
    count(anthropic((answer.body ?? body) as Body), uses.turn)
    const all = events(block, block.type === 'tool_use' ? 'tool_use' : 'end_turn')
    await after(span(3000, 9000))
    all.forEach((event, index) => filter.response({ id, body: event, endOfStream: index === all.length - 1 }))
  }

  const turn = async ({ prompt, steps, reply }: Turn): Promise<void> => {
    const opening: ApiMessage = { role: 'user', content: history.length === 0 ? [CONTEXT, { type: 'text', text: prompt }] : [{ type: 'text', text: prompt }] }
    const done: ApiMessage[] = []
    for (const [k, step] of steps.entries()) {
      const call: Block = { type: 'tool_use', id: `t${requests}-${k}`, name: 'Bash', input: { command: step.tool } }
      await ask([...history, opening, ...done], call)
      await after(step.echoMs)
      done.push({ role: 'assistant', content: [call] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call['id'], content: step.echo }] })
    }
    const answer: Block = { type: 'text', text: reply }
    await ask([...history, opening, ...done], answer)
    history.push(opening, ...done, { role: 'assistant', content: [answer] })
  }

  return { chat, uses, turn }
}

const synthetic = (messages: number): Turn[] => {
  const turns: Turn[] = []
  let at = 0
  let total = 0
  while (total < messages) {
    at += span(20e3, 240e3)
    const steps = Array.from({ length: Math.floor(rand() * 7) }, () => ({ tool: text(80, 600), echo: text(40, 8000), echoMs: span(1e3, 6e3) }))
    turns.push({ at, prompt: text(40, 1500), steps, reply: text(100, 2500) })
    total += 2 + 2 * steps.length
  }
  return turns
}

const imported = (messages: number): Imported[] =>
  Array.from({ length: messages }, (_, k) => {
    const kind = (['user', 'claude', 'tool', 'echo'] as const)[k % 4]!
    return { kind, text: kind === 'echo' ? text(40, 8000) : text(40, 1500), date: new Date(Date.UTC(2026, 5, 1) + k * 60e3).toISOString() }
  })

const share = (use: Use): number => use.read / (use.read + use.write + use.input)
const written = (use: Use): number => use.write / (use.read + use.write + use.input)
const report = (uses: Uses): string =>
  Object.entries(uses)
    .filter(([, use]) => use.n > 0)
    .map(([kind, use]) => `${kind}: ${use.n} requests, ${(100 * share(use)).toFixed(1)}% read, ${(100 * written(use)).toFixed(1)}% written`)
    .join('; ')

test('turns and compactions read at least 95% of their input from the cache, as UniiChat’s do', async () => {
  const { uses, turn } = replay()
  let turns = Promise.resolve()
  for (const each of synthetic(3000)) later(each.at, () => (turns = turns.then(() => turn(each))))
  await settle()
  await turns
  setSystemTime()
  console.log(report(uses))
  expect(share(uses.turn)).toBeGreaterThanOrEqual(0.95)
  expect(share(uses.compaction)).toBeGreaterThanOrEqual(0.95)
  expect(written(uses.compaction)).toBeLessThanOrEqual(0.05)
}, 900e3)

test('an import’s summaries read at least 95% of their input from the cache', async () => {
  const { chat, uses } = replay()
  const backlog = imported(6000)
  for (let k = 0; k < backlog.length; k += 500) later(k * 20, () => chat.logImported(backlog.slice(k, k + 500), new Date(now)))
  await settle()
  setSystemTime()
  console.log(report(uses))
  expect(share(uses.compaction)).toBeGreaterThanOrEqual(0.95)
  expect(written(uses.compaction)).toBeLessThanOrEqual(0.05)
}, 900e3)
