import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NoteContent } from '@shared/ipc'

/** Where saved session transcripts live (inside Electron's userData dir). */
export function transcriptsDir(): string {
  return join(app.getPath('userData'), 'transcripts')
}

export interface TranscriptEntry {
  time: Date
  original: string
  translation: string
}

/**
 * Accumulates one session's utterances (original + optional translation) and
 * writes them out as a timestamped Markdown file when the session ends.
 */
export class TranscriptLog {
  private entries: TranscriptEntry[] = []
  private startedAt = new Date()
  private saved = false
  private savedPath: string | null = null
  private title: string | null = null

  constructor(
    private content: NoteContent = 'both',
    private onEntry?: (e: TranscriptEntry) => void,
  ) {}

  add(original: string, translation: string): void {
    const o = this.content === 'translation' ? '' : original.trim()
    const t = this.content === 'original' ? '' : translation.trim()
    if (!o && !t) return
    const entry = { time: new Date(), original: o, translation: t }
    this.entries.push(entry)
    this.onEntry?.(entry)
  }

  isEmpty(): boolean {
    return this.entries.length === 0
  }

  /**
   * Write the transcript to disk. Returns the file path, or null if there was
   * nothing to save or it was saved already.
   */
  async save(): Promise<string | null> {
    if (this.saved || this.isEmpty()) return null
    this.saved = true

    const dir = transcriptsDir()
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${fileStamp(this.startedAt)}.md`)
    await writeFile(path, this.toMarkdown(), 'utf8')
    this.savedPath = path
    return path
  }

  /** Text sample for AI title generation (prefers the translated lines). */
  sampleText(maxChars = 6000): string {
    return this.entries
      .map((e) => e.translation || e.original)
      .join('\n')
      .slice(0, maxChars)
  }

  /** Set the AI-generated title and rewrite the saved file's heading. */
  async applyTitle(title: string): Promise<void> {
    const clean = title.replace(/\s+/g, ' ').replace(/^["'#\s]+|["'.\s]+$/g, '').slice(0, 80)
    if (!clean || !this.savedPath) return
    this.title = clean
    await writeFile(this.savedPath, this.toMarkdown(), 'utf8')
  }

  private toMarkdown(): string {
    const heading = this.title ?? `Transcript — ${humanStamp(this.startedAt)}`
    const lines: string[] = [`# ${heading}`, '']
    for (const e of this.entries) {
      const clock = e.time.toTimeString().slice(0, 8)
      if (e.original) lines.push(`**[${clock}]** ${e.original}`)
      else lines.push(`**[${clock}]**`)
      if (e.translation) lines.push(`> ${e.translation}`)
      lines.push('')
    }
    return lines.join('\n')
  }
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
