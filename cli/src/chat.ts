import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { append, children, CHAT, COMPACTION, key, parent, shrink, type Line, type Lines, type ViewState } from './view.ts'

export type Kind = 'user' | 'claude' | 'tool' | 'echo' | 'work' | 'note'
export type Image = { readonly media_type: string; readonly data: string }
export type Message = {
  readonly i: number
  readonly kind: Kind
  readonly text: string
  readonly size: number
  readonly date: string
  readonly images?: readonly Image[]
}

export const LINE_BYTES = 512
export const MESSAGE_CHARACTERS = 30_000
const NAMES = 'names.json'

type Place = { readonly file: string; readonly offset: number; readonly length: number; readonly kind: Kind; readonly date: string }
type Node = { readonly text: string; readonly size: number }
type SavedView = { lines: [number, number][]; isMerging: boolean }

const bytes = (text: string): number => Buffer.byteLength(text)
const day = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

class DayFiles {
  private open: { name: string; fd: number; size: number } | undefined

  constructor(private readonly folder: string) {
    mkdirSync(folder, { recursive: true })
  }

  write(record: object, now: Date): { file: string; offset: number; length: number } {
    const name = `${day(now)}.jsonl`
    if (this.open?.name !== name) {
      if (this.open !== undefined) closeSync(this.open.fd)
      const fd = openSync(join(this.folder, name), 'a')
      this.open = { name, fd, size: statSync(join(this.folder, name)).size }
    }
    const line = Buffer.from(`${JSON.stringify(record)}\n`)
    writeSync(this.open.fd, line)
    fsyncSync(this.open.fd)
    const offset = this.open.size
    this.open.size += line.length
    return { file: join(this.folder, name), offset, length: line.length - 1 }
  }

  *read(): Generator<{ record: unknown; file: string; offset: number; length: number }> {
    for (const name of readdirSync(this.folder).filter((entry) => entry.endsWith('.jsonl')).sort()) {
      const file = join(this.folder, name)
      const content = readFileSync(file)
      let offset = 0
      while (offset < content.length) {
        const next = content.indexOf(10, offset)
        const stop = next === -1 ? content.length : next
        if (stop > offset) yield { record: JSON.parse(content.subarray(offset, stop).toString()), file, offset, length: stop - offset }
        offset = stop + 1
      }
    }
  }
}

const saveJson = (path: string, value: unknown): void => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value))
  renameSync(`${path}.tmp`, path)
}

const loadView = (path: string): ViewState | undefined => {
  if (!existsSync(path)) return undefined
  const saved = JSON.parse(readFileSync(path, 'utf8')) as SavedView
  return { lines: saved.lines.map(([l, i]) => ({ l, i })), isMerging: saved.isMerging }
}

const saveView = (path: string, view: ViewState): void =>
  saveJson(path, { lines: view.lines.map(({ l, i }) => [l, i]), isMerging: view.isMerging } satisfies SavedView)

export type ChatEvents = {
  ready(line: Line): void
}

export class Chat implements Lines {
  readonly view: ViewState
  readonly compactionView: ViewState
  private readonly places: Place[] = []
  private readonly nodes = new Map<string, Node>()
  private readonly main: DayFiles
  private readonly tree: DayFiles
  private readonly agents: string
  private readonly names: Map<string, string>
  private listener: ChatEvents | undefined

  constructor(private readonly folder: string) {
    this.main = new DayFiles(join(folder, 'main'))
    this.tree = new DayFiles(join(folder, 'tree'))
    this.agents = join(folder, 'agents')
    mkdirSync(this.agents, { recursive: true })
    const names = join(this.agents, NAMES)
    this.names = new Map(existsSync(names) ? Object.entries(JSON.parse(readFileSync(names, 'utf8')) as Record<string, string>) : [])
    for (const { record, file, offset, length } of this.main.read()) {
      const message = record as Message
      this.places[message.i] = { file, offset, length, kind: message.kind, date: message.date }
    }
    for (const { record } of this.tree.read()) {
      const { l, i, text, size } = record as Line & Node
      this.nodes.set(key({ l, i }), { text, size })
    }
    this.view = loadView(join(folder, 'view.json')) ?? { lines: [], isMerging: false }
    this.compactionView = loadView(join(folder, 'compaction-view.json')) ?? { lines: [], isMerging: false }
  }

  get total(): number {
    return this.places.length
  }

  listen(listener: ChatEvents): void {
    this.listener = listener
    for (let id = 0; id < this.total; id += 1) {
      if (!this.nodes.has(key({ l: 0, i: id }))) listener.ready({ l: 0, i: id })
    }
    for (const built of [...this.nodes.keys()]) {
      const [l, i] = built.split(':').map(Number) as [number, number]
      if (i % 2 === 0) this.offerParent({ l, i })
    }
  }

  text(line: Line): string | undefined {
    return this.nodes.get(key(line))?.text
  }

  isBuilt(line: Line): boolean {
    return this.nodes.has(key(line))
  }

  message(id: number): Message {
    const place = this.places[id]
    if (place === undefined) throw new Error(`There is no message ${id}.`)
    const content = Buffer.alloc(place.length)
    const fd = openSync(place.file, 'r')
    try {
      readSync(fd, content, 0, place.length, place.offset)
    } finally {
      closeSync(fd)
    }
    return JSON.parse(content.toString()) as Message
  }

  date(id: number): string {
    const place = this.places[id]
    if (place === undefined) throw new Error(`There is no message ${id}.`)
    return place.date
  }

  log(kind: Kind, text: string, images: readonly Image[] = [], now = new Date()): number[] {
    const ids: number[] = []
    for (let start = 0; start === 0 || start < text.length; start += MESSAGE_CHARACTERS) {
      ids.push(this.append(kind, text.slice(start, start + MESSAGE_CHARACTERS), start === 0 ? images : [], now))
    }
    return ids
  }

  private append(kind: Kind, text: string, images: readonly Image[], now: Date): number {
    const i = this.total
    const date = now.toISOString()
    const record: Message = { i, kind, text, size: bytes(text), date, ...(images.length > 0 ? { images } : {}) }
    const place = this.main.write(record, now)
    this.places[i] = { ...place, kind, date }
    const line = { l: 0, i }
    const own = `${kind}: ${text}`
    if (bytes(own) <= LINE_BYTES && images.length === 0) this.build(line, own, now)
    else this.listener?.ready(line)
    if (append(this.view, i, this, CHAT)) {
      this.compactionView.lines = [...this.view.lines]
      this.compactionView.isMerging = !shrink(this.compactionView.lines, this.total, this, COMPACTION.low)
    } else {
      append(this.compactionView, i, this, COMPACTION)
    }
    saveView(join(this.folder, 'view.json'), this.view)
    saveView(join(this.folder, 'compaction-view.json'), this.compactionView)
    return i
  }

  build(line: Line, text: string, now = new Date()): void {
    if (this.nodes.has(key(line))) return
    const size = bytes(text)
    this.tree.write({ l: line.l, i: line.i, text, size }, now)
    this.nodes.set(key(line), { text, size })
    this.offerParent(line, now)
  }

  private offerParent(line: Line, now = new Date()): void {
    const above = parent(line)
    if (this.nodes.has(key(above))) return
    const [a, b] = children(above)
    const left = this.nodes.get(key(a))
    const right = this.nodes.get(key(b))
    if (left === undefined || right === undefined) return
    if (left.size + 1 + right.size <= LINE_BYTES) this.build(above, `${left.text}\n${right.text}`, now)
    else this.listener?.ready(above)
  }

  logAgent(id: string, kind: Kind, text: string, images: readonly Image[] = [], now = new Date()): void {
    const record = { kind, text, date: now.toISOString(), ...(images.length > 0 ? { images } : {}) }
    const fd = openSync(join(this.agents, `${encodeURIComponent(id)}.jsonl`), 'a')
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  nameAgent(id: string, task: string): string {
    const known = this.names.get(id)
    if (known !== undefined) return known
    const taken = new Set(this.names.values())
    let name = task
    for (let count = 2; taken.has(name); count += 1) name = `${task} ${count}`
    this.names.set(id, name)
    saveJson(join(this.agents, NAMES), Object.fromEntries(this.names))
    return name
  }

  agentName(id: string): string | undefined {
    return this.names.get(id)
  }

  agent(name: string): { text: string; images: Image[] } | undefined {
    const id = [...this.names].find(([, each]) => each === name)?.[0] ?? name
    const path = join(this.agents, `${encodeURIComponent(id)}.jsonl`)
    if (!existsSync(path)) return undefined
    const records = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { kind: Kind; text: string; images?: Image[] })
    return { text: records.map(({ kind, text }) => `${kind}: ${text}`).join('\n\n'), images: records.flatMap((record) => record.images ?? []) }
  }
}
