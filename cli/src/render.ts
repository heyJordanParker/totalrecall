import type { Block } from './pool.ts'

export type CacheMark = { readonly type: 'ephemeral'; readonly ttl?: '5m' | '1h' }

export const CACHE: CacheMark = { type: 'ephemeral' }

export type ChatBlocks = { readonly blocks: Block[]; readonly marked: number }

export const chatBlocks = (lines: readonly string[]): ChatBlocks => {
  const blocks: Block[] = []
  const whole = Math.floor(lines.length / 4)
  for (let k = 0; k < whole; k += 1) {
    blocks.push({ type: 'text', text: `${k === 0 ? '<chat>\n' : ''}${lines.slice(4 * k, 4 * k + 4).join('\n')}\n` })
  }
  const rest = lines.slice(4 * whole)
  blocks.push({ type: 'text', text: `${whole === 0 ? '<chat>\n' : ''}${rest.map((line) => `${line}\n`).join('')}</chat>` })
  return { blocks, marked: whole - 1 }
}

export const unmarked = (block: Block): Block => {
  const { cache_control: _dropped, ...rest } = block
  return rest
}

export const markedEnd = (blocks: readonly Block[], cache: CacheMark): Block[] => blocks.map((block, k) => (k === blocks.length - 1 ? { ...unmarked(block), cache_control: cache } : unmarked(block)))

export type Place = { readonly message: number; readonly block: number }

export const mark = <M extends { role: string; content: Block[] }>(messages: readonly M[], places: readonly Place[], cache: CacheMark): M[] => {
  const marked = messages.map((message) => ({ ...message, content: message.content.map(unmarked) }))
  for (const { message, block } of places) {
    const content = marked[message]?.content
    if (content?.[block] !== undefined) content[block] = { ...content[block], cache_control: cache }
  }
  return marked
}
