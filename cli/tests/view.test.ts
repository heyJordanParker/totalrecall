import { expect, test } from 'bun:test'
import { append, end, first, mergeOnce, name, type Line, type Lines, type ViewState } from '../src/view.ts'

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

const everyLineBuilt: Lines = { text: () => 'x' }

test('merging the most due pair makes exactly the merges push makes', () => {
  let states: States = null
  const view: Line[] = []
  for (let t = 0; t <= 20_000; t += 1) {
    states = push(t, states)
    view.push({ l: 0, i: t })
    const budget = starts(states).length
    while (view.length > budget) expect(mergeOnce(view, t + 1, everyLineBuilt)).toBeDefined()
    expect(view.map(first)).toEqual(starts(states))
  }
})

test('the view covers every message once, oldest first', () => {
  const view: ViewState = { lines: [], isMerging: false }
  const lines: Lines = { text: () => 'a summary of about forty bytes, give or take' }
  for (let id = 0; id < 20_000; id += 1) append(view, id, lines, { low: 4_000, high: 8_000 })
  let next = 0
  for (const line of view.lines) {
    expect(first(line)).toBe(next)
    next = end(line)
  }
  expect(next).toBe(20_000)
})

test('the view grows one line per message, then drops back to the low mark at once', () => {
  const view: ViewState = { lines: [], isMerging: false }
  const lines: Lines = { text: () => 'x'.repeat(100) }
  const sizes: number[] = []
  for (let id = 0; id < 3_000; id += 1) {
    append(view, id, lines, { low: 4_000, high: 8_000 })
    sizes.push(view.lines.length)
  }
  const drops = sizes.filter((length, k) => k > 0 && length < sizes[k - 1]!)
  expect(drops.length).toBeGreaterThan(5)
  expect(Math.max(...sizes) * 108).toBeLessThan(8_000 + 2 * 120)
})

test('a pair merges only once its parent is built', () => {
  const view: ViewState = { lines: [], isMerging: false }
  const built = new Set<string>()
  const lines: Lines = { text: (line) => (line.l === 0 || built.has(name(line)) ? 'x'.repeat(200) : undefined) }
  for (let id = 0; id < 100; id += 1) append(view, id, lines, { low: 2_000, high: 4_000 })
  expect(view.lines.every((line) => line.l === 0)).toBe(true)
  expect(view.isMerging).toBe(true)
  built.add('0+2')
  append(view, 100, lines, { low: 2_000, high: 4_000 })
  expect(view.lines[0]).toEqual({ l: 1, i: 0 })
})
