import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { LINE_BYTES, type Chat, type Entry, type Kind } from './chat.ts'
import { pages } from './clip.ts'
import { itemsOf, type AgentNames, type ApiMessage } from './history.ts'
import type { Block } from './pool.ts'
import type { Sessions } from './sessions.ts'

export type Source = { readonly key: string; readonly app: string; readonly where: string; readonly read: () => Entry[] }
export type Want = { readonly since: string; readonly tools: boolean }
export type ImportState = { readonly done: Readonly<Record<string, string>>; readonly logged: readonly string[]; readonly total: number; readonly waiting: number }
export type Imported = { readonly key: string; readonly entries: readonly Entry[] }

const CHUNK = 16 * 2 ** 20
const PART = 8 * 2 ** 20
const LINE = 480
const INJECTED = /^(<[a-z_]+[ >]|# AGENTS\.md)/
const SAYS = new Set<Kind>(['user', 'claude', 'work'])
const unnamed: AgentNames = { nameAgent: (_id, task) => task, agentName: () => undefined }

function* linesOf(path: string): Generator<string> {
  const fd = openSync(path, 'r')
  try {
    const chunk = Buffer.alloc(CHUNK)
    let rest = Buffer.alloc(0)
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
      const content = Buffer.concat([rest, chunk.subarray(0, read)])
      let at = 0
      for (let newline = content.indexOf(10, at); newline !== -1; newline = content.indexOf(10, at)) {
        yield content.subarray(at, newline).toString()
        at = newline + 1
      }
      rest = Buffer.from(content.subarray(at))
    }
    if (rest.length > 0) yield rest.toString()
  } finally {
    closeSync(fd)
  }
}

const parsed = (line: string): Record<string, any> | undefined => {
  try {
    const value = JSON.parse(line) as unknown
    return typeof value === 'object' && value !== null ? (value as Record<string, any>) : undefined
  } catch {
    return undefined
  }
}

const dateOf = (at: unknown, last: string): string => {
  const ms = typeof at === 'number' ? at * 1000 : Date.parse(String(at))
  return Number.isNaN(ms) ? last : new Date(ms).toISOString()
}

const partsText = (content: unknown): string => {
  if (typeof content === 'string') return content
  const parts = Array.isArray(content) ? content : []
  return parts
    .map((part: any) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : String(part?.type ?? part?.content_type).includes('image') ? '[image]' : ''))
    .join('\n')
}

const entryOf = (kind: Kind, text: string, date: string): Entry[] => (text.trim() === '' ? [] : [{ kind, text, date }])

const withDevice = (input: unknown, device: string): string => {
  const value = typeof input === 'string' ? parsed(input) : input
  return JSON.stringify(typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value, device } : { input, device })
}

const claudeCode = (path: string, host: string): Source => {
  const key = `claude-code:${basename(path, '.jsonl')}`
  let where = ''
  const read = (): Entry[] => {
    const entries: Entry[] = []
    const calls = new Map<string, Block>()
    let date = ''
    for (const line of linesOf(path)) {
      const record = parsed(line)
      if (record === undefined) continue
      date = dateOf(record['timestamp'], date)
      if (typeof record['cwd'] === 'string' && where === '') where = `session in ${record['cwd']} on ${host}`
      if (record['type'] === 'attachment' && record['attachment']?.type === 'queued_command') {
        const queued: ApiMessage = { role: 'user', content: String(record['attachment'].prompt ?? '') }
        for (const item of itemsOf(queued, '', () => undefined, unnamed)) entries.push({ kind: item.kind, text: item.text, date })
        continue
      }
      const isOwn = (record['type'] === 'user' || record['type'] === 'assistant') && record['isMeta'] !== true && record['isSidechain'] !== true && record['isCompactSummary'] !== true
      const message = record['message'] as ApiMessage | undefined
      if (!isOwn || message === undefined || (typeof message.content !== 'string' && !Array.isArray(message.content))) continue
      if (Array.isArray(message.content)) for (const block of message.content) if (block.type === 'tool_use') calls.set(String(block['id']), block)
      const device = `${host}:${String(record['cwd'] ?? '')}`
      for (const item of itemsOf(message, device, (id) => calls.get(id), unnamed)) {
        entries.push({ kind: item.kind, text: item.text + '\n[image]'.repeat(item.images.length), date })
      }
    }
    return entries
  }
  return {
    key,
    app: 'Claude Code',
    get where() {
      return where
    },
    read,
  }
}

const codexItem = (payload: Record<string, any>, date: string, device: string): Entry[] => {
  switch (payload['type']) {
    case 'message': {
      const kind = payload['role'] === 'user' ? 'user' : payload['role'] === 'assistant' ? 'claude' : undefined
      const parts = (Array.isArray(payload['content']) ? payload['content'] : []).filter((part: any) => !INJECTED.test(part?.text ?? ''))
      return kind === undefined ? [] : entryOf(kind, partsText(parts), date)
    }
    case 'function_call':
      return entryOf('tool', `${String(payload['name'])} ${withDevice(payload['arguments'], device)}`, date)
    case 'custom_tool_call':
      return entryOf('tool', `${String(payload['name'])} ${JSON.stringify({ input: payload['input'], device })}`, date)
    case 'local_shell_call':
      return entryOf('tool', `shell ${JSON.stringify({ command: payload['action']?.command, device })}`, date)
    case 'function_call_output':
    case 'custom_tool_call_output':
      return entryOf('echo', partsText(payload['output']), date)
  }
  return []
}

const codex = (path: string, host: string): Source => {
  let where = ''
  const read = (): Entry[] => {
    const entries: Entry[] = []
    let date = ''
    let device = ''
    for (const line of linesOf(path)) {
      const record = parsed(line)
      if (record === undefined) continue
      const payload = (record['payload'] ?? {}) as Record<string, any>
      date = dateOf(record['timestamp'], date)
      if (record['type'] === 'session_meta') {
        const isAgent = payload['source']?.subagent !== undefined || payload['source']?.internal !== undefined
        where = isAgent ? '' : `session in ${String(payload['cwd'] ?? '')} on ${host}`
        device = `${host}:${String(payload['cwd'] ?? '')}`
      }
      if (record['type'] === 'response_item' && where !== '') entries.push(...codexItem(payload, date, device))
    }
    return entries
  }
  return {
    key: `codex:${basename(path, '.jsonl')}`,
    app: 'Codex',
    get where() {
      return where
    },
    read,
  }
}

const zipEntry = (zip: Buffer, name: string): Buffer | undefined => {
  let tail = zip.length - 22
  while (tail >= 0 && zip.readUInt32LE(tail) !== 0x06054b50) tail -= 1
  if (tail < 0) return undefined
  const isWide = tail >= 20 && zip.readUInt32LE(tail - 20) === 0x07064b50
  const wide = isWide ? Number(zip.readBigUInt64LE(tail - 12)) : 0
  const count = isWide ? Number(zip.readBigUInt64LE(wide + 32)) : zip.readUInt16LE(tail + 10)
  let at = isWide ? Number(zip.readBigUInt64LE(wide + 48)) : zip.readUInt32LE(tail + 16)
  for (let k = 0; k < count; k += 1) {
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const entry = zip.subarray(at + 46, at + 46 + nameLength).toString()
    const short = [zip.readUInt32LE(at + 20), zip.readUInt32LE(at + 42)]
    let extra = at + 46 + nameLength
    while (extra + 4 <= at + 46 + nameLength + extraLength && zip.readUInt16LE(extra) !== 1) extra += 4 + zip.readUInt16LE(extra + 2)
    const wanted = [zip.readUInt32LE(at + 24), ...short]
    let next = 0
    const [, packed, local] = wanted.map((value) => (value === 0xffffffff ? Number(zip.readBigUInt64LE(extra + 4 + 8 * next++)) : value)) as [number, number, number]
    if (entry === name || entry.endsWith(`/${name}`)) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + packed)
      return zip.readUInt16LE(at + 10) === 8 ? inflateRawSync(data) : data
    }
    at += 46 + nameLength + extraLength + zip.readUInt16LE(at + 32)
  }
  return undefined
}

const claudeChat = (chat: Record<string, any>): Entry[] => {
  let date = dateOf(chat['created_at'], '')
  const calls = new Map<string, Block>()
  return (chat['chat_messages'] ?? []).flatMap((message: Record<string, any>) => {
    date = dateOf(message['created_at'], date)
    const role = message['sender'] === 'human' ? 'user' : 'assistant'
    const blocks: Block[] = Array.isArray(message['content']) ? message['content'] : [{ type: 'text', text: String(message['text'] ?? '') }]
    const files: Block[] = [...(message['attachments'] ?? []), ...(message['files'] ?? [])].map((file: any) => ({ type: 'text', text: `[file ${String(file.file_name)}]` }))
    for (const block of blocks) if (block.type === 'tool_use') calls.set(String(block['id']), block)
    return itemsOf({ role, content: [...blocks, ...files] }, '', (id) => calls.get(id), unnamed).map((item) => ({ kind: item.kind, text: item.text, date }))
  })
}

const chatgptChat = (chat: Record<string, any>): Entry[] => {
  const nodes: Record<string, any>[] = []
  for (let id = chat['current_node']; id; id = chat['mapping'][id]?.parent) nodes.unshift(chat['mapping'][id]?.message)
  let date = dateOf(chat['create_time'], '')
  return nodes.flatMap((message) => {
    const role = message?.author?.role
    const type = String(message?.content?.content_type)
    const kind: Kind | undefined = role === 'user' ? 'user' : role === 'assistant' ? (message.recipient === 'all' ? 'claude' : 'tool') : role === 'tool' ? 'echo' : undefined
    date = dateOf(message?.create_time, date)
    const isHidden = kind === undefined || message.metadata?.is_visually_hidden_from_conversation === true || type === 'thoughts' || type === 'reasoning_recap'
    return isHidden ? [] : entryOf(kind, (kind === 'tool' ? `${String(message.recipient)} ` : '') + partsText(message.content.parts ?? [message.content.text]), date)
  })
}

const exported = (path: string): Source[] => {
  const file = readFileSync(path)
  const json = file.subarray(0, 2).toString() === 'PK' ? zipEntry(file, 'conversations.json') : file
  if (json === undefined) throw new Error(`${path} holds no conversations.json.`)
  const chats = parsed(json.toString()) as unknown
  if (!Array.isArray(chats) || !chats.every((chat) => chat?.mapping !== undefined || Array.isArray(chat?.chat_messages))) throw new Error(`${path} is not a Claude or ChatGPT export.`)
  return chats.map((chat: Record<string, any>) => {
    const isChatgpt = chat['mapping'] !== undefined
    const title = String(chat['title'] ?? chat['name'] ?? '')
    const id = String(chat['id'] ?? chat['conversation_id'] ?? chat['uuid'] ?? `${title} ${String(chat['create_time'] ?? chat['created_at'])}`)
    return { key: `${isChatgpt ? 'chatgpt' : 'claude'}:${id}`, app: isChatgpt ? 'ChatGPT' : 'Claude', where: `chat "${title}"`, read: () => (isChatgpt ? chatgptChat(chat) : claudeChat(chat)) }
  })
}

const sessionFiles = (folder: string): string[] => {
  if (!existsSync(folder)) return []
  return (readdirSync(folder, { recursive: true }) as string[])
    .filter((path) => path.endsWith('.jsonl') && !path.split('/').includes('subagents'))
    .map((path) => join(folder, path))
    .filter((path) => statSync(path).isFile())
}

export const sources = (exports: readonly string[], home = homedir(), environment = process.env): Source[] => {
  const host = hostname()
  const claude = join(environment['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude'), 'projects')
  const codexHome = environment['CODEX_HOME'] ?? join(home, '.codex')
  return [
    ...sessionFiles(claude).map((path) => claudeCode(path, host)),
    ...[join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')].flatMap(sessionFiles).map((path) => codex(path, host)),
    ...exports.flatMap(exported),
  ]
}

export const noteOf = (source: Source, start: string): Entry => ({
  kind: 'note',
  text: `${source.app} ${source.where}, from ${new Date(start).toLocaleString('sv-SE').slice(0, 16)} (imported)`,
  date: start,
})

export const picked = (source: Source, want: Want, last: string | undefined): Entry[] => {
  const entries = source.read()
  if (source.where === '' || entries.length === 0) return []
  const fresh = entries.filter((entry) => (want.tools || SAYS.has(entry.kind)) && (entry.date ?? '') >= want.since && (last === undefined || (entry.date ?? '') > last))
  return fresh.length === 0 ? [] : [noteOf(source, entries[0]!.date ?? fresh[0]!.date!), ...fresh]
}

export const summaries = (total: number, sizes: readonly number[]): number => {
  let calls = 0
  let nodes = [...sizes]
  for (let at = total; nodes.length > 0; at = Math.floor(at / 2)) {
    calls += nodes.filter((bytes) => bytes > LINE_BYTES).length
    const line = (k: number): number => (k < 0 || nodes[k]! > LINE_BYTES ? LINE : nodes[k]!)
    const from = Math.floor(at / 2)
    nodes = Array.from({ length: Math.floor((at + nodes.length) / 2) - from }, (_, j) => line(2 * (from + j) - at) + 1 + line(2 * (from + j) + 1 - at))
  }
  return calls
}

export const sizeOf = (entry: Entry): number[] => pages(entry.text).map((page) => Buffer.byteLength(`${entry.kind}: ${page}`))

export class Imports {
  private readonly done: Record<string, string>

  constructor(
    private readonly chat: Chat,
    private readonly sessions: Sessions,
    private readonly path: string,
  ) {
    this.done = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {}
  }

  state(): ImportState {
    return { done: this.done, logged: this.sessions.histories().filter((history) => !history.includes('/')), total: this.chat.total, waiting: this.chat.unbuiltCount(1) }
  }

  has(session: string): boolean {
    return this.done[`claude-code:${session}`] !== undefined
  }

  add(imported: readonly Imported[]): number {
    const logged = new Set(this.state().logged.map((session) => `claude-code:${session}`))
    const entries: Entry[] = []
    const lasts = new Map<string, string>()
    for (const { key, entries: given } of imported) {
      if (logged.has(key)) continue
      const last = this.done[key]
      const [note, ...rest] = given
      const fresh = rest.filter((entry) => last === undefined || (entry.date ?? '') > last)
      if (note === undefined || fresh.length === 0) continue
      entries.push(note, ...fresh)
      lasts.set(key, fresh.reduce((latest, entry) => ((entry.date ?? '') > latest ? entry.date! : latest), last ?? ''))
    }
    if (entries.length === 0) return 0
    const ids = this.chat.logImported(entries)
    for (const [key, last] of lasts) this.done[key] = last
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.done))
    renameSync(`${this.path}.tmp`, this.path)
    return ids.length
  }
}

const counted = (n: number): string => n.toLocaleString('en-US')

const USAGE = 'Usage: totalrecall import [since <YYYY-MM-DD>] [tools] [<Claude or ChatGPT export .zip or conversations.json>…] [go]'

export const runImport = async (args: readonly string[], post: (path: string, body: object) => Promise<unknown>, print: (line: string) => void, atWork: number): Promise<void> => {
  const sinceAt = args.indexOf('since')
  const since = sinceAt === -1 ? '' : (args[sinceAt + 1] ?? '')
  if (sinceAt !== -1 && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`since takes a day, such as 2026-06-01. ${USAGE}`)
  const want: Want = { since, tools: args.includes('tools') }
  const isGo = args.includes('go')
  const exports = args.filter((arg, k) => !['go', 'tools', 'since'].includes(arg) && args[k - 1] !== 'since')
  const state = (await post('/imported', {})) as ImportState
  const logged = new Set(state.logged.map((session) => `claude-code:${session}`))
  const found = sources(exports)
  const apps = new Map<string, { sessions: number; messages: number }>()
  const wanted: { source: Source; start: string }[] = []
  const sizes: number[] = []
  let skipped = 0
  found.forEach((source, k) => {
    if (process.stderr.isTTY) process.stderr.write(`\rReading session ${counted(k + 1)} of ${counted(found.length)}…`)
    if (logged.has(source.key)) {
      skipped += 1
      return
    }
    const entries = picked(source, want, state.done[source.key])
    if (entries.length === 0) return
    const app = apps.get(source.app) ?? { sessions: 0, messages: 0 }
    apps.set(source.app, { sessions: app.sessions + 1, messages: app.messages + entries.length - 1 })
    wanted.push({ source, start: entries[0]!.date ?? '' })
    sizes.push(...entries.flatMap(sizeOf))
  })
  if (process.stderr.isTTY) process.stderr.write('\n')
  for (const [app, { sessions, messages }] of apps) print(`${app}: ${counted(sessions)} sessions, ${counted(messages)} new messages`)
  if (skipped > 0) print(`Left out: ${counted(skipped)} sessions total recall logged as they ran.`)
  if (state.waiting > 0) print(`${counted(state.waiting)} messages imported before still wait for their summaries.`)
  if (wanted.length === 0) {
    print('Nothing new to import.')
    return
  }
  print(`About ${counted(summaries(state.total, sizes))} summaries for the compactor, ${atWork} at once. Turns never wait on them.`)
  if (!isGo) {
    print('Run the same command with go to import them.')
    return
  }
  wanted.sort((a, b) => a.start.localeCompare(b.start))
  let part: Imported[] = []
  let bytes = 0
  let sent = 0
  const send = async (): Promise<void> => {
    if (part.length === 0) return
    sent += ((await post('/import', { sessions: part })) as { messages: number }).messages
    part = []
    bytes = 0
    if (process.stderr.isTTY) process.stderr.write(`\rImported ${counted(sent)} messages…`)
  }
  for (const { source } of wanted) {
    const entries = picked(source, want, state.done[source.key])
    part.push({ key: source.key, entries })
    bytes += Buffer.byteLength(JSON.stringify(entries))
    if (bytes >= PART) await send()
  }
  await send()
  if (process.stderr.isTTY) process.stderr.write('\n')
  print(`Imported ${counted(sent)} messages. Their summaries run in the background.`)
}
