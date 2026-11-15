import { registerMod, type AddHook, type PluginOptions } from '../node_modules/@cmodjs/core/register.js'
import { totalrecall } from '../src/mod.js'

export function register(addHook: AddHook, options: PluginOptions): void {
  registerMod(addHook, totalrecall, options)
}
