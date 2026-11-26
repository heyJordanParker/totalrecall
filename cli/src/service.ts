import { lookup } from 'node:dns/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

export const PORT = 8320
const LOCAL_POOL = 'http://127.0.0.1:8317'

const settingsPool = (): string | undefined => {
  const path = join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'settings.json')
  if (!existsSync(path)) return undefined
  const settings = JSON.parse(readFileSync(path, 'utf8')) as { env?: Record<string, string> }
  return settings.env?.['ANTHROPIC_BASE_URL']
}

export const poolUrl = (): string => process.env['ANTHROPIC_BASE_URL'] || settingsPool() || LOCAL_POOL

const ownAddresses = (): Set<string> =>
  new Set(Object.values(networkInterfaces()).flatMap((addresses) => (addresses ?? []).map((address) => address.address)))

export const poolAddresses = async (): Promise<{ addresses: string[]; isHere: boolean }> => {
  const host = new URL(poolUrl()).hostname.replace(/^\[|\]$/g, '')
  const own = ownAddresses()
  const addresses = (await lookup(host, { all: true })).map((found) => found.address).filter((address) => own.has(address))
  return { addresses, isHere: addresses.length > 0 }
}
