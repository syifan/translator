import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The OpenAI API key never leaves the main process. We persist it encrypted via
// the OS keychain (safeStorage). getKey() is intentionally NOT exposed over IPC.

const PLAIN_PREFIX = 'plain:'

function keyPath(): string {
  return join(app.getPath('userData'), 'openai-key.bin')
}

export function hasKey(): boolean {
  return existsSync(keyPath())
}

export function setKey(key: string): boolean {
  const trimmed = key?.trim()
  if (!trimmed) {
    clearKey()
    return false
  }
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(keyPath(), safeStorage.encryptString(trimmed))
  } else {
    // Fallback (should not happen on macOS): store with a marker prefix.
    writeFileSync(keyPath(), Buffer.from(PLAIN_PREFIX + trimmed, 'utf8'))
  }
  return true
}

export function getKey(): string | null {
  if (!existsSync(keyPath())) return null
  const buf = readFileSync(keyPath())
  if (buf.subarray(0, PLAIN_PREFIX.length).toString('utf8') === PLAIN_PREFIX) {
    return buf.subarray(PLAIN_PREFIX.length).toString('utf8')
  }
  try {
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export function clearKey(): boolean {
  if (existsSync(keyPath())) rmSync(keyPath())
  return true
}
