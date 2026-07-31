import { app } from 'electron'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NoteContent } from '@shared/ipc'
import { store } from './store'

/** Where saved session transcripts live (inside Electron's userData dir). */
export function transcriptsDir(): string {
  return join(app.getPath('userData'), 'transcripts')
}

export interface TranscriptEntry {
  time: Date
  original: string
  translation: string
  /** True once this entry came from the high-accuracy (batch) pass. */
  refined: boolean
}

export interface RefinedSegment {
  /** Wall-clock ms of the segment. */
  timeMs: number
  original: string
  translation: string
}

interface CoveredRange {
  startMs: number
  endMs: number
}

/**
 * One session's note. Live (realtime draft) entries accumulate as spoken;
 * refined chunks from the batch pass replace the draft for the audio range
 * they cover. The file on disk is updated incrementally (debounced) so a
 * crash mid-session loses nothing.
 */
export class TranscriptLog {
  private liveEntries: TranscriptEntry[] = []
  private refinedEntries: TranscriptEntry[] = []
  private covered: CoveredRange[] = []
  private startedAt = new Date()
  /** File stem ("2026-07-22 14-30-05") — names the note and its audio dir. */
  readonly stem = fileStamp(this.startedAt)
  private title: string | null = null
  private filePath: string | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private finished = false

  constructor(
    private content: NoteContent = 'both',
    private onChange?: () => void,
  ) {}

  addLive(original: string, translation: string): void {
    const e = this.filtered(original, translation, false)
    if (!e) return
    this.liveEntries.push(e)
    this.changed()
  }

  /** Replace the draft for [startMs, endMs] with refined segments. */
  mergeRefined(startMs: number, endMs: number, segments: RefinedSegment[]): void {
    for (const s of segments) {
      const e = this.filtered(s.original, s.translation, true, new Date(s.timeMs))
      if (e) this.refinedEntries.push(e)
    }
    this.refinedEntries.sort((a, b) => a.time.getTime() - b.time.getTime())
    this.covered.push({ startMs, endMs })
    this.changed()
  }

  /** A live entry is superseded once a refined chunk covers its audio range. */
  entries(): TranscriptEntry[] {
    // Live entries are stamped when the utterance FINALIZES, i.e. shortly
    // after the speech itself — allow a small margin past the chunk end.
    const MARGIN_MS = 2_500
    const kept = this.liveEntries.filter((e) => {
      const t = e.time.getTime()
      return !this.covered.some((r) => t >= r.startMs && t <= r.endMs + MARGIN_MS)
    })
    return [...this.refinedEntries, ...kept].sort((a, b) => a.time.getTime() - b.time.getTime())
  }

  isEmpty(): boolean {
    return this.refinedEntries.length === 0 && this.liveEntries.length === 0
  }

  /** Text sample for AI title generation (prefers the translated lines). */
  sampleText(maxChars = 6000): string {
    return this.entries()
      .map((e) => e.translation || e.original)
      .join('\n')
      .slice(0, maxChars)
  }

  /** Set the AI-generated title and rewrite the file's heading. */
  async applyTitle(title: string): Promise<void> {
    const clean = title.replace(/\s+/g, ' ').replace(/^["'#\s]+|["'.\s]+$/g, '').slice(0, 80)
    if (!clean) return
    this.title = clean
    await this.flush()
  }

  /** Debounced incremental write — keeps the on-disk note crash-safe. */
  requestFlush(): void {
    // With note saving off, never touch the disk — "not saved" must not
    // mean "written and deleted later" (a crash would leak the file).
    if (!store.get().notesEnabled) return
    if (this.finished || this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush().catch((err) => console.error('[transcript] flush failed:', err))
    }, 1_000)
  }

  async flush(): Promise<string | null> {
    if (this.isEmpty()) return null
    if (!this.filePath) {
      const dir = transcriptsDir()
      await mkdir(dir, { recursive: true })
      this.filePath = join(dir, `${this.stem}.md`)
    }
    await writeFile(this.filePath, this.toMarkdown(), 'utf8')
    return this.filePath
  }

  /**
   * Final write at session end. When note saving is disabled, any
   * incrementally-written file is removed instead.
   */
  async finish(save: boolean): Promise<string | null> {
    this.finished = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!save) {
      if (this.filePath) await unlink(this.filePath).catch(() => undefined)
      return null
    }
    return this.flush()
  }

  private filtered(
    original: string,
    translation: string,
    refined: boolean,
    time = new Date(),
  ): TranscriptEntry | null {
    const o = this.content === 'translation' ? '' : original.trim()
    const t = this.content === 'original' ? '' : translation.trim()
    if (!o && !t) return null
    return { time, original: o, translation: t, refined }
  }

  private changed(): void {
    this.onChange?.()
    this.requestFlush()
  }

  private toMarkdown(): string {
    const heading = this.title ?? `Transcript — ${humanStamp(this.startedAt)}`
    return renderMarkdown(heading, this.entries())
  }
}

/** Shared note format — used by live sessions and re-transcription alike. */
export function renderMarkdown(
  heading: string,
  entries: { time: Date; original: string; translation: string }[],
): string {
  const lines: string[] = [`# ${heading}`, '']
  for (const e of entries) {
    const clock = e.time.toTimeString().slice(0, 8)
    if (e.original) lines.push(`**[${clock}]** ${e.original}`)
    else lines.push(`**[${clock}]**`)
    if (e.translation) lines.push(`> ${e.translation}`)
    lines.push('')
  }
  return lines.join('\n')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Filesystem-safe timestamp: "2026-07-22 14-30-05". */
function fileStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

/** Human-readable timestamp for the document title. */
function humanStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
