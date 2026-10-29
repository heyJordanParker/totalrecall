import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class Sessions {
  private readonly seen = new Map<string, string[]>()

  constructor(private readonly folder: string) {
    mkdirSync(folder, { recursive: true })
  }

  private path(history: string): string {
    return join(this.folder, `${encodeURIComponent(history)}.keys`)
  }

  keys(history: string): string[] {
    const known = this.seen.get(history)
    if (known !== undefined) return known
    const path = this.path(history)
    const keys = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line !== '') : []
    this.seen.set(history, keys)
    return keys
  }

  keep(history: string, keys: readonly string[], from: number): void {
    const kept = this.keys(history)
    if (from === kept.length) {
      if (keys.length === 0) return
      kept.push(...keys)
      appendFileSync(this.path(history), keys.map((key) => `${key}\n`).join(''))
      return
    }
    kept.splice(from, kept.length - from, ...keys)
    writeFileSync(this.path(history), kept.map((key) => `${key}\n`).join(''))
  }
}
