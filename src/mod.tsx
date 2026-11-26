import { commands, defineMod, device, http, sessions, settings } from '../node_modules/@cmodjs/core/mod.js'
import { program } from '../node_modules/@cmodjs/core/jobs/program.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { tool } from '../node_modules/@cmodjs/core/jobs/tool.js'
import { option } from '../node_modules/@cmodjs/core/options.js'
import { initialState } from './state.js'

const NAME = 'totalrecall'
const PORT = 8320
const LOCAL_POOL = 'http://127.0.0.1:8317'
const FILTER = `http://127.0.0.1:${PORT}`
const COMPACT_AT = 0.8

const poolHost = async (): Promise<string> => {
  const env = (await settings.user.read())['env']
  const base = typeof env === 'object' && env !== null ? (env as Record<string, unknown>)['ANTHROPIC_BASE_URL'] : undefined
  return new URL(typeof base === 'string' && base !== '' ? base : LOCAL_POOL).hostname
}

const keptTokens = async (): Promise<number> => {
  const turns = await (await sessions.current.context()).turns()
  const messages = (await Promise.all(turns.map((turn) => turn.messages()))).flat()
  return JSON.stringify(messages).length / 4
}

export const totalrecall = defineMod({
  name: NAME,
  state: initialState,
  options: {
    agents: option.list({ title: 'Agents with recall', description: 'Recall turns on by itself in every session that runs one of these agents, as claude --agent starts one', default: [] }),
  },

  setup(mod) {
    mod.use(program({ command: ['totalrecall', 'serve'], isService: true }))

    const post = async (path: string, input: object): Promise<unknown> => {
      const response = await http.fetch(`http://${await poolHost()}:${PORT}${path}`, { method: 'POST', body: JSON.stringify(input) })
      if (response.status !== 200) throw new Error(`${NAME}: the program answered ${response.status}: ${response.text}`)
      return JSON.parse(response.text)
    }

    let computer: string | undefined
    const deviceOf = async (): Promise<string> => {
      computer ??= (await device.read()).name
      return `${computer}:${sessions.current.cwd}`
    }

    const addTools = (): void => {
      if (mod.state.memory.hasTools) return
      mod.use(
        tool({
          name: 'zoom',
          description: 'Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. zoom("Name") gives an agent\'s whole chat.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: ['integer', 'string'], description: 'The first message of the line, or an agent\'s name' },
              n: { type: 'integer', description: 'How many messages the line covers: a power of 2' },
              at: { type: 'integer', description: 'Where to go on in a long message or agent chat, as its last page says' },
            },
            required: ['id'],
          },
          isDeferred: false,
          execute: async (input) => ((await post('/zoom', input)) as { content: unknown[] }).content,
        }),
      )
      mod.use(
        tool({
          name: 'date',
          description: 'The date and time of message id.',
          inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          isDeferred: false,
          execute: async (input) => ((await post('/date', input)) as { text: string }).text,
        }),
      )
      mod.state.memory.hasTools = true
    }

    const sync = async (isOn: boolean): Promise<void> => {
      if (isOn) {
        addTools()
        await mod.dependencies.oneclaude.addFilter({ name: NAME, url: `${FILTER}/on?device=${encodeURIComponent(await deviceOf())}`, responses: true, timeoutSeconds: 120, failOpen: true })
      } else if (mod.state.memory.hasTools) {
        await mod.dependencies.oneclaude.addFilter({ name: NAME, url: `${FILTER}/strip`, timeoutSeconds: 120, failOpen: true })
      } else {
        await mod.dependencies.oneclaude.removeFilter({ name: NAME })
      }
    }

    sessions.current.beforePrompt(async () => {
      await sync(mod.state.session.isOn)
      return undefined
    })

    sessions.current.beforeContextEnd(async () => {
      if (!mod.state.session.isOn) return undefined
      const view = await post('/view', {}).then((answer) => (answer as { text: string }).text, () => undefined)
      return view === undefined
        ? { refuse: 'Total recall can\'t reach its program, so a compaction now would drop turns the chat hasn\'t logged yet. Try again once it answers.' }
        : { summary: view }
    })

    sessions.current.onTurnEnd(async () => {
      if (!mod.state.session.isOn) return
      const { contextWindow } = await sessions.current.usage()
      if (contextWindow.size === undefined || (await keptTokens()) < contextWindow.size * COMPACT_AT) return
      await commands.run('compact')
    })

    mod.use(
      slashCommand({
        name: 'recall',
        description: 'Turn total recall on or off in this session',
        immediate: true,
        reply: async () => {
          const isOn = !mod.state.session.isOn
          await sync(isOn)
          mod.state.session.isOn = isOn
          return isOn ? 'Total recall is on. This session joins the one chat that never ends.' : 'Total recall is off in this session.'
        },
      }),
    )

    sessions.current.onSessionStart(async () => {
      const agent = sessions.current.agentType
      if (agent === undefined || !mod.options.agents.includes(agent) || mod.state.session.isOn) return
      await sync(true)
      mod.state.session.isOn = true
    })

    sync(mod.state.session.isOn).catch((error: unknown) => mod.log(`could not add the filter at start: ${String(error)}`))
  },
})
