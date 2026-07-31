import type { AudioChunk } from './audio-chunker'
import type { TranscriptLog } from './transcript-log'
import { batchTranscribe } from './openai/batch-transcribe'
import { translateLines } from './openai/translate-text'

const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [5_000, 15_000]

// Language/translation options are getters so mid-session settings changes
// apply to every chunk processed after the change.
export interface RefinerOptions {
  apiKey: string
  log: TranscriptLog
  /** Target language name for note translation, or null to skip translating. */
  translateTo: () => string | null
  /** ISO code pinning the spoken language, or null for auto-detect. */
  languageCode: () => string | null
  /** Mixed-language meeting mode: per-chunk detect, no prompt carryover. */
  multilingual: () => boolean
}

/**
 * Sequential pipeline that upgrades the note chunk by chunk: batch-transcribe
 * each audio chunk (with the previous chunk's tail as prompt for terminology
 * consistency), optionally translate the segments with a cheap text model,
 * then merge the refined text into the log, superseding the live draft.
 */
export class NoteRefiner {
  private queue: AudioChunk[] = []
  private running = false
  private prevTail = ''
  private prevLanguage: string | null = null

  constructor(private opts: RefinerOptions) {}

  enqueue(chunk: AudioChunk): void {
    if (chunk.wav === null) {
      // Silent chunk — nothing to transcribe, but mark the range covered so
      // any stray draft artifacts in it are dropped.
      this.opts.log.mergeRefined(chunk.startMs, chunk.endMs, [])
      return
    }
    this.queue.push(chunk)
    void this.pump()
  }

  /** Wait (bounded) for all queued chunks to finish processing. */
  async drain(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while ((this.queue.length > 0 || this.running) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue[0]
        const ok = await this.processWithRetry(chunk)
        this.queue.shift()
        if (!ok) {
          console.error(
            `[refiner] dropping chunk ${new Date(chunk.startMs).toISOString()} after ${MAX_ATTEMPTS} attempts — live draft kept for that range`,
          )
        }
      }
    } finally {
      this.running = false
    }
  }

  private async processWithRetry(chunk: AudioChunk): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await this.process(chunk)
        return true
      } catch (err) {
        console.error(`[refiner] chunk attempt ${attempt + 1} failed:`, err)
        const delay = RETRY_DELAYS_MS[attempt]
        if (delay) await new Promise((r) => setTimeout(r, delay))
      }
    }
    return false
  }

  private async process(chunk: AudioChunk): Promise<void> {
    const languageCode = this.opts.languageCode()
    const multilingual = this.opts.multilingual()
    const { segments: segs, language } = await batchTranscribe(
      this.opts.apiKey,
      chunk.wav!,
      // A prompt in language A would bias a language-B chunk — skip it when
      // speakers mix languages.
      multilingual ? undefined : this.prevTail,
      languageCode ?? undefined,
    )
    const translateTo = this.opts.translateTo()
    let translations: string[] | null = null
    if (translateTo && segs.length > 0) {
      translations = await translateLines(
        this.opts.apiKey,
        segs.map((s) => s.text),
        translateTo,
      )
    }
    this.opts.log.mergeRefined(
      chunk.startMs,
      chunk.endMs,
      segs.map((s, i) => ({
        timeMs: chunk.startMs + Math.round(s.startSec * 1000),
        original: s.text,
        translation: translations?.[i] ?? '',
      })),
    )
    // Anti-cascade guard (auto-detect only): whisper occasionally mis-detects
    // a noisy chunk's language; carrying its tail as the next prompt would
    // spread the wrong language to every later chunk. On a language flip,
    // drop the carryover so the next chunk detects fresh.
    if (!languageCode && this.prevLanguage && language && language !== this.prevLanguage) {
      console.warn(`[refiner] language flipped ${this.prevLanguage} -> ${language}; resetting prompt carryover`)
      this.prevTail = ''
    } else {
      this.prevTail = segs.map((s) => s.text).join(' ').slice(-800)
    }
    this.prevLanguage = language
    console.log(
      `[refiner] refined ${Math.round(chunk.durationMs / 1000)}s chunk -> ${segs.length} segments (${language ?? 'unknown'})`,
    )
  }
}
