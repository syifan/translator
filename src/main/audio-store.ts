import { app } from 'electron'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Per-note session audio (WAV chunks), kept so a note can be re-transcribed
// later (e.g. with a pinned language). Laid out as:
//   <userData>/audio/<note-stem>/<index>-<startMs>-<endMs>.wav

/** Total audio kept across all notes; oldest notes' audio pruned past this. */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

function audioRoot(): string {
  return join(app.getPath('userData'), 'audio')
}

export function audioDirFor(stem: string): string {
  return join(audioRoot(), stem)
}

export function hasAudio(stem: string): boolean {
  return existsSync(audioDirFor(stem))
}

export async function saveChunkWav(
  stem: string,
  index: number,
  startMs: number,
  endMs: number,
  wav: Buffer,
): Promise<void> {
  const dir = audioDirFor(stem)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${String(index).padStart(3, '0')}-${startMs}-${endMs}.wav`), wav)
}

export interface StoredChunk {
  startMs: number
  endMs: number
  wav: Buffer
}

/** All stored chunks for a note, in session order. */
export async function loadChunks(stem: string): Promise<StoredChunk[]> {
  const dir = audioDirFor(stem)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.wav')).sort()
  } catch {
    return []
  }
  const chunks: StoredChunk[] = []
  for (const name of names) {
    const m = /^\d+-(\d+)-(\d+)\.wav$/.exec(name)
    if (!m) continue
    chunks.push({
      startMs: Number(m[1]),
      endMs: Number(m[2]),
      wav: await readFile(join(dir, name)),
    })
  }
  return chunks
}

export async function deleteAudio(stem: string): Promise<void> {
  await rm(audioDirFor(stem), { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Startup cleanup: drop audio for notes that no longer exist, then enforce
 * the total size cap, oldest note first.
 */
export async function pruneAudio(keepStems: Set<string>): Promise<void> {
  let dirs: string[]
  try {
    dirs = await readdir(audioRoot())
  } catch {
    return
  }
  const sized: { stem: string; bytes: number; mtimeMs: number }[] = []
  for (const stem of dirs) {
    if (!keepStems.has(stem)) {
      await deleteAudio(stem)
      continue
    }
    const dir = audioDirFor(stem)
    let bytes = 0
    let mtimeMs = 0
    try {
      for (const f of await readdir(dir)) {
        const s = await stat(join(dir, f))
        bytes += s.size
        mtimeMs = Math.max(mtimeMs, s.mtimeMs)
      }
    } catch {
      continue
    }
    sized.push({ stem, bytes, mtimeMs })
  }
  let total = sized.reduce((sum, d) => sum + d.bytes, 0)
  for (const d of sized.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= MAX_TOTAL_BYTES) break
    await deleteAudio(d.stem)
    total -= d.bytes
  }
}
