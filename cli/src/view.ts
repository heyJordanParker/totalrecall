export type Line = { readonly l: number; readonly i: number }

export const first = ({ l, i }: Line): number => i * 2 ** l
export const count = ({ l }: Line): number => 2 ** l
export const end = (line: Line): number => first(line) + count(line)
export const parent = ({ l, i }: Line): Line => ({ l: l + 1, i: Math.floor(i / 2) })
export const children = ({ l, i }: Line): readonly [Line, Line] => [
  { l: l - 1, i: 2 * i },
  { l: l - 1, i: 2 * i + 1 },
]
export const key = ({ l, i }: Line): string => `${l}:${i}`
export const name = (line: Line): string => `${first(line)}+${count(line)}`

export const UNBUILT = '(not summarized yet: zoom it)'

export type Lines = {
  text(line: Line): string | undefined
}

export const render = (line: Line, lines: Lines): string =>
  `${name(line)}|${(lines.text(line) ?? UNBUILT).replaceAll('\n', ' ')}`

const bytes = (text: string): number => Buffer.byteLength(text)

export const size = (view: readonly Line[], lines: Lines): number =>
  view.reduce((total, line) => total + bytes(render(line, lines)) + 1, 0)

const isPair = (a: Line, b: Line): boolean => a.l === b.l && a.i % 2 === 0 && b.i === a.i + 1

const mostDue = (view: readonly Line[], total: number, lines: Lines): number | undefined => {
  let best: number | undefined
  let bestDue = -Infinity
  for (let k = 0; k + 1 < view.length; k += 1) {
    const a = view[k]!
    const b = view[k + 1]!
    if (!isPair(a, b) || lines.text(parent(a)) === undefined) continue
    const due = (total - (end(b) - 1)) / count(a)
    if (due > bestDue) {
      best = k
      bestDue = due
    }
  }
  return best
}

export const mergeOnce = (view: Line[], total: number, lines: Lines): number | undefined => {
  const k = mostDue(view, total, lines)
  if (k === undefined) return undefined
  const a = view[k]!
  const b = view[k + 1]!
  const merged = parent(a)
  view.splice(k, 2, merged)
  return bytes(render(merged, lines)) - bytes(render(a, lines)) - bytes(render(b, lines)) - 1
}

export const shrink = (view: Line[], total: number, lines: Lines, target: number): boolean => {
  let bytesNow = size(view, lines)
  while (bytesNow > target) {
    const change = mergeOnce(view, total, lines)
    if (change === undefined) return false
    bytesNow += change
  }
  return true
}

export type Sawtooth = { readonly low: number; readonly high: number }

export const CHAT: Sawtooth = { low: 64_000, high: 128_000 }
export const COMPACTION: Sawtooth = { low: 16_000, high: 32_000 }

export type ViewState = { lines: Line[]; isMerging: boolean }

export const append = (view: ViewState, id: number, lines: Lines, sawtooth: Sawtooth): boolean => {
  view.lines.push({ l: 0, i: id })
  if (!view.isMerging && size(view.lines, lines) <= sawtooth.high) return false
  const before = view.lines.length
  view.isMerging = !shrink(view.lines, id + 1, lines, sawtooth.low)
  return view.lines.length !== before
}
