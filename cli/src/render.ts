import type { Block } from './pool.ts'

export const CACHE = { type: 'ephemeral', ttl: '1h' } as const

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

const unmarked = (block: Block): Block => {
  const { cache_control: _dropped, ...rest } = block
  return rest
}

export type Place = { readonly message: number; readonly block: number }

export const mark = <M extends { role: string; content: Block[] }>(messages: readonly M[], places: readonly Place[]): M[] => {
  const marked = messages.map((message) => ({ ...message, content: message.content.map(unmarked) }))
  const last = marked.length - 1
  for (const { message, block } of [...places, { message: last, block: (marked[last]?.content.length ?? 0) - 1 }]) {
    const content = marked[message]?.content
    if (content?.[block] !== undefined) content[block] = { ...content[block], cache_control: CACHE }
  }
  return marked
}
