import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'

// Minimal JSON settings store (avoids an ESM-only dependency in a CJS main).

let cache: Settings | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): Settings {
  if (cache) return cache
  try {
    if (existsSync(filePath())) {
      const parsed = JSON.parse(readFileSync(filePath(), 'utf8')) as Partial<Settings>
      cache = { ...DEFAULT_SETTINGS, ...parsed }
    } else {
      cache = { ...DEFAULT_SETTINGS }
    }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export const store = {
  get(): Settings {
    return load()
  },
  set(partial: Partial<Settings>): Settings {
    const next = { ...load(), ...partial }
    cache = next
    try {
      writeFileSync(filePath(), JSON.stringify(next, null, 2))
    } catch (err) {
      console.error('[store] failed to persist settings:', err)
    }
    return next
  },
}
