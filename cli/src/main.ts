import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Chat, shownKind } from './chat.ts'
import { page } from './clip.ts'
import { AT_ONCE, Compactor } from './compactor.ts'
import { Filter, PLUGIN, type FilteredRequest, type FilteredResponse } from './filter.ts'
import { imageBlock } from './history.ts'
import { Imports, runImport, type Imported } from './import.ts'
import { Pool, type Block } from './pool.ts'
import { chatBlocks } from './render.ts'
import { install, PORT, poolAddresses, poolUrl, remove } from './service.ts'
import { Sessions } from './sessions.ts'
import { children, render } from './view.ts'
import plugin from '../../.claude-plugin/plugin.json' with { type: 'json' }

const VERSION = plugin.version

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const claim = (path: string): void => {
  writeFileSync(path, String(process.pid), { flag: 'wx' })
}

const lock = (folder: string): void => {
  const path = join(folder, 'chat.lock')
  try {
    claim(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const holder = Number(readFileSync(path, 'utf8'))
    if (isRunning(holder)) throw new Error(`Another totalrecall (pid ${holder}) owns the chat in ${folder}.`)
    unlinkSync(path)
    claim(path)
  }
  process.on('exit', () => {
    if (existsSync(path) && Number(readFileSync(path, 'utf8')) === process.pid) unlinkSync(path)
  })
}

export const zoom = (chat: Chat, input: { id: number | string; n?: number; at?: number }): Block[] => {
  const at = Number.isInteger(input.at) && input.at! > 0 ? input.at! : 0
  if (typeof input.id === 'string') {
    const log = chat.agent(input.id)
    if (log === undefined) return [{ type: 'text', text: `No agent is named ${input.id}.` }]
    return [{ type: 'text', text: page(log.text, at) }, ...(at === 0 ? log.images.map(imageBlock) : [])]
  }
  const { id } = input
  const n = input.n ?? 1
  if (!Number.isInteger(id) || id < 0 || id >= chat.total) return [{ type: 'text', text: `There is no message ${id}. The chat has messages 0 to ${chat.total - 1}.` }]
  if (!Number.isInteger(Math.log2(n)) || id % n !== 0) return [{ type: 'text', text: `n is a power of 2, and id a multiple of n: ${id}+${n} is no line.` }]
  if (n === 1) {
    const message = chat.message(id)
    return [
      { type: 'text', text: `${id}|${shownKind(message)}: ${page(message.text, at)}` },
      ...(at === 0 ? (message.images ?? []).map(imageBlock) : []),
    ]
  }
  const lines = children({ l: Math.log2(n), i: id / n }).filter((line) => line.i * 2 ** line.l < chat.total)
  return [{ type: 'text', text: lines.map((line) => render(line, chat)).join('\n') }]
}

export const date = (chat: Chat, id: number): string => {
  if (!Number.isInteger(id) || id < 0 || id >= chat.total) return `There is no message ${id}.`
  const when = new Date(chat.date(id))
  return when.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })
}

const view = (chat: Chat): string =>
  chatBlocks(chat.rendered()).blocks.map((block) => block['text']).join('')

const tools = (chat: Chat, imports: Imports, path: string, input: Record<string, unknown>): Response | undefined => {
  if (path === '/zoom') return Response.json({ content: zoom(chat, input as { id: number | string; n?: number; at?: number }) })
  if (path === '/date') return Response.json({ text: date(chat, Number(input['id'])) })
  if (path === '/view') return Response.json({ text: view(chat) })
  if (path === '/imported') return Response.json(imports.state())
  if (path === '/import') return Response.json({ messages: imports.add(input['sessions'] as Imported[]) })
  return undefined
}

const bodyOf = (request: Request): Promise<Record<string, unknown> | undefined> =>
  request.json().then((input) => input as Record<string, unknown>, () => undefined)

const notJson = (request: Request): Response => {
  console.error(`totalrecall: ${request.method} ${new URL(request.url).pathname} from ${request.headers.get('user-agent') ?? 'an unnamed client'} sent no JSON body`)
  return new Response('The body must be JSON.', { status: 400 })
}

const serve = async (folder: string): Promise<void> => {
  mkdirSync(folder, { recursive: true })
  lock(folder)
  const chat = new Chat(folder)
  const compactor = new Compactor(chat, new Pool(poolUrl()), `${PLUGIN}-compaction`)
  const sessions = new Sessions(join(folder, 'sessions'))
  const imports = new Imports(chat, sessions, join(folder, 'imported.json'))
  const filter = new Filter(chat, compactor, sessions, (session) => imports.has(session))
  chat.listen(compactor)
  const error = (failure: Error): Response => {
    console.error(`totalrecall: ${failure.message}`)
    return new Response(failure.message, { status: 500 })
  }
  Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    async fetch(request, server) {
      server.timeout(request, 0)
      const url = new URL(request.url)
      const input = await bodyOf(request)
      if (input === undefined) return notJson(request)
      const answer = tools(chat, imports, url.pathname, input)
      if (answer !== undefined) return answer
      if (url.pathname === '/strip' && 'request' in input) return Response.json(filter.strip(input['request'] as FilteredRequest))
      if (url.pathname !== '/on') return new Response('No such route.', { status: 404 })
      if ('request' in input) return Response.json(await filter.request(url.searchParams.get('device') ?? '', input['request'] as FilteredRequest))
      if ('response' in input) return Response.json(filter.response(input['response'] as FilteredResponse))
      return Response.json({})
    },
    error,
  })
  const { addresses } = await poolAddresses()
  for (const address of addresses.filter((each) => !isLoopback(each))) {
    Bun.serve({
      hostname: address,
      port: PORT,
      async fetch(request) {
        const input = await bodyOf(request)
        if (input === undefined) return notJson(request)
        const answer = tools(chat, imports, new URL(request.url).pathname, input)
        return answer ?? new Response('Only zoom, date, view, imported, and import answer here.', { status: 404 })
      },
      error,
    })
  }
  console.log(`totalrecall serves the chat in ${folder} on port ${PORT}, beside the pool at ${poolUrl()}.`)
}

const isLoopback = (address: string): boolean => address === '::1' || address.startsWith('127.')

const program = (path: string, body: object): Promise<unknown> => {
  const host = new URL(poolUrl()).hostname
  const url = `http://${host}:${PORT}${path}`
  return fetch(url, { method: 'POST', body: JSON.stringify(body) }).then(async (response) => {
    if (!response.ok) throw new Error(`${url} answered ${response.status}: ${await response.text()}`)
    return response.json()
  })
}

const [command, argument] = process.argv.slice(2)
if (command === '--version') console.log(VERSION)
else if (command === 'serve' && argument !== undefined) await serve(argument)
else if (command === 'service' && argument === 'install' && process.argv[4] !== undefined) await install(process.argv[4])
else if (command === 'service' && argument === 'remove') remove()
else if (command === 'import') {
  await runImport(process.argv.slice(3), program, (line) => console.log(line), AT_ONCE).catch((error: unknown) => {
    console.error(`totalrecall import: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
} else {
  console.error('Usage: totalrecall serve <data folder> | totalrecall service install <data folder> | totalrecall service remove | totalrecall import [since <YYYY-MM-DD>] [tools] [<export>…] [go]')
  process.exit(2)
}
