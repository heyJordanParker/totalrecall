import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { pages } from './clip.ts'
import { Log } from './log.ts'
import { CHAT, children, COMPACTION, end, fit, flat, lineOf, parent, reach, render, slot, viewEnd, type Line, type Lines, type ViewState } from './view.ts'

export type Kind = 'user' | 'claude' | 'tool' | 'echo' | 'work' | 'note'
export type Image = { readonly media_type: string; readonly data: string }
export type Message = {
  readonly i: number
  readonly kind: Kind
  readonly text: string
  readonly size: number
  readonly date: string
  readonly images?: readonly Image[]
  readonly imported?: true
}
export type Entry = { readonly kind: Kind; readonly text: string; readonly date?: string; readonly images?: readonly Image[] }

export const LINE_BYTES = 512
const IMPORTED = 1
const MOST_EXTRA = 65_535
const NAMES = 'names.json'

export const shownKind = ({ kind, imported }: { readonly kind: Kind; readonly imported?: boolean }): string =>
  imported === true && (kind === 'claude' || kind === 'tool') ? 'ai' : kind

export const shown = (message: { readonly kind: Kind; readonly text: string; readonly imported?: boolean }): string => `${shownKind(message)}: ${message.text}`

type Node = { readonly l: number; readonly i: number; readonly text: string; readonly size: number }
type SavedView = { lines: [number, number][]; isMerging: boolean }

const bytes = (text: string): number => Buffer.byteLength(text)

const saveJson = (path: string, value: unknown): void => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value))
  renameSync(`${path}.tmp`, path)
}

const at = (sorted: readonly number[], id: number): number => {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle]! < id) low = middle + 1
    else high = middle
  }
  return low
}

export type ChatEvents = {
  ready(line: Line): void
  changed(): void
}

export class Chat implements Lines {
  readonly view: ViewState
  readonly compactionView: ViewState
  private readonly main: Log
  private readonly tree: Log
  private readonly unbuilt: [number[], number[]] = [[], []]
  private readonly agents: string
  private readonly names: Map<string, string>
  private batch: Map<number, Node> | undefined
  private count = 0
  private listener: ChatEvents | undefined

  constructor(private readonly folder: string) {
    this.main = new Log(join(folder, 'main'), join(folder, 'main.index'), (record) =>
      typeof record['i'] === 'number' ? { slot: record['i'], extra: record['imported'] === true ? IMPORTED : 0 } : undefined,
    )
    this.tree = new Log(join(folder, 'tree'), join(folder, 'tree.index'), (record) =>
      typeof record['l'] === 'number' && typeof record['i'] === 'number' && typeof record['text'] === 'string'
        ? { slot: slot({ l: record['l'], i: record['i'] }), extra: Math.min(bytes(record['text']), MOST_EXTRA) }
        : undefined,
    )
    while (this.main.has(this.count)) this.count += 1
    for (let i = 0; i < this.count; i += 1) if (!this.tree.has(slot({ l: 0, i }))) this.unbuilt[this.sideOf(i)].push(i)
    this.agents = join(folder, 'agents')
    mkdirSync(this.agents, { recursive: true })
    const names = join(this.agents, NAMES)
    this.names = new Map(existsSync(names) ? Object.entries(JSON.parse(readFileSync(names, 'utf8')) as Record<string, string>) : [])
    this.view = this.loadView('view.json')
    this.compactionView = this.loadView('compaction-view.json')
    reach(this.view, this.count, this)
    reach(this.compactionView, this.seenEnd(), this)
  }

  get total(): number {
    return this.count
  }

  listen(listener: ChatEvents): void {
    this.listener = listener
    for (const side of this.unbuilt) for (const i of side) listener.ready({ l: 0, i })
    for (let built = 0; built < this.tree.length; built += 1) {
      const line = lineOf(built)
      if (line.i % 2 === 0 && this.tree.has(built)) this.offerParent(line)
    }
  }

  text(line: Line): string | undefined {
    return this.batch?.get(slot(line))?.text ?? (this.tree.read(slot(line))?.['text'] as string | undefined)
  }

  size(line: Line): number {
    return this.batch?.get(slot(line))?.size ?? this.tree.entry(slot(line))?.extra ?? 0
  }

  isBuilt(line: Line): boolean {
    return this.batch?.has(slot(line)) === true || this.tree.has(slot(line))
  }

  message(id: number): Message {
    const record = this.main.read(id)
    if (record === undefined || id >= this.count) throw new Error(`There is no message ${id}.`)
    return record as Message
  }

  date(id: number): string {
    return this.message(id).date
  }

  isImported(id: number): boolean {
    return ((this.main.entry(id)?.extra ?? 0) & IMPORTED) !== 0
  }

  sideOf(id: number): 0 | 1 {
    return this.isImported(id) ? 1 : 0
  }

  lineSide(line: Line): 0 | 1 {
    return this.sideOf(end(line) - 1)
  }

  unbuiltAt(side: 0 | 1, k: number): number {
    return this.unbuilt[side][k] ?? this.count
  }

  hasUnbuilt(side: 0 | 1, from: number, to: number): boolean {
    const found = this.unbuilt[side][at(this.unbuilt[side], from)]
    return found !== undefined && found < to
  }

  unbuiltCount(side: 0 | 1): number {
    return this.unbuilt[side].length
  }

  rendered(): string[] {
    const isImportShown = this.view.size <= CHAT.high
    return this.view.lines.filter((line) => this.lineSide(line) === 0 || (isImportShown && this.isBuilt(line))).map((line) => render(line, this))
  }

  source(line: Line): string {
    if (line.l === 0) return shown(this.message(line.i))
    const [a, b] = children(line)
    return `${flat(this.text(a)!)}\n${flat(this.text(b)!)}`
  }

  log(kind: Kind, text: string, images: readonly Image[] = [], now = new Date()): number[] {
    return this.append([{ kind, text, images }], false, now)
  }

  logImported(entries: readonly Entry[], now = new Date()): number[] {
    return this.append(entries, true, now)
  }

  private append(entries: readonly Entry[], isImported: boolean, now: Date): number[] {
    const records: Message[] = []
    for (const entry of entries) {
      pages(entry.text).forEach((text, k) => {
        const images = k === 0 ? (entry.images ?? []) : []
        records.push({
          i: this.count + records.length,
          kind: entry.kind,
          text,
          size: bytes(text),
          date: entry.date ?? now.toISOString(),
          ...(images.length > 0 ? { images } : {}),
          ...(isImported ? { imported: true as const } : {}),
        })
      })
    }
    this.main.write(records.map((record) => ({ record, slot: record.i, extra: isImported ? IMPORTED : 0 })), now)
    this.count += records.length
    this.batch = new Map()
    for (const record of records) {
      const own = shown(record)
      if (bytes(own) <= LINE_BYTES && record.images === undefined) {
        this.build({ l: 0, i: record.i }, own, now)
      } else {
        this.unbuilt[this.sideOf(record.i)].push(record.i)
        this.listener?.ready({ l: 0, i: record.i })
      }
    }
    const built = [...this.batch.values()]
    this.batch = undefined
    this.tree.write(built.map((node) => ({ record: node, slot: slot(node), extra: Math.min(node.size, MOST_EXTRA) })), now)
    reach(this.view, this.count, this)
    reach(this.compactionView, this.seenEnd(), this)
    fit(this.view, CHAT, this, true)
    fit(this.compactionView, COMPACTION, this, true)
    this.saveView('view.json', this.view)
    this.saveView('compaction-view.json', this.compactionView)
    this.listener?.changed()
    return records.map((record) => record.i)
  }

  build(line: Line, text: string, now = new Date()): void {
    if (this.isBuilt(line)) return
    const node: Node = { l: line.l, i: line.i, text, size: bytes(text) }
    if (this.batch !== undefined) this.batch.set(slot(line), node)
    else this.tree.write([{ record: node, slot: slot(line), extra: Math.min(node.size, MOST_EXTRA) }], now)
    if (line.l === 0) {
      const side = this.unbuilt[this.sideOf(line.i)]
      const found = at(side, line.i)
      if (side[found] === line.i) side.splice(found, 1)
      for (const view of [this.view, this.compactionView]) if (line.i < viewEnd(view)) view.size += node.size
    }
    this.offerParent(line, now)
    if (this.batch !== undefined) return
    reach(this.compactionView, this.seenEnd(), this)
    fit(this.view, CHAT, this, false)
    fit(this.compactionView, COMPACTION, this, false)
    this.listener?.changed()
  }

  private seenEnd(): number {
    return Math.min(this.count, this.unbuiltAt(0, 0), this.unbuiltAt(1, 0))
  }

  private offerParent(line: Line, now = new Date()): void {
    const above = parent(line)
    if (this.isBuilt(above)) return
    const [a, b] = children(above)
    if (!this.isBuilt(a) || !this.isBuilt(b)) return
    const source = this.source(above)
    if (bytes(source) <= LINE_BYTES) this.build(above, source, now)
    else this.listener?.ready(above)
  }

  private loadView(file: string): ViewState {
    const path = join(this.folder, file)
    const saved = ((): SavedView | undefined => {
      try {
        return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SavedView) : undefined
      } catch {
        return undefined
      }
    })()
    const lines = (saved?.lines ?? []).map(([l, i]) => ({ l, i }))
    const isWhole = lines.every((line, k) => (k === 0 ? line.i === 0 : end(lines[k - 1]!) === line.i * 2 ** line.l) && (line.l === 0 || this.isBuilt(line)))
    const kept = isWhole ? lines : []
    return { lines: kept, size: kept.reduce((total, line) => total + this.size(line), 0), isMerging: isWhole && saved?.isMerging === true }
  }

  private saveView(file: string, view: ViewState): void {
    saveJson(join(this.folder, file), { lines: view.lines.map(({ l, i }) => [l, i]), isMerging: view.isMerging } satisfies SavedView)
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
      .flatMap((line) => {
        try {
          return line === '' ? [] : [JSON.parse(line) as { kind: Kind; text: string; images?: Image[] }]
        } catch {
          return []
        }
      })
    return { text: records.map(({ kind, text }) => `${kind}: ${text}`).join('\n\n'), images: records.flatMap((record) => record.images ?? []) }
  }
}
