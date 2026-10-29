import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chat } from '../src/chat.ts'
import { Compactor } from '../src/compactor.ts'
import { Filter, OWN_TOOLS, type Tool } from '../src/filter.ts'
import { Pool, type Block } from '../src/pool.ts'
import { SYSTEM } from '../src/prompt.ts'
import { Sessions } from '../src/sessions.ts'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

type Call = { body: { messages: { role: string; content: Block[] }[]; model: string; system: Block[]; tools: Tool[] }; headers: Record<string, string> }

const sse = (text: string): Response => {
  const events = [
    { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}

const setup = (lines: string[] = []) => {
  const folder = mkdtempSync(join(tmpdir(), 'totalrecall-'))
  folders.push(folder)
  const calls: Call[] = []
  const send = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> })
    return sse(lines.shift() ?? 'user: a summary')
  }) as unknown as typeof fetch
  const chat = new Chat(folder)
  const compactor = new Compactor(chat, new Pool('http://pool', send), 'totalrecall-compaction')
  chat.listen(compactor)
  const sessions = new Sessions(join(folder, 'sessions'))
  const filter = new Filter(chat, compactor, sessions, 5_000)
  return { folder, chat, compactor, sessions, filter, calls }
}

const DEVICE = 'mac:/work'
const HEADERS = { 'x-claude-code-session-id': 's1', 'user-agent': 'claude-cli/2.1.310 (external, cli)', 'x-app': 'cli', 'anthropic-beta': 'claude-code-20250219' }
const SYSTEM_BLOCKS: Block[] = [
  { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.310; cc_entrypoint=cli;' },
  { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral', ttl: '1h' } },
  { type: 'text', text: 'The person’s own instructions.', cache_control: { type: 'ephemeral', ttl: '1h' } },
]
const TOOLS: Tool[] = [
  { name: 'Bash', description: 'Runs a command.', input_schema: { type: 'object' } },
  { name: OWN_TOOLS.zoom, description: 'zoom', input_schema: { type: 'object' } },
]
const CONTEXT = { type: 'text', text: '<system-reminder>\nCLAUDE.md says hello.\n</system-reminder>' }
const OPENING = { role: 'user', content: [CONTEXT, { type: 'text', text: 'say hi' }] }
const SESSION_START = { role: 'system', content: [{ type: 'text', text: 'SessionStart hook additional context: memory' }] }

const body = (messages: unknown[]) => ({ model: 'claude-opus-5-5', max_tokens: 128_000, stream: true, metadata: { user_id: 'u' }, system: SYSTEM_BLOCKS, tools: TOOLS, messages })

const reply = (filter: Filter, id: string, text: string): void => {
  const events = [
    { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]
  events.forEach((event, index) => filter.response({ id, body: event, endOfStream: index === events.length - 1 }))
}

const marks = (value: unknown): number => JSON.stringify(value).split('"cache_control"').length - 1

const expectValidRoles = (messages: readonly { role: string }[]): void => {
  messages.forEach((message, index) => {
    if (message.role === 'system') expect(messages[index + 1]?.role ?? 'assistant').toBe('assistant')
  })
  expect(messages[0]?.role).toBe('user')
}

const MARK = { type: 'ephemeral', ttl: '1h' }

test('a turn reads the system prompt and the person’s instructions, then the view, then its words', async () => {
  const { filter, chat } = setup()
  const answer = await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, SESSION_START]) })
  const sent = answer.body as ReturnType<typeof body> & { messages: { role: string; content: Block[] }[] }
  expect(sent.system.map((block) => block['text'])).toEqual([SYSTEM_BLOCKS[0]!['text'], SYSTEM_BLOCKS[1]!['text'], SYSTEM, SYSTEM_BLOCKS[2]!['text']])
  expect(sent.tools.map((tool) => tool['name'])).toEqual(['Bash', OWN_TOOLS.zoom])
  expect(sent.messages).toEqual([
    {
      role: 'user',
      content: [
        CONTEXT,
        { type: 'text', text: 'SessionStart hook additional context: memory', cache_control: MARK },
        { type: 'text', text: '<chat>\n</chat>' },
        { type: 'text', text: `device: ${DEVICE}` },
        { type: 'text', text: 'say hi', cache_control: MARK },
      ],
    },
  ])
  expect(answer.headers).toBeUndefined()
  expect(chat.message(0)).toMatchObject({ i: 0, kind: 'user', text: 'say hi' })
})

test('the next turn reads the earlier turn as summary lines, never whole', async () => {
  const { filter, chat } = setup()
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, SESSION_START]) })
  reply(filter, 'r1', 'hi there')
  expect(chat.message(1)).toMatchObject({ kind: 'claude', text: 'hi there' })
  const second = { role: 'user', content: [{ type: 'text', text: 'second turn' }] }
  const hook = { role: 'system', content: [{ type: 'text', text: 'UserPromptSubmit hook additional context: more' }] }
  const answer = await filter.request(DEVICE, {
    id: 'r2',
    path: '/v1/messages',
    headers: HEADERS,
    body: body([OPENING, SESSION_START, { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }, second, hook]),
  })
  const sent = answer.body as { messages: { role: string; content: Block[] }[] }
  expect(sent.messages.map((message) => message.content.map((block) => block['text']))).toEqual([
    [CONTEXT.text, 'SessionStart hook additional context: memory', '<chat>\n0+1|user: say hi\n1+1|claude: hi there\n</chat>', `device: ${DEVICE}`, 'second turn'],
    ['UserPromptSubmit hook additional context: more'],
  ])
  expect(sent.messages.map((message) => message.role)).toEqual(['user', 'system'])
  expectValidRoles(sent.messages)
  expect(chat.total).toBe(3)
})

test('tools Claude Code added earlier stay added, after the person’s words', async () => {
  const { filter } = setup()
  const addition = { type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'mcp__docs__read', input_schema: { type: 'object' } } } }
  const opening = { role: 'system', content: [SESSION_START.content[0]!, addition] }
  const answer = await filter.request(DEVICE, {
    id: 'r1',
    path: '/v1/messages',
    headers: HEADERS,
    body: body([OPENING, opening, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, { role: 'user', content: [{ type: 'text', text: 'next' }] }]),
  })
  const sent = answer.body as { messages: { role: string; content: Block[] }[] }
  expect(sent.messages.map((message) => message.role)).toEqual(['user', 'system'])
  expect(sent.messages[0]!.content.at(-1)!['text']).toBe('next')
  expect(sent.messages[1]!.content.map((block) => block.type)).toEqual(['tool_addition'])
  expectValidRoles(sent.messages)
})

test('every request of a turn reads the same view, so the cache holds', async () => {
  const { filter } = setup()
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, SESSION_START]) })
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] }
  const answer = await filter.request(DEVICE, { id: 'r2', path: '/v1/messages', headers: HEADERS, body: body([OPENING, SESSION_START, call, result]) })
  const sent = answer.body as { messages: { role: string; content: Block[] }[] }
  expect(sent.messages[0]!.content[2]!['text']).toBe('<chat>\n</chat>')
  expect(sent.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
  expectValidRoles(sent.messages)
})

test('a whole 4-line block carries the cache mark, and the open block the end tag', async () => {
  const { filter, chat } = setup()
  for (let k = 0; k < 6; k += 1) chat.log('user', `message ${k}`)
  const answer = await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING]) })
  const opening = (answer.body as { messages: { content: Block[] }[] }).messages[0]!.content
  expect(opening).toEqual([
    { ...CONTEXT, cache_control: MARK },
    { type: 'text', text: '<chat>\n0+1|user: message 0\n1+1|user: message 1\n2+1|user: message 2\n3+1|user: message 3\n', cache_control: MARK },
    { type: 'text', text: '4+1|user: message 4\n5+1|user: message 5\n</chat>' },
    { type: 'text', text: `device: ${DEVICE}` },
    { type: 'text', text: 'say hi', cache_control: MARK },
  ])
})

test('Claude calls zoom by Claude Code’s own name, so a reply passes through the filter unchanged and is logged with its device', async () => {
  const { filter, chat } = setup()
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING]) })
  const start = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't9', name: OWN_TOOLS.zoom, input: {} } }
  expect(filter.response({ id: 'r1', body: start, endOfStream: false })).toEqual({})
  filter.response({ id: 'r1', body: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":0,"n":1}' } }, endOfStream: false })
  filter.response({ id: 'r1', body: { type: 'content_block_stop', index: 0 }, endOfStream: false })
  filter.response({ id: 'r1', body: { type: 'message_stop' }, endOfStream: true })
  expect(chat.message(1).text).toBe(`${OWN_TOOLS.zoom} {"id":0,"n":1,"device":"${DEVICE}"}`)
})

test('a session turned recall off keeps every tool but totalrecall’s', () => {
  const { filter } = setup()
  const loaded = { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: OWN_TOOLS.zoom } }] }
  const answer = filter.strip({ id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, loaded]) })
  const sent = answer.body as { tools: Block[]; messages: { content: Block[] }[] }
  expect(sent.tools.map((tool) => tool['name'])).toEqual(['Bash'])
  expect(sent.messages).toEqual([OPENING])
})

test('a tool result logs without the reminders Claude Code adds to it', async () => {
  const { filter, chat } = setup()
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }, { type: 'text', text: '<system-reminder>\nBe concise.\n</system-reminder>' }] }] }
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, call, result]) })
  expect(chat.message(2).text).toBe('a.txt')
})

test('a tool output over 30,000 characters logs as one message holding its head and tail', async () => {
  const { filter, chat } = setup()
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat big.log' } }] }
  const output = `HEAD${'x'.repeat(50_000)}TAIL`
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: output }] }
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, call, result]) })
  const logged = chat.message(2).text
  expect(chat.total).toBe(3)
  expect(logged.length).toBe(30_000)
  expect(logged).toStartWith('HEAD')
  expect(logged).toEndWith('TAIL')
  expect(logged).toContain('[… 20036 characters cut …]')
})

test('words the person sends while Claude works log as theirs, without Claude Code’s wrapper', async () => {
  const { filter, chat } = setup()
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }
  const midTurn = {
    type: 'text',
    text: 'The user sent a new message while you were working:\nstand your ground\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.',
  }
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }, midTurn] }
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, call, result]) })
  expect([0, 1, 2, 3].map((id) => chat.message(id))).toMatchObject([
    { kind: 'user', text: 'say hi' },
    { kind: 'tool', text: `Bash {"command":"ls","device":"${DEVICE}"}` },
    { kind: 'echo', text: 'a.txt' },
    { kind: 'user', text: 'stand your ground' },
  ])
})

const NOTIFICATION_PREAMBLE =
  '<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n\n'

const taskNotification = (body: string): string =>
  `<task-notification>\n<task-id>a9039c355724d4bfe</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n${body}\n</task-notification>`

const notice = (body: string) => ({ role: 'system', content: [{ type: 'text', text: `${NOTIFICATION_PREAMBLE}${taskNotification(body)}\n</system-reminder>` }] })

test('a background subagent’s report starts a turn and logs as its work, and its launch as a tool result', async () => {
  const { filter, chat } = setup()
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Check the ads' } }] }
  const launched = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Async agent launched successfully.\nagentId: a9039c355724d4bfe (internal ID)' }] }
  const waiting = { role: 'assistant', content: [{ type: 'text', text: 'The agent is checking the ads.' }] }
  const report = notice('<summary>Agent "Check the ads" finished</summary>\n<result>All 13 ads are live.</result>')
  const answer = await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, call, launched, waiting, report]) })
  expect([0, 1, 2, 3, 4].map((id) => chat.message(id))).toMatchObject([
    { kind: 'user', text: 'say hi' },
    { kind: 'tool', text: `Agent {"description":"Check the ads","device":"${DEVICE}"}` },
    { kind: 'echo', text: 'Async agent launched successfully.\nagentId: a9039c355724d4bfe (internal ID)' },
    { kind: 'claude', text: 'The agent is checking the ads.' },
    { kind: 'work', text: '[Check the ads] All 13 ads are live.' },
  ])
  const sent = answer.body as { messages: { role: string; content: Block[] }[] }
  expect(sent.messages.length).toBe(1)
  expect(sent.messages[0]!.content.at(-1)!['text']).toBe(report.content[0]!.text)
  expectValidRoles(sent.messages)
})

test('a subagent is named by its task, a second with the same task gets a number, and zoom opens each by its name', async () => {
  const { filter, chat } = setup()
  const subagent = (id: string, task: string) =>
    filter.request(DEVICE, { id: `r-${id}`, path: '/v1/messages', headers: { ...HEADERS, 'x-claude-code-agent-id': id }, body: body([{ role: 'user', content: [{ type: 'text', text: task }] }]) })
  await subagent('a9039c355724d4bfe', 'Check every ad.')
  await subagent('b5521c0e9d7f3a6b1', 'Check every ad again.')
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Check the ads' } }] }
  const launched = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Async agent launched successfully.\nagentId: a9039c355724d4bfe (internal ID)' }] }
  const again = { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { description: 'Check the ads' } }] }
  const answered = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't2', content: "Two ads are down.\nagentId: b5521c0e9d7f3a6b1 (use SendMessage with to: 'b5521c0e9d7f3a6b1' to continue this agent)" }],
  }
  const waiting = { role: 'assistant', content: [{ type: 'text', text: 'One agent is still checking.' }] }
  const report = notice('<summary>Agent "Check the ads" finished</summary>\n<result>All 13 ads are live.</result>')
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, call, launched, again, answered, waiting, report]) })
  expect([4, 6].map((id) => chat.message(id).text)).toEqual([
    "[Check the ads 2] Two ads are down.\nagentId: b5521c0e9d7f3a6b1 (use SendMessage with to: 'b5521c0e9d7f3a6b1' to continue this agent)",
    '[Check the ads] All 13 ads are live.',
  ])
  expect(chat.agent('Check the ads')?.text).toBe('user: Check every ad.')
  expect(chat.agent('Check the ads 2')?.text).toBe('user: Check every ad again.')
})

test('a notice that arrives between tool calls stays in the running turn', async () => {
  const { filter, chat } = setup()
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] }
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'a.txt' }] }
  const done = notice('<summary>Background command "Serve the map" completed (exit code 0)</summary>')
  const answer = await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, call, result, done]) })
  expect(chat.message(3)).toMatchObject({ kind: 'echo', text: taskNotification('<summary>Background command "Serve the map" completed (exit code 0)</summary>') })
  const sent = answer.body as { messages: { role: string; content: Block[] }[] }
  expect(sent.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'system'])
  expect(sent.messages[0]!.content.at(-1)!['text']).toBe('say hi')
})

test('a long message waits for its summary before the next turn reads the view', async () => {
  const { filter, calls, chat } = setup(['user: asked for a long thing'])
  const long = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2_000) }] }
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([long]) })
  const answer = await filter.request(DEVICE, {
    id: 'r2',
    path: '/v1/messages',
    headers: HEADERS,
    body: body([long, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'next' }] }]),
  })
  expect(calls.length).toBe(1)
  expect(calls[0]!.body.model).toBe('claude-haiku-5-5')
  expect(calls[0]!.headers['x-claude-code-session-id']).toBe('totalrecall-compaction')
  expect(calls[0]!.headers['x-oneclaude-cache-key']).toBeUndefined()
  expect(calls[0]!.body.system).toEqual((answer.body as { system: Block[] }).system)
  expect(String(calls[0]!.body.messages[0]!.content.at(-2)!['text'])).toStartWith('Compaction: compress message 0 into one line')
  const opening = (answer.body as { messages: { content: Block[] }[] }).messages[0]!.content
  expect(opening[0]!['text']).toBe('<chat>\n0+1|user: asked for a long thing\n1+1|claude: ok\n</chat>')
  expect(chat.text({ l: 0, i: 0 })).toBe('user: asked for a long thing')
})

test('a summary that failed is tried again as the next turn starts, so the turn never waits it out', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'totalrecall-'))
  folders.push(folder)
  let isFailing = true
  const send = (async () => (isFailing ? new Response('overloaded', { status: 529 }) : sse('user: asked for a long thing'))) as unknown as typeof fetch
  const chat = new Chat(folder)
  const compactor = new Compactor(chat, new Pool('http://pool', send), 'totalrecall-compaction')
  chat.listen(compactor)
  const filter = new Filter(chat, compactor, new Sessions(join(folder, 'sessions')), 5_000)
  const long = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2_000) }] }
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([long]) })
  await Bun.sleep(50)
  expect(chat.text({ l: 0, i: 0 })).toBeUndefined()
  isFailing = false
  const started = Date.now()
  const answer = await filter.request(DEVICE, {
    id: 'r2',
    path: '/v1/messages',
    headers: HEADERS,
    body: body([long, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'next' }] }]),
  })
  expect(Date.now() - started).toBeLessThan(1_000)
  const opening = (answer.body as { messages: { content: Block[] }[] }).messages[0]!.content
  expect(opening[0]!['text']).toBe('<chat>\n0+1|user: asked for a long thing\n1+1|claude: ok\n</chat>')
})

test('a session that turns recall on runs as plain Claude Code until its history is summarized, then reads the chat', async () => {
  const { filter, chat } = setup(['user: asked for a long thing'])
  const long = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2_000) }] }
  const ok = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
  const next = { role: 'user', content: [{ type: 'text', text: 'next' }] }
  const first = await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([long, ok, next]) })
  expect(first).toEqual({})
  expect([0, 1, 2].map((id) => chat.message(id).kind)).toEqual(['user', 'claude', 'user'])
  const count = await filter.request(DEVICE, { id: 'r2', path: '/v1/messages/count_tokens', headers: HEADERS, body: body([long, ok, next]) })
  expect(count).toEqual({})
  reply(filter, 'r1', 'done')
  await Bun.sleep(50)
  const third = { role: 'user', content: [{ type: 'text', text: 'third' }] }
  const answer = await filter.request(DEVICE, {
    id: 'r3',
    path: '/v1/messages',
    headers: HEADERS,
    body: body([long, ok, next, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, third]),
  })
  const opening = (answer.body as { messages: { content: Block[] }[] }).messages[0]!.content
  expect(`${opening[0]!['text']}${opening[1]!['text']}`).toBe('<chat>\n0+1|user: asked for a long thing\n1+1|claude: ok\n2+1|user: next\n3+1|claude: done\n</chat>')
  expect(chat.total).toBe(5)
})

test('a compaction passes through unchanged, logs what the chat missed, and its summary is never the person’s words', async () => {
  const { filter, chat } = setup()
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING]) })
  const missed = { role: 'assistant', content: [{ type: 'text', text: 'answered while the program was down' }] }
  const task = { role: 'user', content: [{ type: 'text', text: 'CRITICAL: Respond with TEXT ONLY.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention.' }] }
  const compaction = await filter.request(DEVICE, { id: 'r2', path: '/v1/messages', headers: HEADERS, body: body([OPENING, missed, task]) })
  expect(compaction).toEqual({})
  expect([0, 1].map((id) => chat.message(id).text)).toEqual(['say hi', 'answered while the program was down'])
  expect(chat.total).toBe(2)
  const summary = { role: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context. The summary below covers it.' }] }
  const after = { role: 'user', content: [{ type: 'text', text: 'carry on' }] }
  await filter.request(DEVICE, { id: 'r3', path: '/v1/messages', headers: HEADERS, body: body([summary, after]) })
  expect(chat.message(2).text).toBe('carry on')
  expect(chat.total).toBe(3)
})

test('a compaction reads the same system prompt, tools, and instructions as the turns', async () => {
  const { filter, calls } = setup()
  const answer = await filter.request(DEVICE, {
    id: 'r1',
    path: '/v1/messages',
    headers: HEADERS,
    body: body([{ role: 'user', content: [CONTEXT, { type: 'text', text: 'w'.repeat(1_000) }] }, SESSION_START]),
  })
  await Bun.sleep(50)
  const sent = answer.body as { system: Block[]; tools: Tool[]; messages: { role: string; content: Block[] }[] }
  const compaction = calls[0]!.body
  expect(compaction.system).toEqual(sent.system)
  expect(compaction.tools).toEqual(sent.tools)
  expect(compaction.messages.length).toBe(1)
  expect(compaction.messages[0]!.content.slice(0, 2)).toEqual(sent.messages[0]!.content.slice(0, 2))
  expect(compaction.messages[0]!.content.slice(2).map((block) => String(block['text']).slice(0, 40))).toEqual(['<chat>\n</chat>', 'Compaction: compress message 0 into one ', '\n</input>'])
  expectValidRoles(compaction.messages)
})

test('a picture in a tool result is kept with its message, and its summary is written from the picture', async () => {
  const { filter, calls, chat } = setup(['echo: a login page with an empty password field'])
  const picture = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/shot.png' } }] }
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [picture] }] }
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING, call, result]) })
  await Bun.sleep(50)
  expect(chat.message(2)).toMatchObject({ kind: 'echo', text: '[image]', images: [{ media_type: 'image/png', data: 'iVBORw0KGgo=' }] })
  const task = calls[0]!.body.messages[0]!.content.slice(-3)
  expect(String(task[0]!['text'])).toEndWith('<input>\necho: [image]')
  expect(task[1]).toEqual(picture)
  expect(task[2]).toMatchObject({ type: 'text', text: '\n</input>' })
  expect(chat.text({ l: 0, i: 2 })).toBe('echo: a login page with an empty password field')
})

test('a line over 512 bytes is asked for again in the same conversation', async () => {
  const { filter, calls, chat } = setup(['y'.repeat(600), 'user: short enough'])
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([{ role: 'user', content: [{ type: 'text', text: 'z'.repeat(1_000) }] }]) })
  await Bun.sleep(50)
  expect(calls.length).toBe(2)
  const retry = calls[1]!.body.messages
  expect(retry.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
  expect(String(retry[2]!.content[0]!['text'])).toStartWith('Too long: your line is 600 bytes, over the 512-byte limit.')
  expect(marks(retry)).toBe(1)
  expect(chat.text({ l: 0, i: 0 })).toBe('user: short enough')
})

test('a rewound history logs what follows the rewind, and keeps what came before', async () => {
  const { filter, chat } = setup()
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING]) })
  reply(filter, 'r1', 'first answer')
  await filter.request(DEVICE, { id: 'r2', path: '/v1/messages', headers: HEADERS, body: body([{ role: 'user', content: [CONTEXT, { type: 'text', text: 'say bye' }] }]) })
  expect([0, 1, 2].map((id) => chat.message(id).text)).toEqual(['say hi', 'first answer', 'say bye'])
})

test('a subagent reads the view first, and its steps stay in its own log', async () => {
  const { filter, chat } = setup()
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING]) })
  const task = { role: 'user', content: [{ type: 'text', text: 'Find the config file.' }] }
  const answer = await filter.request(DEVICE, { id: 'r2', path: '/v1/messages', headers: { ...HEADERS, 'x-claude-code-agent-id': 'a1' }, body: body([task]) })
  const sent = answer.body as { messages: { content: Block[] }[] }
  expect(sent.messages[0]!.content.map((block) => block['text'])).toEqual(['<chat>\n0+1|user: say hi\n</chat>', `device: ${DEVICE}`, 'Find the config file.'])
  expect(chat.total).toBe(1)
  expect(chat.agent('a1')).toEqual({ text: 'user: Find the config file.', images: [] })
})

test('a local command is never the person’s words, with or without a caveat before it', async () => {
  const { filter, chat } = setup()
  const caveat = { type: 'text', text: '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>' }
  const reload = { type: 'text', text: '<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>' }
  const recall = { type: 'text', text: '<command-name>/recall</command-name>\n            <command-message>recall</command-message>\n            <command-args></command-args>\n' }
  await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([{ role: 'user', content: [caveat, reload, recall, { type: 'text', text: 'say hi' }] }]) })
  expect(chat.message(0).text).toBe('say hi')
  expect(chat.total).toBe(1)
})

test('a skill the person runs logs as the command they typed, and Claude still reads the skill', async () => {
  const { filter, chat } = setup()
  const command = { type: 'text', text: '<command-message>orchestrate</command-message>\n<command-name>/orchestrate</command-name>\n<command-args>Start one agent.</command-args>' }
  const skill = { type: 'text', text: 'Base directory for this skill: /skills/orchestrate\n\n# Orchestrate\n\nYou own the Architecture.' }
  const answer = await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([{ role: 'user', content: [CONTEXT, command, skill] }]) })
  expect(chat.message(0)).toMatchObject({ kind: 'user', text: '/orchestrate Start one agent.' })
  expect(chat.total).toBe(1)
  const sent = answer.body as { messages: { content: Block[] }[] }
  expect(sent.messages[0]!.content.slice(-2).map((block) => block['text'])).toEqual([command.text, skill.text])
})

test('token counts read the same request the turn sends', async () => {
  const { filter } = setup()
  const turn = await filter.request(DEVICE, { id: 'r1', path: '/v1/messages', headers: HEADERS, body: body([OPENING]) })
  const count = await filter.request(DEVICE, { id: 'r2', path: '/v1/messages/count_tokens', headers: HEADERS, body: body([OPENING]) })
  expect(count.body).toEqual(turn.body)
})
