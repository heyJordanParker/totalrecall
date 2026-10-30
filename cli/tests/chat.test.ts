import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chat, LINE_BYTES } from '../src/chat.ts'
import { PAGE_CHARACTERS } from '../src/clip.ts'
import { end, first, type Line } from '../src/view.ts'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const listening = (ready: Line[]) => ({ ready: (line: Line) => void ready.push(line), changed: () => {} })

const open = () => {
  const folder = mkdtempSync(join(tmpdir(), 'totalrecall-chat-'))
  folders.push(folder)
  const ready: Line[] = []
  const chat = new Chat(folder)
  chat.listen(listening(ready))
  return { folder, chat, ready }
}

const covers = (lines: readonly Line[], total: number): void => {
  let next = 0
  for (const line of lines) {
    expect(first(line)).toBe(next)
    next = end(line)
  }
  expect(next).toBe(total)
}

test('a restarted server reads the same messages, nodes, and view it saved', () => {
  const { folder, chat } = open()
  for (let k = 0; k < 40; k += 1) chat.log('user', `message ${k}`)
  const again = new Chat(folder)
  expect(again.total).toBe(40)
  expect(again.message(17)).toMatchObject({ i: 17, kind: 'user', text: 'message 17' })
  expect(again.text({ l: 3, i: 2 })).toBe(chat.text({ l: 3, i: 2 }))
  expect(again.view).toEqual(chat.view)
  expect(again.compactionView).toEqual(chat.compactionView)
})

test('a chat from before the index rebuilds it from its day files', () => {
  const { folder, chat } = open()
  for (let k = 0; k < 10; k += 1) chat.log('user', `message ${k}`)
  rmSync(join(folder, 'main.index'))
  rmSync(join(folder, 'tree.index'))
  const again = new Chat(folder)
  expect(again.total).toBe(10)
  expect(again.message(9).text).toBe('message 9')
  expect(again.text({ l: 1, i: 0 })).toBe('user: message 0\nuser: message 1')
})

test('a line a crash cut short is skipped, and the chat goes on after it', () => {
  const { folder, chat } = open()
  chat.log('user', 'kept')
  const day = readdirSync(join(folder, 'main'))[0]!
  appendFileSync(join(folder, 'main', day), '{"i":1,"kind":"user","te')
  rmSync(join(folder, 'main.index'))
  const again = new Chat(folder)
  expect(again.total).toBe(1)
  again.log('user', 'after the crash')
  expect(new Chat(folder).message(1).text).toBe('after the crash')
})

test('a view saved before a crash reaches every message logged after it', () => {
  const { folder, chat } = open()
  for (let k = 0; k < 5; k += 1) chat.log('user', `message ${k}`)
  copyFileSync(join(folder, 'view.json'), join(folder, 'old-view.json'))
  for (let k = 5; k < 10; k += 1) chat.log('user', `message ${k}`)
  copyFileSync(join(folder, 'old-view.json'), join(folder, 'view.json'))
  covers(new Chat(folder).view.lines, 10)
})

test('a restarted server queues every node it still has to build', () => {
  const { folder, chat } = open()
  chat.log('user', 'x'.repeat(600))
  chat.log('user', 'y'.repeat(600))
  chat.build({ l: 0, i: 0 }, 'user: x')
  const ready: Line[] = []
  new Chat(folder).listen(listening(ready))
  expect(ready).toEqual([{ l: 0, i: 1 }])
})

test('a restarted server queues a merge whose halves are both built once', () => {
  const { folder, chat } = open()
  chat.log('user', 'x'.repeat(600))
  chat.log('user', 'y'.repeat(600))
  chat.build({ l: 0, i: 0 }, 'z'.repeat(300))
  chat.build({ l: 0, i: 1 }, 'w'.repeat(300))
  const ready: Line[] = []
  new Chat(folder).listen(listening(ready))
  expect(ready).toEqual([{ l: 1, i: 0 }])
})

test('a short message is its own node, and two short lines merge without a model', () => {
  const { chat, ready } = open()
  chat.log('user', 'hello')
  chat.log('claude', 'hi')
  expect(chat.text({ l: 1, i: 0 })).toBe('user: hello\nclaude: hi')
  expect(ready).toEqual([])
})

test('a long message waits for a model, and a merge waits for both halves', () => {
  const { chat, ready } = open()
  chat.log('user', 'x'.repeat(LINE_BYTES))
  chat.log('claude', 'short')
  expect(ready).toEqual([{ l: 0, i: 0 }])
  chat.build({ l: 0, i: 0 }, 'z'.repeat(500))
  expect(ready).toEqual([{ l: 0, i: 0 }, { l: 1, i: 0 }])
  expect(chat.isBuilt({ l: 1, i: 0 })).toBe(false)
})

test('a text too long for one message is logged as several in a row, each ending at a line', () => {
  const { chat } = open()
  const lines = Array.from({ length: 4_000 }, (_, k) => `line ${String(k).padStart(14, '0')}`)
  const ids = chat.log('echo', lines.join('\n'))
  expect(ids.length).toBe(3)
  expect(ids.map((id) => chat.message(id).text).join('')).toBe(lines.join('\n'))
  expect(chat.message(0).text.length).toBeLessThanOrEqual(PAGE_CHARACTERS)
  expect(chat.message(0).text).toEndWith('\n')
})

test('an import that does not fit the view yet stays out of every turn’s view, and the live chat stays in', () => {
  const { chat } = open()
  chat.logImported(Array.from({ length: 500 }, (_, k) => ({ kind: 'user' as const, text: `${k} ${'x'.repeat(290)}`, date: '2026-06-01T10:00:00.000Z' })))
  chat.log('user', 'hello')
  expect(chat.view.size).toBeGreaterThan(128_000)
  expect(chat.rendered()).toEqual(['500+1|user: hello'])
})

test('imported messages wait on their own side, so live messages never wait behind them', () => {
  const { chat } = open()
  chat.log('user', 'live and short')
  chat.logImported([
    { kind: 'claude', text: 'an old reply', date: '2026-06-01T10:00:00.000Z' },
    { kind: 'user', text: 'p'.repeat(1_000), date: '2026-06-01T10:00:01.000Z' },
  ])
  chat.log('user', 'live again')
  expect(chat.message(1)).toMatchObject({ kind: 'claude', imported: true, date: '2026-06-01T10:00:00.000Z' })
  expect(chat.text({ l: 0, i: 1 })).toBe('ai: an old reply')
  expect(chat.unbuiltAt(0, 0)).toBe(chat.total)
  expect(chat.unbuiltAt(1, 0)).toBe(2)
  expect(chat.lineSide({ l: 0, i: 2 })).toBe(1)
  covers(chat.view.lines, 4)
})
