import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chat, LINE_BYTES, MESSAGE_CHARACTERS } from '../src/chat.ts'
import type { Line } from '../src/view.ts'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const open = () => {
  const folder = mkdtempSync(join(tmpdir(), 'totalrecall-chat-'))
  folders.push(folder)
  const ready: Line[] = []
  const chat = new Chat(folder)
  chat.listen({ ready: (line) => void ready.push(line) })
  return { folder, chat, ready }
}

test('a restarted server reads the same messages, nodes, and view it saved', () => {
  const { folder, chat } = open()
  for (let k = 0; k < 40; k += 1) chat.log('user', `message ${k}`)
  chat.build({ l: 0, i: 99 }, 'never offered')
  const again = new Chat(folder)
  expect(again.total).toBe(40)
  expect(again.message(17)).toMatchObject({ i: 17, kind: 'user', text: 'message 17' })
  expect(again.text({ l: 3, i: 2 })).toBe(chat.text({ l: 3, i: 2 }))
  expect(again.view).toEqual(chat.view)
  expect(again.compactionView).toEqual(chat.compactionView)
})

test('a restarted server queues every node it still has to build', () => {
  const { folder, chat } = open()
  chat.log('user', 'x'.repeat(600))
  chat.log('user', 'y'.repeat(600))
  chat.build({ l: 0, i: 0 }, 'user: x')
  const ready: Line[] = []
  new Chat(folder).listen({ ready: (line) => void ready.push(line) })
  expect(ready).toEqual([{ l: 0, i: 1 }])
})

test('a restarted server queues a merge whose halves are both built once', () => {
  const { folder, chat } = open()
  chat.log('user', 'x'.repeat(600))
  chat.log('user', 'y'.repeat(600))
  chat.build({ l: 0, i: 0 }, 'z'.repeat(300))
  chat.build({ l: 0, i: 1 }, 'w'.repeat(300))
  const ready: Line[] = []
  new Chat(folder).listen({ ready: (line) => void ready.push(line) })
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

test('a text too long for one message is logged as several in a row', () => {
  const { chat } = open()
  const ids = chat.log('echo', 'a'.repeat(MESSAGE_CHARACTERS * 2 + 5))
  expect(ids).toEqual([0, 1, 2])
  expect(chat.message(2).text).toBe('aaaaa')
})
