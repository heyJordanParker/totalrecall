import type { Image, Kind } from './chat.ts'
import type { Block } from './pool.ts'

export type ApiMessage = { role: string; content: string | Block[] }

export type Item = {
  readonly key: string
  readonly kind: Kind
  readonly text: string
  readonly images: readonly Image[]
}

export const TOOL_OUTPUT_CHARACTERS = 30_000
export const AGENT_TOOLS = new Set(['Agent', 'Task'])

const CONTEXT = /^\s*<(system-reminder|command-name|local-command-caveat|local-command-stdout|local-command-stderr|[a-z0-9-]+_mod)>/

const textOf = (block: Block | undefined): string => String(block?.['text'] ?? '')

export const blocksOf = (message: ApiMessage): Block[] =>
  typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content

export const isContext = (block: Block): boolean => block.type === 'text' && CONTEXT.test(textOf(block))

const COMPACTION_TASK = 'Your task is to create a detailed summary of the conversation so far'
const CONTINUED = /^\s*This session is being continued from a previous conversation/

const isCompactionText = (block: Block): boolean =>
  block.type === 'text' && (textOf(block).includes(COMPACTION_TASK) || CONTINUED.test(textOf(block)))

export const isCompaction = (messages: readonly ApiMessage[]): boolean => {
  const last = messages.at(-1)
  return last?.role === 'user' && blocksOf(last).some((block) => block.type === 'text' && textOf(block).includes(COMPACTION_TASK))
}

const TOOL_LOADED = 'Tool loaded.'
const NOTICE = /<task-notification>\s*<task-id>([^<]+)<\/task-id>[\s\S]*<\/task-notification>/
const RESULT = /<result>([\s\S]*)<\/result>/
const LAUNCHED = 'Async agent launched successfully'

const isNotice = (block: Block): boolean => block.type === 'text' && NOTICE.test(textOf(block))

const NOTIFICATION = /^\s*<task-notification>/

const isWords = (block: Block): boolean =>
  block.type === 'text' &&
  !isContext(block) &&
  !isCompactionText(block) &&
  !isNotice(block) &&
  !NOTIFICATION.test(textOf(block)) &&
  textOf(block).trim() !== '' &&
  textOf(block).trim() !== TOOL_LOADED

export const wordsOf = (blocks: readonly Block[]): Block[] => blocks.filter(isWords)

const MID_TURN = /^The user sent a new message while you were working:\n([\s\S]*)\n\nThis is how Claude Code surfaces messages the user sends mid-turn\b[^\n]*$/

const wordsIn = (text: string): string => MID_TURN.exec(text)?.[1] ?? text

const PROMPT_COMMAND = /^\s*<command-message>[^<]*<\/command-message>\s*<command-name>([^<]+)<\/command-name>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/

const typedCommand = (blocks: readonly Block[]): string | undefined => {
  for (const block of blocks) {
    const command = block.type === 'text' ? PROMPT_COMMAND.exec(textOf(block)) : null
    if (command !== null) return `${command[1]} ${command[2] ?? ''}`.trim()
  }
  return undefined
}

const cutMarker = (cut: number): string => `\n[… ${cut} characters cut …]\n`

export const clip = (text: string): string => {
  if (text.length <= TOOL_OUTPUT_CHARACTERS) return text
  const kept = TOOL_OUTPUT_CHARACTERS - cutMarker(text.length).length
  const head = Math.ceil(kept / 2)
  return `${text.slice(0, head)}${cutMarker(text.length - kept)}${text.slice(text.length - (kept - head))}`
}

const resultText = (block: Block): string => {
  const content = block['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .filter((part) => !isContext(part))
    .map((part) => (part.type === 'text' ? textOf(part) : part.type === 'tool_reference' ? `[loaded ${String(part['tool_name'])}]` : `[${part.type}]`))
    .join('\n')
}

const imageOf = (block: Block): Image | undefined => {
  const source = block['source'] as { type?: string; media_type?: string; data?: string } | undefined
  return (block.type === 'image' || block.type === 'document') && source?.type === 'base64' && source.media_type !== undefined && source.data !== undefined
    ? { media_type: source.media_type, data: source.data }
    : undefined
}

const imagesOf = (blocks: readonly Block[]): Image[] => blocks.map(imageOf).filter((image) => image !== undefined)

export const imageBlock = (image: Image): Block => ({
  type: image.media_type.startsWith('image/') ? 'image' : 'document',
  source: { type: 'base64', media_type: image.media_type, data: image.data },
})

const hash = (value: unknown): string => String(Bun.hash(JSON.stringify(value)))

export type AgentNames = {
  nameAgent(id: string, task: string): string
  agentName(id: string): string | undefined
}

const AGENT_ID = /agentId:\s*([\w-]+)/

const report = (name: string, text: string, isLogged: boolean): string =>
  isLogged ? `[${name}] ${text}\n\nFull chat: mcp__totalrecall__zoom("${name}")` : `[${name}] ${text}`

const noticeOf = (block: Block, agents: AgentNames): Item => {
  const notice = NOTICE.exec(textOf(block))!
  const text = notice[0]
  const result = RESULT.exec(text)?.[1]
  const name = agents.agentName(notice[1]!)
  return result === undefined
    ? { key: `echo:${hash(text)}`, kind: 'echo', text: clip(text), images: [] }
    : { key: `work:${hash(text)}`, kind: 'work', text: report(name ?? notice[1]!, result, name !== undefined), images: [] }
}

const resultOf = (block: Block, call: Block | undefined, agents: AgentNames): Item => {
  const id = String(block['tool_use_id'])
  const text = resultText(block)
  const images = Array.isArray(block['content']) ? imagesOf(block['content'] as Block[]) : []
  const agent = AGENT_TOOLS.has(String(call?.['name'])) ? AGENT_ID.exec(text)?.[1] : undefined
  const name = agent === undefined ? undefined : agents.nameAgent(agent, (call!['input'] as { description: string }).description)
  if (name !== undefined && !text.startsWith(LAUNCHED)) return { key: `echo:${id}`, kind: 'work', text: report(name, text, agents.agentName(agent!) !== undefined), images }
  return { key: `echo:${id}`, kind: 'echo', text: clip(block['is_error'] === true ? `error: ${text}` : text), images }
}

const endsTurn = (messages: readonly ApiMessage[], index: number): boolean => {
  let before = index - 1
  while (before >= 0 && messages[before]!.role === 'system') before -= 1
  const message = messages[before]
  return message?.role === 'assistant' && !blocksOf(message).some((block) => block.type === 'tool_use')
}

export const itemsOf = (message: ApiMessage, device: string, callOf: (id: string) => Block | undefined, agents: AgentNames): Item[] => {
  const items: Item[] = []
  const blocks = blocksOf(message)
  if (message.role === 'assistant') {
    for (const block of blocks) {
      if (block.type === 'text' && textOf(block).trim() !== '') {
        items.push({ key: `claude:${hash(block['text'])}`, kind: 'claude', text: textOf(block), images: [] })
      }
      if (block.type === 'tool_use') {
        const text = `${String(block['name'])} ${JSON.stringify({ ...(block['input'] as object | undefined), device })}`
        items.push({ key: `tool:${String(block['id'])}`, kind: 'tool', text, images: [] })
      }
    }
    return items
  }
  if (message.role === 'system') return blocks.filter(isNotice).map((block) => noticeOf(block, agents))
  if (message.role !== 'user') return items
  for (const block of blocks) if (block.type === 'tool_result') items.push(resultOf(block, callOf(String(block['tool_use_id'])), agents))
  for (const block of blocks) if (isNotice(block)) items.push(noticeOf(block, agents))
  const images = imagesOf(blocks)
  const command = typedCommand(blocks)
  const words = command === undefined ? wordsOf(blocks).map((block) => wordsIn(textOf(block))) : [command]
  if (words.length > 0 || images.length > 0) {
    const text = words.join('\n\n')
    items.push({ key: `user:${hash([text, images.length])}`, kind: 'user', text, images })
  }
  return items
}

export const turnStart = (messages: readonly ApiMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    const blocks = blocksOf(message)
    if (blocks.some(isNotice) && endsTurn(messages, index)) return index
    if (message.role !== 'user') continue
    if (blocks.some((block) => block.type === 'tool_result')) continue
    if (wordsOf(blocks).length > 0 || blocks.some((block) => block.type === 'image')) return index
  }
  return 0
}
