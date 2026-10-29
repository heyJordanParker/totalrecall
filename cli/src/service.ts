import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'

export const PORT = 8320
const LOCAL_POOL = 'http://127.0.0.1:8317'
const UNIT = 'totalrecall'
const AGENT = 'com.totalrecall.serve'

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

const run = (argv: string[]): void => {
  const done = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
  if (done.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${done.stderr.toString().trim()}`)
}

const attempt = (argv: string[]): void => {
  Bun.spawnSync(argv, { stdout: 'ignore', stderr: 'ignore' })
}

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const unitPath = (): string => join(homedir(), '.config', 'systemd', 'user', `${UNIT}.service`)
const agentPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${AGENT}.plist`)
const domain = (): string => `gui/${process.getuid!()}`

const unit = (folder: string): string => `[Unit]
Description=totalrecall: the one chat every Claude Code session shares
After=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=${process.execPath} serve ${folder}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`

const agent = (folder: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>serve</string><string>${folder}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${join(folder, 'serve.log')}</string>
</dict>
</plist>
`

export const remove = (): void => {
  if (process.platform === 'darwin') {
    attempt(['launchctl', 'bootout', `${domain()}/${AGENT}`])
    rmSync(agentPath(), { force: true })
    return
  }
  attempt(['systemctl', '--user', 'disable', '--now', UNIT])
  rmSync(unitPath(), { force: true })
  attempt(['systemctl', '--user', 'daemon-reload'])
}

export const install = async (folder: string): Promise<void> => {
  const { isHere } = await poolAddresses()
  if (!isHere) {
    remove()
    console.log(`The pool at ${poolUrl()} runs on another machine, so its totalrecall serves this one.`)
    return
  }
  if (process.platform === 'darwin') {
    write(agentPath(), agent(folder))
    attempt(['launchctl', 'bootout', `${domain()}/${AGENT}`])
    run(['launchctl', 'bootstrap', domain(), agentPath()])
  } else {
    write(unitPath(), unit(folder))
    run(['systemctl', '--user', 'daemon-reload'])
    run(['systemctl', '--user', 'enable', UNIT])
    run(['systemctl', '--user', 'restart', UNIT])
    run(['loginctl', 'enable-linger'])
  }
  console.log(`totalrecall serves the chat on port ${PORT} beside the pool at ${poolUrl()}.`)
}
