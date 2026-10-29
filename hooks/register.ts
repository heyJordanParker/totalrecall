import type { On, PluginOptions } from 'claude-code'
import { registerMod } from '../node_modules/@cmodjs/core/register.js'
import { totalrecall } from '../src/mod.js'

export function register(addHook: On, options: PluginOptions): void {
  registerMod(addHook, totalrecall, options)
}
