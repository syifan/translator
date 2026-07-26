import type { BrowserWindow } from 'electron'
import {
  IPC,
  REALTIME_TRANSLATE_CODES,
  type NoteContent,
  type OverlayConfig,
  type SessionStatus,
  type Settings,
  type SubtitlePayload,
  type TranscriptEntryPayload,
  type TranscriptPartialPayload,
  type TranscriptSavedPayload,
} from '@shared/ipc'
import { store } from './store'
import { getKey } from './secrets'
import { applyOverlayFloat, positionOverlay } from './windows'
import { RealtimeTranslateClient } from './openai/realtime-translate'
import { TranscriptionClient } from './openai/transcription'
import { TranscriptLog } from './transcript-log'
import { AudioChunker } from './audio-chunker'
import { NoteRefiner } from './note-refiner'
import { summarizeTitle } from './openai/summarize'
import { basename } from 'node:path'

/** Transcribe-only engine model (translation off). */
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe'

interface Windows {
  control: BrowserWindow
  overlay: BrowserWindow
}

/**
 * Orchestrates a live session: audio (sent up from the control renderer) ->
 * realtime engines (overlay subtitles + live note draft) and, in parallel,
 * the chunked batch pipeline that upgrades the note to high accuracy.
 */
export class SessionManager {
  private rt: RealtimeTranslateClient | null = null
  private tx: TranscriptionClient | null = null
  private settings: Settings
  private status: SessionStatus = { state: 'idle' }
  // Rolling transcript buffers for the live caption.
  private rtSrc = ''
  private rtTrans = ''
  private rtLastDelta = 0
  // Full-session note, incrementally saved; upgraded chunk-by-chunk.
  private log: TranscriptLog | null = null
  private recorder: AudioChunker | null = null
  private refiner: NoteRefiner | null = null
  // The log whose updates the control window is currently watching. Kept
  // after stop so late-arriving refined chunks still update the view.
  private activeLog: TranscriptLog | null = null
  private replaceTimer: ReturnType<typeof setTimeout> | null = null
  // Session-scoped copies of settings that must not change mid-run.
  private noteMode: NoteContent = 'both'
  private liveNotes = true

  constructor(private windows: Windows) {
    this.settings = store.get()
  }

  applySettings(next: Settings): void {
    this.settings = next
    this.pushOverlayConfig()
    // Overlay visibility can be toggled live mid-session.
    if (this.isActive()) {
      if (this.subtitlesEnabled()) this.showOverlay()
      else this.hideOverlay()
    }
    const code = REALTIME_TRANSLATE_CODES[next.targetLang]
    if (this.rt && code) this.rt.setTarget(code)
  }

  isActive(): boolean {
    return this.status.state === 'running' || this.status.state === 'starting'
  }

  async start(): Promise<void> {
    if (this.isActive()) return

    const key = getKey()
    if (!key) {
      this.setStatus({ state: 'error', message: 'No API key set. Add your OpenAI API key first.' })
      return
    }

    this.settings = store.get()

    if (!this.settings.systemAudioEnabled && !this.settings.micEnabled) {
      this.setStatus({
        state: 'error',
        message: 'Both audio inputs are off. Enable system audio and/or the microphone in Settings.',
      })
      return
    }

    // The realtime engines exist for the overlay and the live note draft.
    // With all three off, the batch pipeline alone builds the note.
    const needRealtime =
      this.settings.showOriginal || this.settings.showTranslation || this.settings.liveNotes

    if (!needRealtime && !this.settings.notesEnabled) {
      this.setStatus({
        state: 'error',
        message:
          'Nothing to do: enable captions, translation, the real-time note, or note saving in Settings.',
      })
      return
    }

    this.setStatus({ state: 'starting' })
    this.pushOverlayConfig()
    this.startLog(key)

    // Notes-only mode: no realtime engine at all (cheapest). The batch
    // pipeline transcribes chunks as they fill.
    if (!needRealtime) {
      console.log('[session] notes-only mode (no realtime engine)')
      this.setStatus({ state: 'running' })
      return
    }

    // Transcribe-only: no translation model in the loop (cheaper).
    if (!this.settings.showTranslation) {
      console.log('[session] transcribe-only ->', TRANSCRIBE_MODEL)
      this.tx = new TranscriptionClient({
        apiKey: key,
        model: TRANSCRIBE_MODEL,
        onOpen: () => this.setStatus({ state: 'running' }),
        onDelta: (id, text) => {
          this.emitUnit(id, text, '', false)
          if (this.liveNotes) this.sendPartial(text, '')
        },
        onCompleted: (id, text) => {
          if (this.liveNotes) {
            this.log?.addLive(text, '')
            this.sendPartial('', '')
          }
          this.emitUnit(id, text, '', true)
        },
        onError: (message) => this.setStatus({ state: 'error', message }),
        onClose: () => {
          this.finishLog()
          this.hideOverlay()
          if (this.status.state !== 'error') this.setStatus({ state: 'idle' })
        },
      })
      this.tx.connect()
      return
    }

    const targetCode = REALTIME_TRANSLATE_CODES[this.settings.targetLang]
    if (!targetCode) {
      this.setStatus({
        state: 'error',
        message: `"${this.settings.targetLang}" isn't a supported target language. Pick one of the listed languages.`,
      })
      return
    }

    this.rtSrc = ''
    this.rtTrans = ''

    console.log('[session] realtime-translate ->', targetCode)
    this.rt = new RealtimeTranslateClient({
      apiKey: key,
      targetCode,
      onOpen: () => this.setStatus({ state: 'running' }),
      onSourceDelta: (d) => {
        this.rtTouch()
        this.rtSrc += d
        this.emitRtLive()
        if (this.liveNotes) this.sendPartial(this.rtSrc, this.rtTrans)
      },
      onTranslationDelta: (d) => {
        this.rtTouch()
        this.rtTrans += d
        this.emitRtLive()
        if (this.liveNotes) this.sendPartial(this.rtSrc, this.rtTrans)
      },
      onError: (message) => this.setStatus({ state: 'error', message }),
      onClose: () => {
        this.finishLog()
        this.hideOverlay()
        if (this.status.state !== 'error') this.setStatus({ state: 'idle' })
      },
    })
    this.rt.connect()
  }

  stop(): void {
    this.finishLog()
    this.rt?.close()
    this.rt = null
    this.tx?.close()
    this.tx = null
    this.rtSrc = ''
    this.rtTrans = ''
    this.hideOverlay()
    // Ask the renderer to tear down the audio capture graph too.
    this.send(this.windows.control, IPC.captureCommand, { action: 'stop' })
    this.setStatus({ state: 'idle' })
  }

  pushAudio(buf: ArrayBuffer): void {
    this.recorder?.append(buf)
    this.rt?.sendAudio(buf)
    this.tx?.sendAudio(buf)
  }

  onCaptureError(message: string): void {
    this.finishLog()
    this.setStatus({ state: 'error', message })
    this.rt?.close()
    this.rt = null
    this.tx?.close()
    this.tx = null
    this.hideOverlay()
  }

  // --- internals ---------------------------------------------------------

  /** Reset rolling buffers if there was a long pause (new utterance). */
  private rtTouch(): void {
    const now = Date.now()
    if (now - this.rtLastDelta > 2500) {
      // The pause marks the end of an utterance; log it before discarding.
      if (this.liveNotes) this.log?.addLive(this.rtSrc, this.rtTrans)
      this.rtSrc = ''
      this.rtTrans = ''
    }
    this.rtLastDelta = now
  }

  private emitRtLive(): void {
    const n = Math.max(1, this.settings.maxLines)
    this.emitUnit('rt:live', tailText(this.rtSrc, n), tailText(this.rtTrans, n), false)
  }

  private emitUnit(key: string, original: string, translation: string, isFinal: boolean): void {
    this.send(this.windows.overlay, IPC.subtitleUpdate, {
      itemId: key,
      original,
      translation,
      isFinal,
    } satisfies SubtitlePayload)
  }

  /** Fresh per-session log + (when notes are on) the batch-refine pipeline. */
  private startLog(apiKey: string): void {
    this.noteMode = this.settings.showTranslation ? this.settings.noteContent : 'original'
    this.liveNotes = this.settings.liveNotes
    const log = new TranscriptLog(this.noteMode, () => this.sendReplace(log))
    this.log = log
    this.activeLog = log
    this.sendReplace(log) // clear the previous session's view

    if (this.settings.notesEnabled) {
      const translateTo =
        this.settings.showTranslation && this.noteMode !== 'original'
          ? this.settings.targetLang
          : null
      const refiner = new NoteRefiner({ apiKey, log, translateTo })
      this.refiner = refiner
      this.recorder = new AudioChunker((chunk) => refiner.enqueue(chunk))
    }
  }

  /** Debounced full-list push — the view mirrors the note (draft + refined). */
  private sendReplace(log: TranscriptLog): void {
    if (this.replaceTimer) return
    this.replaceTimer = setTimeout(() => {
      this.replaceTimer = null
      if (this.activeLog !== log) return
      const entries: TranscriptEntryPayload[] = log.entries().map((e) => ({
        time: e.time.getTime(),
        original: e.original,
        translation: e.translation,
        refined: e.refined,
      }))
      this.send(this.windows.control, IPC.transcriptReplace, entries)
    }, 150)
  }

  /** Mirror the in-progress (unfinalized) utterance to the app. */
  private sendPartial(original: string, translation: string): void {
    this.send(this.windows.control, IPC.transcriptPartial, {
      original: this.noteMode === 'translation' ? '' : original,
      translation: this.noteMode === 'original' ? '' : translation,
    } satisfies TranscriptPartialPayload)
  }

  private subtitlesEnabled(): boolean {
    return this.settings.showOriginal || this.settings.showTranslation
  }

  /** Flush trailing audio + draft, then finalize the note in the background. */
  private finishLog(): void {
    const log = this.log
    const recorder = this.recorder
    const refiner = this.refiner
    this.log = null
    this.recorder = null
    this.refiner = null
    if (!log) return
    recorder?.final()
    if (this.liveNotes) log.addLive(this.rtSrc, this.rtTrans)
    this.sendPartial('', '')
    void this.finalizeNote(log, refiner)
  }

  /** Waits for pending refined chunks, saves (or discards), then titles. */
  private async finalizeNote(log: TranscriptLog, refiner: NoteRefiner | null): Promise<void> {
    try {
      await refiner?.drain()
      // Checked at save time so the user can turn saving off mid-session to
      // discard the current session's note.
      const save = store.get().notesEnabled
      const path = await log.finish(save)
      if (!save) console.log('[session] note taking disabled — transcript not saved')
      if (!path) return
      console.log('[session] transcript saved ->', path)
      this.notifySaved(path)
      const key = getKey()
      if (!key) return
      const title = await summarizeTitle(key, log.sampleText())
      if (!title) return
      await log.applyTitle(title)
      console.log('[session] transcript titled ->', title)
      this.notifySaved(path) // re-notify so the notes list picks up the title
    } catch (err) {
      console.error('[session] note finalize failed:', err)
    }
  }

  private notifySaved(path: string): void {
    this.send(this.windows.control, IPC.transcriptSaved, {
      path,
      fileName: basename(path),
    } satisfies TranscriptSavedPayload)
  }

  private setStatus(status: SessionStatus): void {
    this.status = status
    this.send(this.windows.control, IPC.statusChanged, status)
    // Mirror to the overlay for "Connecting…/Listening…" feedback + visibility.
    this.send(this.windows.overlay, IPC.overlayStatus, status)
    const wantOverlay =
      (status.state === 'starting' || status.state === 'running') && this.subtitlesEnabled()
    if (wantOverlay) this.showOverlay()
    else this.hideOverlay()
  }

  private pushOverlayConfig(): void {
    this.send(this.windows.overlay, IPC.overlayConfig, {
      fontSize: this.settings.fontSize,
      opacity: this.settings.opacity,
      holdSeconds: this.settings.holdSeconds,
      maxLines: this.settings.maxLines,
      showOriginal: this.settings.showOriginal,
      showTranslation: this.settings.showTranslation,
    } satisfies OverlayConfig)
  }

  private showOverlay(): void {
    if (this.windows.overlay.isDestroyed()) return
    positionOverlay(this.windows.overlay, this.settings.displayId)
    this.windows.overlay.showInactive()
    // Re-assert float-over-fullscreen each time we show (covers the case where a
    // video went fullscreen after the window was created).
    applyOverlayFloat(this.windows.overlay)
  }

  private hideOverlay(): void {
    if (!this.windows.overlay.isDestroyed()) this.windows.overlay.hide()
  }

  private send(win: BrowserWindow, channel: string, payload: unknown): void {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Split text into complete sentences plus a trailing partial (ASCII + CJK punctuation). */
function splitSentences(text: string): { sentences: string[]; tail: string } {
  const sentences: string[] = []
  const re = /[^.!?。．！？…]*[.!?。．！？…]+['")\]”’»]*\s*/gu
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim()
    if (s) sentences.push(s)
    lastIndex = re.lastIndex
  }
  return { sentences, tail: text.slice(lastIndex).trim() }
}

/** The most recent `maxSentences` complete sentences plus any in-progress tail. */
function tailText(text: string, maxSentences = 2): string {
  const { sentences, tail } = splitSentences(text)
  return [...sentences.slice(-maxSentences), tail].filter(Boolean).join(' ')
}
