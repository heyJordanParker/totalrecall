export const PAGE_CHARACTERS = 30_000

export const pageEnd = (text: string, at: number): number => {
  if (text.length - at <= PAGE_CHARACTERS) return text.length
  const newline = text.lastIndexOf('\n', at + PAGE_CHARACTERS - 1)
  if (newline >= at) return newline + 1
  const isLowSurrogate = text.charCodeAt(at + PAGE_CHARACTERS) >> 10 === 0x37
  return at + PAGE_CHARACTERS - (isLowSurrogate ? 1 : 0)
}

export const pages = (text: string): string[] => {
  const found: string[] = []
  let at = 0
  do {
    const end = pageEnd(text, at)
    found.push(text.slice(at, end))
    at = end
  } while (at < text.length)
  return found
}

export const page = (text: string, at: number): string => {
  const end = pageEnd(text, at)
  return end < text.length ? `${text.slice(at, end)}\n[characters ${at + 1}-${end} of ${text.length}; go on with at ${end}]` : text.slice(at, end)
}
