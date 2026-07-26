import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type QuickStart, type Settings } from '@shared/ipc'

// Named settings snapshots ("quick starts"), persisted next to settings.json.

let cache: QuickStart[] | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'quickstarts.json')
}

function load(): QuickStart[] {
  if (cache) return cache
  try {
    if (existsSync(filePath())) {
      const parsed = JSON.parse(readFileSync(filePath(), 'utf8')) as QuickStart[]
      // Merge defaults so presets survive future Settings fields.
      cache = parsed.map((q) => ({ ...q, settings: { ...DEFAULT_SETTINGS, ...q.settings } }))
    } else {
      cache = []
    }
  } catch {
    cache = []
  }
  return cache
}

function persist(next: QuickStart[]): QuickStart[] {
  cache = next
  try {
    writeFileSync(filePath(), JSON.stringify(next, null, 2))
  } catch (err) {
    console.error('[quickstarts] failed to persist:', err)
  }
  return next
}

export function listQuickStarts(): QuickStart[] {
  return load()
}

/** Add or replace (by name) a quick start. Returns the updated list. */
export function saveQuickStart(name: string, settings: Settings): QuickStart[] {
  const clean = name.trim().slice(0, 30)
  if (!clean) return load()
  const rest = load().filter((q) => q.name !== clean)
  return persist([...rest, { name: clean, settings }])
}

export function deleteQuickStart(name: string): QuickStart[] {
  return persist(load().filter((q) => q.name !== name))
}
