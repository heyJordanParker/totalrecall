import { expect, test } from 'bun:test'
import { Prompt } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { totalrecall } from '../src/mod.js'

const setup = (options: { pool?: string; isServing?: boolean } = {}) => {
  const filters: { method: string; input: object }[] = []
  const posted: string[] = []
  const ran: string[] = []
  const tested = testMod(totalrecall, {
    dependencies: {
      oneclaude: {
        addFilter: async (input: object) => void filters.push({ method: 'addFilter', input }),
        removeFilter: async (input: object) => void filters.push({ method: 'removeFilter', input }),
      } as never,
    },
  })
  tested.fakes.settings.read = (async () => (options.pool === undefined ? {} : { env: { ANTHROPIC_BASE_URL: options.pool } })) as never
  tested.fakes.process.run = async () => ({ exitCode: 0, stdout: 'mac-studio\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  tested.fakes.command.run = (async ({ command }: { command: string }) => {
    ran.push(command)
    return {}
  }) as never
  tested.fakes.http.fetch = (async (url: string) => {
    posted.push(url)
    if (options.isServing === false) throw new Error('connection refused')
    const path = new URL(url).pathname
    const answer = path === '/zoom' ? { content: [{ type: 'text', text: '0+1|user: hello' }] } : { text: 'Friday' }
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) }
  }) as never
  return { tested, filters, posted, ran }
}

test('/recall puts the session through the filter with its device, and gives Claude zoom and date', async () => {
  const { tested, filters, posted } = setup()
  expect(await tested.type('/recall')).toMatchObject({ text: 'Total recall is on. This session joins the one chat that never ends.' })
  const added = filters.at(-1)!.input as { url: string }
  expect(filters.at(-1)).toEqual({ method: 'addFilter', input: { name: 'totalrecall', url: added.url, responses: true, timeoutSeconds: 120, failOpen: true } })
  expect(added.url).toStartWith('http://127.0.0.1:8320/on?device=mac-studio%3A%2F')
  expect(await tested.callTool('zoom', { id: 0, n: 1 })).toEqual({ result: [{ type: 'text', text: '0+1|user: hello' }] })
  expect(await tested.callTool('date', { id: 0 })).toEqual({ result: 'Friday' })
  expect(posted).toEqual(['http://127.0.0.1:8320/zoom', 'http://127.0.0.1:8320/date'])
})

test('a session whose pool is on another machine asks that machine’s program, and still registers the filter on loopback', async () => {
  const { tested, filters, posted } = setup({ pool: 'http://devbox:8317' })
  await tested.type('/recall')
  await tested.callTool('zoom', { id: 0, n: 1 })
  expect(posted).toEqual(['http://devbox:8320/zoom'])
  expect((filters.at(-1)!.input as { url: string }).url).toStartWith('http://127.0.0.1:8320/on?')
})

test('every prompt puts a session with total recall on back through the filter', async () => {
  const { tested, filters } = setup()
  await tested.type('/recall')
  await tested.raise.beforePrompt({ text: 'hello' })
  expect(filters.slice(-2).map(({ method }) => method)).toEqual(['addFilter', 'addFilter'])
})

test('turning it off mid-session keeps the filter only to take its tools out', async () => {
  const { tested, filters } = setup()
  await tested.type('/recall')
  expect(await tested.type('/recall')).toMatchObject({ text: 'Total recall is off in this session.' })
  expect(filters.at(-1)).toEqual({ method: 'addFilter', input: { name: 'totalrecall', url: 'http://127.0.0.1:8320/strip', timeoutSeconds: 120, failOpen: true } })
})

test('a session that never turned it on stays out of the filter', async () => {
  const { tested, filters } = setup()
  await tested.settle()
  await tested.raise.beforePrompt({ text: 'hello' })
  expect(filters.map(({ method }) => method)).toEqual(['removeFilter', 'removeFilter'])
})

test('a recall session refuses a compaction only while its program does not answer', async () => {
  const down = setup({ isServing: false })
  await down.tested.add({ type: Prompt, text: 'hello' })
  expect(await down.tested.raise.beforeContextEnd()).toBeUndefined()
  await down.tested.type('/recall')
  expect(await down.tested.raise.beforeContextEnd()).toMatchObject({ refuse: expect.stringContaining('can\'t reach its program') })
  const up = setup()
  await up.tested.add({ type: Prompt, text: 'hello' })
  await up.tested.type('/recall')
  expect(await up.tested.raise.beforeContextEnd()).toBeUndefined()
})

test('a recall session compacts Claude Code’s own copy once it passes 80% of the window', async () => {
  const { tested, ran } = setup()
  tested.fakes.session.usage = (async () => ({ startedAt: Date.now(), context: { window: 1_000 }, rateLimits: [] })) as never
  await tested.type('/recall')
  await tested.add({ type: Prompt, text: 'short' })
  await tested.endTurn()
  await tested.settle()
  expect(ran).toEqual([])
  await tested.add({ type: Prompt, text: 'x'.repeat(4_000) })
  await tested.endTurn()
  await tested.settle()
  expect(ran).toEqual(['compact'])
})
