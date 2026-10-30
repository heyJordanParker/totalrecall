export type Line = { readonly l: number; readonly i: number }

export const first = ({ l, i }: Line): number => i * 2 ** l
export const count = ({ l }: Line): number => 2 ** l
export const end = (line: Line): number => first(line) + count(line)
export const parent = ({ l, i }: Line): Line => ({ l: l + 1, i: Math.floor(i / 2) })
export const children = ({ l, i }: Line): readonly [Line, Line] => [
  { l: l - 1, i: 2 * i },
  { l: l - 1, i: 2 * i + 1 },
]
export const name = (line: Line): string => `${first(line)}+${count(line)}`
export const slot = ({ l, i }: Line): number => (2 * i + 1) * 2 ** l - 1

export const lineOf = (at: number): Line => {
  let l = 0
  while ((at + 1) % 2 ** (l + 1) === 0) l += 1
  return { l, i: ((at + 1) / 2 ** l - 1) / 2 }
}

const UNBUILT = '(not summarized yet: zoom it)'

export type Lines = {
  text(line: Line): string | undefined
  size(line: Line): number
  isBuilt(line: Line): boolean
}

export const flat = (text: string): string => (text.includes('\n') ? text.replace(/\s*\n\s*/g, ' ') : text)

export const render = (line: Line, lines: Pick<Lines, 'text'>): string => `${name(line)}|${flat(lines.text(line) ?? UNBUILT)}`

export type Sawtooth = { readonly high: number }

export const CHAT: Sawtooth = { high: 128_000 }
export const COMPACTION: Sawtooth = { high: 32_000 }

export type ViewState = { lines: Line[]; size: number; isMerging: boolean }

export const viewEnd = ({ lines }: ViewState): number => (lines.length === 0 ? 0 : end(lines.at(-1)!))

const covering = (lines: readonly Line[], id: number): number => {
  let low = 0
  let high = lines.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (end(lines[middle]!) <= id) low = middle + 1
    else high = middle
  }
  return low
}

export const reach = (view: ViewState, to: number, lines: Lines): void => {
  for (const line of view.lines.splice(covering(view.lines, to))) view.size -= lines.size(line)
  for (let id = viewEnd(view); id < to; id += 1) {
    view.lines.push({ l: 0, i: id })
    view.size += lines.size({ l: 0, i: id })
  }
}

type Pair = { readonly due: number; readonly k: number; readonly a: Line; readonly b: Line }

const isAbove = (x: Pair, y: Pair): boolean => x.due > y.due || (x.due === y.due && x.k < y.k)

export const merge = (view: ViewState, lines: Lines, isEnough: (size: number, length: number) => boolean): { lines: Line[]; size: number } => {
  const total = viewEnd(view)
  const at: (Line | undefined)[] = [...view.lines]
  const next = at.map((_, k) => k + 1)
  const previous = at.map((_, k) => k - 1)
  const heap: Pair[] = []
  const swap = (x: number, y: number): void => {
    ;[heap[x], heap[y]] = [heap[y]!, heap[x]!]
  }
  const offer = (k: number): void => {
    const a = at[k]
    const b = at[next[k]!]
    if (k < 0 || a === undefined || b === undefined || a.i % 2 !== 0 || b.l !== a.l || b.i !== a.i + 1 || !lines.isBuilt(parent(a))) return
    heap.push({ due: (total + 1) / 2 ** a.l - a.i, k, a, b })
    for (let x = heap.length - 1; x > 0 && isAbove(heap[x]!, heap[(x - 1) >> 1]!); x = (x - 1) >> 1) swap(x, (x - 1) >> 1)
  }
  const take = (): Pair => {
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      for (let x = 0; ; ) {
        let best = x
        for (const child of [2 * x + 1, 2 * x + 2]) if (child < heap.length && isAbove(heap[child]!, heap[best]!)) best = child
        if (best === x) break
        swap(x, best)
        x = best
      }
    }
    return top
  }
  let size = view.size
  let length = at.length
  at.forEach((_, k) => offer(k))
  while (heap.length > 0 && !isEnough(size, length)) {
    const { k, a, b } = take()
    const j = next[k]!
    if (at[k] !== a || at[j] !== b) continue
    const up = parent(a)
    size += lines.size(up) - lines.size(a) - lines.size(b)
    length -= 1
    at[k] = up
    at[j] = undefined
    next[k] = next[j]!
    if (next[j]! < at.length) previous[next[j]!] = k
    offer(previous[k]!)
    offer(k)
  }
  return { lines: at.filter((line) => line !== undefined), size }
}

export const fit = (view: ViewState, { high }: Sawtooth, lines: Lines, isAtMessage: boolean): boolean => {
  if (view.size <= high && !(isAtMessage && view.isMerging)) return false
  const length = view.lines.length
  const isMerging = view.isMerging
  const merged = merge(view, lines, (size) => size <= high / 2)
  if (isAtMessage || merged.size <= Math.max(high / 2, view.size - high)) {
    view.lines = merged.lines
    view.size = merged.size
  }
  view.isMerging = view.size > high / 2
  return view.lines.length !== length || view.isMerging !== isMerging
}
