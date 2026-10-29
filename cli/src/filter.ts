import type { Chat } from './chat.ts'
import type { Compactor } from './compactor.ts'
import { blocksOf, isCompaction, isContext, itemsOf, turnStart, type ApiMessage, type Item } from './history.ts'
import { Accumulator, type Block, type StreamEvent } from './pool.ts'
import { SYSTEM } from './prompt.ts'
import { chatBlocks, mark, type Place } from './render.ts'
import type { Sessions } from './sessions.ts'
import { render } from './view.ts'

export const PLUGIN = 'totalrecall'
export const OWN_TOOLS = { zoom: `mcp__${PLUGIN}__zoom`, date: `mcp__${PLUGIN}__date` } as const
const MESSAGES = '/v1/messages'
const COUNT_TOKENS = '/v1/messages/count_tokens'
const STATE_BLOCKS = new Set(['tool_addition', 'tool_removal'])

export type FilteredRequest = { id: string; path: string; headers: Record<string, string>; body: unknown }
export type FilteredResponse = { id: string; body: unknown; endOfStream: boolean }
export type RequestAnswer = { headers?: Record<string, string | null>; body?: unknown }
export type ResponseAnswer = { body?: unknown; clearBody?: true }

export type Tool = { name: string; cache_control?: unknown; [field: string]: unknown }
type Body = { system?: string | Block[]; tools?: Tool[]; messages?: ApiMessage[]; metadata?: unknown; [field: string]: unknown }
type Pending = { readonly history: string; readonly isMain: boolean; readonly device: string; readonly reply: Accumulator }
type Span = { readonly from: number; readonly to: number }

const unmarked = (block: Block): Block => {
  const { cache_control: _dropped, ...rest } = block
  return rest
}

const isOwn = (tool: unknown): boolean => tool === OWN_TOOLS.zoom || tool === OWN_TOOLS.date

const isOwnAddition = (block: Block): boolean => {
  if (block.type !== 'tool_addition') return false
  const tool = block['tool'] as { definition?: Block; name?: string } | undefined
  return isOwn(tool?.definition?.['name'] ?? tool?.name)
}

const withPrompt = (system: string | Block[] | undefined): Block[] => {
  const blocks = (typeof system === 'string' ? [{ type: 'text', text: system }] : (system ?? [])).map(unmarked)
  const opening = blocks.findIndex((block) => /^You are (Claude Code|a Claude agent)/.test(String(block['text'] ?? '')))
  const at = opening !== -1 ? opening + 1 : blocks.findIndex((block) => String(block['text'] ?? '').startsWith('x-anthropic-billing-header')) + 1
  return [...blocks.slice(0, at), { type: 'text', text: SYSTEM }, ...blocks.slice(at)]
}

const loadedTools = (block: Block): Block[] => {
  const content = block['content']
  if (!Array.isArray(content)) return []
  return (content as Block[])
    .filter((part) => part.type === 'tool_reference')
    .map((part) => ({ type: 'tool_addition', tool: { type: 'tool_reference', name: part['tool_name'] ?? part['name'] } }))
}

const instructionsOf = (messages: readonly ApiMessage[]): Block[] => {
  const preamble = messages[1]?.role === 'system' ? blocksOf(messages[1]!) : []
  return [...blocksOf(messages[0]!).filter(isContext), ...preamble.filter((block) => !STATE_BLOCKS.has(block.type))]
}

const toolsOf = (request: Body): Tool[] => request.tools!.map(({ cache_control: _dropped, ...tool }) => tool as Tool)

const joined = (messages: ApiMessage[]): ApiMessage[] => {
  const out: { role: string; content: Block[] }[] = []
  for (const message of messages) {
    const previous = out.at(-1)
    if (previous !== undefined && previous.role === message.role && message.role !== 'assistant') previous.content.push(...blocksOf(message))
    else out.push({ role: message.role, content: [...blocksOf(message)] })
  }
  return out
}

export class Filter {
  private readonly pending = new Map<string, Pending>()
  private readonly turnViews = new Map<string, string[]>()
  private readonly joining = new Map<string, Span>()
  private readonly passing = new Set<string>()

  constructor(
    private readonly chat: Chat,
    private readonly compactor: Compactor,
    private readonly sessions: Sessions,
    private readonly waitMs = 100_000,
  ) {}

  async request(device: string, { id, path, headers, body }: FilteredRequest): Promise<RequestAnswer> {
    const session = headers['x-claude-code-session-id']
    const request = body as Body
    if (session === undefined || !Array.isArray(request.messages) || request.messages.length === 0) return {}
    const agent = headers['x-claude-code-agent-id']
    const history = agent === undefined || agent === 'main' ? session : `${session}/${agent}`
    const isMain = history === session
    if (path === MESSAGES && isCompaction(request.messages)) {
      const items = this.itemsIn(device, request.messages).flat()
      this.logFrom(history, isMain, items, this.matched(history, items))
      return {}
    }
    if (!Array.isArray(request.tools) || request.tools.length === 0) return {}
    if (path === COUNT_TOKENS) {
      return this.passing.has(history) ? {} : { body: this.rewrite(request, this.turnViews.get(history) ?? this.renderView(), isMain, device) }
    }
    if (path !== MESSAGES) return {}
    if (isMain) {
      const instructions = instructionsOf(request.messages)
      this.compactor.useTemplate({
        headers,
        system: withPrompt(request.system),
        tools: toolsOf(request),
        instructions: instructions.length === 0 ? [] : [{ role: 'user', content: instructions }],
        metadata: request.metadata,
      })
    }
    const view = await this.ingest(history, isMain, device, request.messages)
    this.pending.set(id, { history, isMain, device, reply: new Accumulator() })
    return view === undefined ? {} : { body: this.rewrite(request, view, isMain, device) }
  }

  response({ id, body, endOfStream }: FilteredResponse): ResponseAnswer {
    const pending = this.pending.get(id)
    if (pending === undefined) return {}
    const event = body as StreamEvent & { content?: Block[] }
    if (event.type === 'message' && Array.isArray(event.content)) {
      for (const block of event.content) pending.reply.add({ type: 'content_block_start', index: pending.reply.content.length, content_block: block })
    } else {
      pending.reply.add(event)
    }
    if (endOfStream) {
      this.pending.delete(id)
      this.logReply(pending)
    }
    return {}
  }

  strip({ body }: FilteredRequest): RequestAnswer {
    const request = body as Body
    if (!Array.isArray(request.messages)) return {}
    const tools = request.tools?.filter((tool) => !isOwn(tool['name']))
    const messages = request.messages
      .map((message) => ({ role: message.role, content: blocksOf(message).filter((block) => !isOwnAddition(block)) }))
      .filter((message) => message.content.length > 0)
    const changed = tools?.length !== request.tools?.length || messages.length !== request.messages.length || messages.some((message, index) => message.content.length !== blocksOf(request.messages![index]!).length)
    return changed ? { body: { ...request, ...(tools === undefined ? {} : { tools }), messages } } : {}
  }

  private renderView(): string[] {
    return this.chat.view.lines.map((line) => render(line, this.chat))
  }

  private log(history: string, isMain: boolean, item: Item): void {
    if (isMain) this.chat.log(item.kind, item.text, item.images)
    else this.chat.logAgent(history.split('/')[1]!, item.kind, item.text, item.images)
  }

  private logFrom(history: string, isMain: boolean, items: readonly Item[], from: number): void {
    const fresh = items.slice(from)
    for (const item of fresh) this.log(history, isMain, item)
    this.sessions.keep(history, fresh.map((item) => item.key), from)
  }

  private matched(history: string, items: readonly Item[]): number {
    const kept = this.sessions.keys(history)
    let same = 0
    while (same < items.length && same < kept.length && items[same]!.key === kept[same]) same += 1
    return same
  }

  private itemsIn(device: string, messages: readonly ApiMessage[]): Item[][] {
    const calls = new Map<string, Block>()
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const block of blocksOf(message)) if (block.type === 'tool_use') calls.set(String(block['id']), block)
    }
    return messages.map((message) => itemsOf(message, device, (id) => calls.get(id), this.chat))
  }

  private logReply(pending: Pending): void {
    const items = itemsOf({ role: 'assistant', content: pending.reply.content }, pending.device, () => undefined, this.chat)
    if (items.length === 0) return
    for (const item of items) this.log(pending.history, pending.isMain, item)
    this.sessions.keep(pending.history, items.map((item) => item.key), this.sessions.keys(pending.history).length)
    if (pending.isMain) this.compactor.retryFailed()
  }

  private async ingest(history: string, isMain: boolean, device: string, messages: ApiMessage[]): Promise<string[] | undefined> {
    const start = turnStart(messages)
    const items = this.itemsIn(device, messages)
    const before = items.slice(0, start).flat()
    const all = [...before, ...items.slice(start).flat()]
    const same = this.matched(history, all)
    const isFirstRequest = !messages.slice(start + 1).some((message) => message.role === 'assistant')
    if (!isFirstRequest || !isMain) {
      this.logFrom(history, isMain, all, same)
      if (same < all.length && isMain) this.compactor.retryFailed()
      if (this.passing.has(history)) return undefined
      if (!this.turnViews.has(history)) this.turnViews.set(history, this.renderView())
      return this.turnViews.get(history)!
    }
    const known = this.turnViews.get(history)
    if (same > before.length && known !== undefined) {
      this.logFrom(history, isMain, all, same)
      return this.passing.has(history) ? undefined : known
    }
    const logged = Math.min(same, before.length)
    if (logged < before.length) {
      const from = this.chat.total
      this.logFrom(history, isMain, before, logged)
      this.joining.set(history, { from, to: this.chat.total })
    }
    const joining = this.joining.get(history)
    const turnFrom = Math.max(same, before.length)
    if (joining !== undefined && !this.compactor.isSummarized(joining.from, joining.to)) {
      this.passing.add(history)
      this.turnViews.delete(history)
      this.logFrom(history, isMain, all, turnFrom)
      return undefined
    }
    this.joining.delete(history)
    this.passing.delete(history)
    await Promise.race([this.compactor.whenSummarized(this.chat.total), Bun.sleep(this.waitMs)])
    const view = this.renderView()
    this.turnViews.set(history, view)
    this.logFrom(history, isMain, all, turnFrom)
    this.compactor.retryFailed()
    return view
  }

  private rewrite(request: Body, viewLines: string[], isMain: boolean, device: string): Body {
    const messages = request.messages!
    const view = chatBlocks(viewLines)
    const start = isMain ? turnStart(messages) : 0
    const opening = blocksOf(messages[0]!)
    const opensWithSystem = isMain && messages[1]?.role === 'system'
    const preamble = opensWithSystem ? blocksOf(messages[1]!) : []
    const instructions = isMain ? instructionsOf(messages) : []
    const state = preamble.filter((block) => STATE_BLOCKS.has(block.type))
    for (let index = opensWithSystem ? 2 : 1; index < start; index += 1) {
      for (const block of blocksOf(messages[index]!)) {
        if (STATE_BLOCKS.has(block.type)) state.push(block)
        else if (block.type === 'tool_result') state.push(...loadedTools(block))
      }
    }
    const turn = start > 0 ? blocksOf(messages[start]!) : isMain ? opening.filter((block) => !isContext(block)) : opening
    const rest = messages.slice(start === 0 && opensWithSystem ? 2 : start + 1)
    const places: Place[] = instructions.length === 0 ? [] : [{ message: 0, block: instructions.length - 1 }]
    if (view.marked >= 0) places.push({ message: 0, block: instructions.length + view.marked })
    const here = { type: 'text', text: `device: ${device}` }
    const out: { role: string; content: Block[] }[] = [{ role: 'user', content: [...instructions, ...view.blocks, here, ...turn] }]
    for (const message of joined([...(state.length > 0 ? [{ role: 'system', content: state }] : []), ...rest])) {
      const previous = out.at(-1)!
      if (previous.role === message.role && message.role !== 'assistant') previous.content.push(...blocksOf(message))
      else out.push({ role: message.role, content: [...blocksOf(message)] })
    }
    return { ...request, system: withPrompt(request.system), tools: toolsOf(request), messages: mark(out, places) }
  }
}
