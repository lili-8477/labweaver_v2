// Hosts the browser halves of dsh plugins, the way dsh's own web UI does, so
// a plugin installed with `dsh plugin --profile acp add <pkg>` can draw into
// LabWeaver. The adapter returns each bundle (dsh_client_modules); a bundle is
// one `window.__ModuleLoader__.load({ id, factory })` call whose factory gets
// a `require` that resolves only `react`, and exports a Cordis client plugin
// `{ apply(ctx), inject? }`.
//
// ctx is the restricted face dsh hands client plugins, covering the services
// LabWeaver can back today:
//   slots  — inject/register; contributions land in `slotEntries`, which
//            <DshSlot name="..."> renders where LabWeaver has that slot
//   locale — English only; plugin dictionaries resolve through bind()
//   effect — disposers owned by the plugin
// A plugin that injects any other service is skipped with a warning.
//
// Bundles run in the page with full page privileges, like in dsh's web UI:
// only plugins the user installed into their own profile are loaded.

import * as React from 'react'
import { markRaw, reactive } from 'vue'
import { natsService } from '@/services/nats'

type Disposer = () => void

export interface SlotEntry {
  plugin:    string
  id:        string
  order:     number
  component: React.ComponentType
}

interface ClientPlugin {
  apply:   (ctx: unknown) => void
  inject?: string[] | Record<string, unknown>
}

interface ModuleEntry {
  id:      string
  factory: (require: (id: string) => unknown) => ClientPlugin
}

const SERVICES = ['slots', 'locale']
const LOCALE = { active: 'en', locales: [{ id: 'en', label: 'English' }] }

/** Contributions per slot name, in ascending order. */
export const slotEntries = reactive<Record<string, SlotEntry[]>>({})

const dictionaries = new Map<string, Record<string, string>>() // `${ns}:${locale}` -> dict
const localeListeners = new Set<() => void>()
let localeRevision = 0
let loaded: Promise<void> | null = null

function changed() {
  localeRevision++
  for (const fn of localeListeners) fn()
}

const locale = {
  getLocale: () => ({ ...LOCALE, revision: localeRevision }),
  subscribe(fn: () => void): Disposer {
    localeListeners.add(fn)
    return () => { localeListeners.delete(fn) }
  },
  register(ns: string, id: string, dict: Record<string, string>): Disposer {
    const key = `${ns}:${id}`
    dictionaries.set(key, dict)
    changed()
    return () => { dictionaries.delete(key); changed() }
  },
  bind: (ns: string) => (key: string): string =>
    dictionaries.get(`${ns}:${LOCALE.active}`)?.[key] ?? key,
}

function contextFor(plugin: string) {
  const slots = {
    // LabWeaver declares its slots up front, so there is nothing to wait for.
    inject(_slot: string, callback: () => Disposer | readonly Disposer[]): Disposer {
      const out = callback()
      return () => { for (const d of Array.isArray(out) ? out : [out]) (d as Disposer)() }
    },
    register(opts: { name: string; id: string; order?: number }, component: React.ComponentType): Disposer {
      const entry: SlotEntry = { plugin, id: opts.id, order: opts.order ?? 0, component: markRaw(component) }
      const list = (slotEntries[opts.name] ??= [])
      list.push(entry)
      list.sort((a, b) => a.order - b.order)
      return () => {
        const i = list.indexOf(entry)
        if (i >= 0) list.splice(i, 1)
      }
    },
  }
  return {
    slots,
    locale,
    effect(callback: () => Disposer | void): Disposer {
      const d = callback()
      return typeof d === 'function' ? d : () => {}
    },
  }
}

/** Evaluate one bundle and return its single registration. */
function evaluate(code: string): ModuleEntry {
  const captured: ModuleEntry[] = []
  const w = window as unknown as { __ModuleLoader__?: { load: (e: ModuleEntry) => void } }
  const prev = w.__ModuleLoader__
  w.__ModuleLoader__ = { load: (e) => { captured.push(e) } }
  try {
    new Function(code)()
  } finally {
    w.__ModuleLoader__ = prev
  }
  if (captured.length !== 1) throw new Error(`expected one module registration, got ${captured.length}`)
  return captured[0]
}

function requireBaseline(id: string): unknown {
  if (id === 'react') return React
  throw new Error(`module "${id}" is not available to dsh client plugins`)
}

async function load(): Promise<void> {
  const res = await natsService.invoke('dsh_client_modules', {}) as { modules?: { id: string; code: string }[] }
  for (const mod of res.modules ?? []) {
    try {
      const plugin = evaluate(mod.code).factory(requireBaseline)
      const wants = Array.isArray(plugin.inject) ? plugin.inject : Object.keys(plugin.inject ?? {})
      const missing = wants.filter((s) => !SERVICES.includes(s))
      if (missing.length > 0) {
        console.warn(`[dsh-client] ${mod.id} needs services LabWeaver does not provide: ${missing.join(', ')}`)
        continue
      }
      plugin.apply(contextFor(mod.id))
    } catch (e) {
      console.warn(`[dsh-client] ${mod.id} failed to load:`, e)
    }
  }
}

/** Load the installed plugins once per page; later calls share the first load. */
export function loadDshClientModules(): Promise<void> {
  loaded ??= load().catch((e) => {
    console.warn('[dsh-client] listing plugins failed:', e)
    loaded = null // retry on the next call
  })
  return loaded
}
