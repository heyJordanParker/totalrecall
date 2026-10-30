import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { Chat } from '../src/chat.ts'
import { Imports, picked, sources, summaries } from '../src/import.ts'
import { Sessions } from '../src/sessions.ts'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const temporary = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'totalrecall-import-'))
  folders.push(folder)
  return folder
}

const jsonl = (records: unknown[]): string => records.map((record) => JSON.stringify(record)).join('\n') + '\n'
const host = hostname()
const ALL = { since: '', tools: true }
const SAYS = { since: '', tools: false }

const claudeSession = (home: string): string => {
  const folder = join(home, '.claude', 'projects', '-work')
  mkdirSync(join(folder, 'subagents'), { recursive: true })
  const at = (second: number) => `2026-06-01T10:00:0${second}.000Z`
  writeFileSync(
    join(folder, 's1.jsonl'),
    jsonl([
      { type: 'user', isMeta: true, cwd: '/work', timestamp: at(0), message: { role: 'user', content: '<system-reminder>CLAUDE.md</system-reminder>' } },
      { type: 'user', cwd: '/work', timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'fix the build' }] } },
      { type: 'assistant', cwd: '/work', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Running make.' }] } },
      { type: 'assistant', cwd: '/work', timestamp: at(3), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make' } }] } },
      { type: 'user', cwd: '/work', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', isSidechain: true, cwd: '/work', timestamp: at(5), message: { role: 'assistant', content: [{ type: 'text', text: 'a sidechain' }] } },
      'not json {',
    ]),
  )
  writeFileSync(join(folder, 'subagents', 'agent.jsonl'), jsonl([{ type: 'user', cwd: '/work', message: { role: 'user', content: 'agent' } }]))
  return home
}

test('a Claude Code session imports the person’s words, Claude’s as ai, and its tool calls with their device, behind a note', () => {
  const home = claudeSession(temporary())
  const found = sources([], home, {})
  expect(found.map((source) => source.key)).toEqual(['claude-code:s1'])
  expect(picked(found[0]!, ALL, undefined)).toEqual([
    { kind: 'note', text: `Claude Code session in /work on ${host}, from ${new Date('2026-06-01T10:00:01.000Z').toLocaleString('sv-SE').slice(0, 16)} (imported)`, date: '2026-06-01T10:00:01.000Z' },
    { kind: 'user', text: 'fix the build', date: '2026-06-01T10:00:01.000Z' },
    { kind: 'claude', text: 'Running make.', date: '2026-06-01T10:00:02.000Z' },
    { kind: 'tool', text: `Bash {"command":"make","device":"${host}:/work"}`, date: '2026-06-01T10:00:03.000Z' },
    { kind: 'echo', text: 'ok', date: '2026-06-01T10:00:04.000Z' },
  ])
  expect(picked(found[0]!, SAYS, undefined).map((entry) => entry.kind)).toEqual(['note', 'user', 'claude'])
  expect(picked(found[0]!, SAYS, '2026-06-01T10:00:01.000Z').map((entry) => entry.kind)).toEqual(['note', 'claude'])
  expect(picked(found[0]!, { since: '2026-07-01', tools: false }, undefined)).toEqual([])
})

test('an imported subagent’s report is its work, with no pointer to a chat the import never brought', () => {
  const home = temporary()
  const folder = join(home, '.claude', 'projects', '-work')
  mkdirSync(folder, { recursive: true })
  const at = '2026-06-03T10:00:00.000Z'
  writeFileSync(
    join(folder, 's2.jsonl'),
    jsonl([
      { type: 'user', cwd: '/work', timestamp: at, message: { role: 'user', content: 'check the ads' } },
      { type: 'assistant', cwd: '/work', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Check the ads' } }] } },
      { type: 'user', cwd: '/work', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'All ads are live.\nagentId: a1b2c3' }] } },
    ]),
  )
  const [source] = sources([], home, {})
  expect(picked(source!, SAYS, undefined).at(-1)).toEqual({ kind: 'work', text: '[Check the ads] All ads are live.\nagentId: a1b2c3', date: at })
})

test('a Codex session imports its messages and calls, and an agent’s own rollout imports nothing', () => {
  const home = temporary()
  const folder = join(home, '.codex', 'sessions', '2026', '06')
  mkdirSync(folder, { recursive: true })
  const at = '2026-06-02T09:00:00.000Z'
  writeFileSync(
    join(folder, 'rollout-1.jsonl'),
    jsonl([
      { type: 'session_meta', timestamp: at, payload: { cwd: '/app' } },
      { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }, { type: 'input_text', text: 'add a test' }] } },
      { type: 'response_item', timestamp: at, payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}' } },
      { type: 'response_item', timestamp: at, payload: { type: 'function_call_output', output: 'a.ts' } },
      { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added it.' }] } },
    ]),
  )
  writeFileSync(join(folder, 'rollout-2.jsonl'), jsonl([{ type: 'session_meta', timestamp: at, payload: { cwd: '/app', source: { subagent: 'review' } } }, { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review' }] } }]))
  const found = sources([], home, {})
  const [main, agent] = [found.find((source) => source.key === 'codex:rollout-1')!, found.find((source) => source.key === 'codex:rollout-2')!]
  expect(picked(main, ALL, undefined).slice(1)).toEqual([
    { kind: 'user', text: 'add a test', date: at },
    { kind: 'tool', text: `shell {"command":["ls"],"device":"${host}:/app"}`, date: at },
    { kind: 'echo', text: 'a.ts', date: at },
    { kind: 'claude', text: 'Added it.', date: at },
  ])
  expect(picked(main, ALL, undefined)[0]!.text).toStartWith(`Codex session in /app on ${host}, from `)
  expect(picked(agent, ALL, undefined)).toEqual([])
})

const zip = (name: string, content: string): Buffer => {
  const data = deflateRawSync(Buffer.from(content))
  const file = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(file.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(file.length, 28)
  central.writeUInt32LE(0, 42)
  const directory = Buffer.concat([central, file])
  const tail = Buffer.alloc(22)
  tail.writeUInt32LE(0x06054b50, 0)
  tail.writeUInt16LE(1, 8)
  tail.writeUInt16LE(1, 10)
  tail.writeUInt32LE(directory.length, 12)
  tail.writeUInt32LE(30 + file.length + data.length, 16)
  return Buffer.concat([local, file, data, directory, tail])
}

test('a ChatGPT export in its zip imports the thread shown, never a hidden message or an old branch', () => {
  const folder = temporary()
  const chat = {
    id: 'c1',
    title: 'Trip',
    create_time: 1_780_000_000,
    current_node: 'n3',
    mapping: {
      n1: { parent: null, message: { author: { role: 'user' }, create_time: 1_780_000_001, content: { content_type: 'text', parts: ['plan a trip'] } } },
      old: { parent: 'n1', message: { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['an old answer'] } } },
      n2: { parent: 'n1', message: { author: { role: 'assistant' }, recipient: 'all', metadata: { is_visually_hidden_from_conversation: true }, content: { content_type: 'text', parts: ['hidden'] } } },
      n3: { parent: 'n2', message: { author: { role: 'assistant' }, recipient: 'all', create_time: 1_780_000_002, content: { content_type: 'text', parts: ['Go to Lisbon.'] } } },
    },
  }
  const path = join(folder, 'export.zip')
  writeFileSync(path, zip('conversations.json', JSON.stringify([chat])))
  const [source] = sources([path], join(folder, 'nowhere'), {})
  expect(source!.key).toBe('chatgpt:c1')
  expect(picked(source!, SAYS, undefined).map((entry) => [entry.kind, entry.text])).toEqual([
    ['note', expect.stringMatching(/^ChatGPT chat "Trip", from /)],
    ['user', 'plan a trip'],
    ['claude', 'Go to Lisbon.'],
  ])
})

test('an import adds only what is new, never a session total recall logged, and its note opens what it adds', () => {
  const folder = temporary()
  const chat = new Chat(join(folder, 'chat'))
  const sessions = new Sessions(join(folder, 'chat', 'sessions'))
  sessions.keep('live', ['user:1'], 0)
  const imports = new Imports(chat, sessions, join(folder, 'chat', 'imported.json'))
  const note = { kind: 'note' as const, text: 'Claude Code session in /work on mac, from 2026-06-01 10:00 (imported)', date: '2026-06-01T10:00:00.000Z' }
  const first = { kind: 'user' as const, text: 'first', date: '2026-06-01T10:00:01.000Z' }
  const second = { kind: 'user' as const, text: 'second', date: '2026-06-01T10:00:02.000Z' }
  expect(imports.add([{ key: 'claude-code:old', entries: [note, first] }, { key: 'claude-code:live', entries: [note, first] }])).toBe(2)
  expect(imports.add([{ key: 'claude-code:old', entries: [note, first] }])).toBe(0)
  expect(imports.add([{ key: 'claude-code:old', entries: [note, first, second] }])).toBe(2)
  expect([0, 1, 2, 3].map((id) => chat.message(id).text)).toEqual([note.text, 'first', note.text, 'second'])
  const again = new Imports(chat, sessions, join(folder, 'chat', 'imported.json'))
  expect(again.state()).toEqual({ done: { 'claude-code:old': '2026-06-01T10:00:02.000Z' }, logged: ['live'], total: 4, waiting: 0 })
})

test('the estimate counts a summary for each node whose source is over 512 bytes', () => {
  expect(summaries(0, [100, 100])).toBe(0)
  expect(summaries(0, [600, 100])).toBe(2)
  expect(summaries(1, [600])).toBe(2)
})
