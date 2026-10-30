import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const ENTRY = 16
const DAY_MS = 86_400_000
const READERS = 8

export type Entry = { readonly day: number; readonly offset: number; readonly length: number; readonly extra: number }
export type Placed = { readonly slot: number; readonly extra: number }

const dayOf = (now: Date): number => Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS
const fileOf = (day: number): string => `${new Date(day * DAY_MS).toISOString().slice(0, 10)}.jsonl`
const dayOfFile = (file: string): number => Date.parse(`${file.slice(0, 10)}T00:00:00Z`) / DAY_MS

export class Log {
  private index: Buffer
  private slots: number
  private readonly indexFd: number
  private writer: { day: number; fd: number; size: number } | undefined
  private readonly readers = new Map<number, number>()

  constructor(
    private readonly folder: string,
    indexPath: string,
    placeOf: (record: Record<string, unknown>) => Placed | undefined,
  ) {
    mkdirSync(folder, { recursive: true })
    const saved = existsSync(indexPath) ? readFileSync(indexPath) : Buffer.alloc(0)
    this.slots = Math.floor(saved.length / ENTRY)
    this.index = Buffer.alloc(Math.max(ENTRY * 1024, saved.length * 2))
    saved.copy(this.index, 0, 0, this.slots * ENTRY)
    this.indexFd = openSync(indexPath, existsSync(indexPath) ? 'r+' : 'w+')
    this.recover(placeOf)
  }

  get length(): number {
    return this.slots
  }

  entry(slot: number): Entry | undefined {
    if (slot < 0 || slot >= this.slots) return undefined
    const at = slot * ENTRY
    const length = this.index.readUInt32LE(at + 8)
    if (length === 0) return undefined
    return { offset: Number(this.index.readBigUInt64LE(at)), length, day: this.index.readUInt16LE(at + 12), extra: this.index.readUInt16LE(at + 14) }
  }

  has(slot: number): boolean {
    return this.entry(slot) !== undefined
  }

  read(slot: number): Record<string, unknown> | undefined {
    const entry = this.entry(slot)
    if (entry === undefined) return undefined
    const content = Buffer.alloc(entry.length)
    readSync(this.reader(entry.day), content, 0, entry.length, entry.offset)
    return JSON.parse(content.toString()) as Record<string, unknown>
  }

  write(records: readonly { record: object; slot: number; extra: number }[], now: Date): void {
    if (records.length === 0) return
    const day = dayOf(now)
    if (this.writer?.day !== day) {
      if (this.writer !== undefined) closeSync(this.writer.fd)
      const path = join(this.folder, fileOf(day))
      const fd = openSync(path, 'a')
      this.writer = { day, fd, size: statSync(path).size }
    }
    const lines = records.map(({ record }) => Buffer.from(`${JSON.stringify(record)}\n`))
    writeSync(this.writer.fd, Buffer.concat(lines))
    fsyncSync(this.writer.fd)
    let offset = this.writer.size
    records.forEach(({ slot, extra }, k) => {
      this.place(slot, { day, offset, length: lines[k]!.length - 1, extra })
      offset += lines[k]!.length
    })
    this.writer.size = offset
  }

  private place(slot: number, entry: Entry): void {
    const needed = (slot + 1) * ENTRY
    if (needed > this.index.length) {
      const grown = Buffer.alloc(Math.max(needed, this.index.length * 2))
      this.index.copy(grown)
      this.index = grown
    }
    const at = slot * ENTRY
    this.index.writeBigUInt64LE(BigInt(entry.offset), at)
    this.index.writeUInt32LE(entry.length, at + 8)
    this.index.writeUInt16LE(entry.day, at + 12)
    this.index.writeUInt16LE(entry.extra, at + 14)
    writeSync(this.indexFd, this.index, at, ENTRY, at)
    this.slots = Math.max(this.slots, slot + 1)
  }

  private reader(day: number): number {
    const open = this.readers.get(day)
    if (open !== undefined) return open
    if (this.readers.size >= READERS) {
      const [oldest, fd] = this.readers.entries().next().value!
      closeSync(fd)
      this.readers.delete(oldest)
    }
    const fd = openSync(join(this.folder, fileOf(day)), 'r')
    this.readers.set(day, fd)
    return fd
  }

  private recover(placeOf: (record: Record<string, unknown>) => Placed | undefined): void {
    const ends = new Map<number, number>()
    for (let slot = 0; slot < this.slots; slot += 1) {
      const entry = this.entry(slot)
      if (entry !== undefined) ends.set(entry.day, Math.max(ends.get(entry.day) ?? 0, entry.offset + entry.length + 1))
    }
    const last = Math.max(-1, ...ends.keys())
    for (const file of readdirSync(this.folder).filter((name) => name.endsWith('.jsonl')).sort()) {
      const day = dayOfFile(file)
      if (day < last) continue
      const path = join(this.folder, file)
      const start = ends.get(day) ?? 0
      const content = Buffer.alloc(Math.max(0, statSync(path).size - start))
      const fd = openSync(path, 'r')
      readSync(fd, content, 0, content.length, start)
      closeSync(fd)
      let at = 0
      while (at < content.length) {
        const newline = content.indexOf(10, at)
        if (newline === -1) {
          const appending = openSync(path, 'a')
          writeSync(appending, '\n')
          closeSync(appending)
          break
        }
        const placed = this.parsed(content.subarray(at, newline), placeOf)
        if (placed !== undefined) this.place(placed.slot, { day, offset: start + at, length: newline - at, extra: placed.extra })
        at = newline + 1
      }
    }
  }

  private parsed(line: Buffer, placeOf: (record: Record<string, unknown>) => Placed | undefined): Placed | undefined {
    try {
      return placeOf(JSON.parse(line.toString()) as Record<string, unknown>)
    } catch {
      return undefined
    }
  }
}
