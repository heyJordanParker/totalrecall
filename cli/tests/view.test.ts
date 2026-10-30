import { expect, test } from 'bun:test'
import { end, first, fit, lineOf, merge, name, reach, slot, type Line, type Lines, type ViewState } from '../src/view.ts'

type States = { keep: number; life: number; state: number; older: States | null } | null

const push = (newState: number, states: States): States => {
  if (states === null) return { keep: 0, life: 0, state: newState, older: null }
  const { keep, life, state, older } = states
  if (keep === 0) return { keep: 1, life, state, older }
  if (life > 0) return { keep: 0, life: 0, state: newState, older: { keep: 0, life: life - 1, state, older } }
  return { keep: 0, life, state: newState, older: push(state, older) }
}

const starts = (states: States): number[] => {
  const found: number[] = []
  for (let entry = states; entry !== null; entry = entry.older) found.push(entry.state)
  return found.reverse()
}

const every = (text: string, isBuilt: (line: Line) => boolean = () => true): Lines => ({
  text: (line) => (isBuilt(line) ? text : undefined),
  size: (line) => (isBuilt(line) ? Buffer.byteLength(text) : 0),
  isBuilt,
})

const empty = (): ViewState => ({ lines: [], size: 0, isMerging: false })

test('merging the most due pairs makes exactly the merges the gist’s reference makes', () => {
  let states: States = null
  const view = empty()
  const lines = every('x')
  for (let t = 0; t <= 20_000; t += 1) {
    states = push(t, states)
    reach(view, t + 1, lines)
    const budget = starts(states).length
    const merged = merge(view, lines, (_, length) => length <= budget)
    view.lines = merged.lines
    view.size = merged.size
    expect(view.lines.map(first)).toEqual(starts(states))
  }
})

test('the view covers every message once, oldest first', () => {
  const view = empty()
  const lines = every('a summary of about forty bytes, give or take')
  for (let id = 0; id < 20_000; id += 1) {
    reach(view, id + 1, lines)
    fit(view, { high: 8_000 }, lines, true)
  }
  let next = 0
  for (const line of view.lines) {
    expect(first(line)).toBe(next)
    next = end(line)
  }
  expect(next).toBe(20_000)
})

test('the view grows one line per message, then drops back to half at once', () => {
  const view = empty()
  const lines = every('x'.repeat(100))
  const sizes: number[] = []
  for (let id = 0; id < 3_000; id += 1) {
    reach(view, id + 1, lines)
    fit(view, { high: 8_000 }, lines, true)
    sizes.push(view.size)
  }
  const drops = sizes.filter((size, k) => k > 0 && size < sizes[k - 1]!)
  expect(drops.length).toBeGreaterThan(5)
  expect(Math.max(...sizes)).toBeLessThanOrEqual(8_000)
  expect(Math.min(...sizes.slice(100))).toBeGreaterThan(3_000)
})

test('a pair merges only once its parent is built, and goes on at the next message', () => {
  const view = empty()
  const built = new Set<string>()
  const lines = every('x'.repeat(200), (line) => line.l === 0 || built.has(name(line)))
  for (let id = 0; id < 100; id += 1) {
    reach(view, id + 1, lines)
    fit(view, { high: 4_000 }, lines, true)
  }
  expect(view.lines.every((line) => line.l === 0)).toBe(true)
  expect(view.isMerging).toBe(true)
  built.add('0+2')
  reach(view, 101, lines)
  fit(view, { high: 4_000 }, lines, true)
  expect(view.lines[0]).toEqual({ l: 1, i: 0 })
})

test('a line not summarized yet takes no room in the view', () => {
  const view = empty()
  const lines = every('x'.repeat(100), (line) => line.i % 2 === 0 && line.l === 0)
  reach(view, 10, lines)
  expect(view.size).toBe(500)
})

test('every line has its own slot, and the slot gives the line back', () => {
  const seen = new Set<number>()
  for (let l = 0; l < 10; l += 1) {
    for (let i = 0; i < 64; i += 1) {
      const at = slot({ l, i })
      expect(seen.has(at)).toBe(false)
      seen.add(at)
      expect(lineOf(at)).toEqual({ l, i })
    }
  }
})
