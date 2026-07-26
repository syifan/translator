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
 * gpt-realtime-translate (streams source + translated transcript) -> overlay.
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
  // Full-session transcript, saved to disk when the session ends.
  private log: TranscriptLog | null = null
  // What the note keeps, fixed at session start ('translation' needs the engine on).
  private noteMode: NoteContent = 'both'

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

    // Transcribe-only: no translation model in the loop (cheaper). Also the
    // engine when both overlay lines are off (in-app transcript only).
    if (!this.settings.showTranslation) {
      this.setStatus({ state: 'starting' })
      this.pushOverlayConfig()
      this.startLog()
      console.log('[session] transcribe-only ->', TRANSCRIBE_MODEL)
      this.tx = new TranscriptionClient({
        apiKey: key,
        model: TRANSCRIBE_MODEL,
        onOpen: () => this.setStatus({ state: 'running' }),
        onDelta: (id, text) => {
          this.emitUnit(id, text, '', false)
          this.sendPartial(text, '')
        },
        onCompleted: (id, text) => {
          this.log?.add(text, '')
          this.emitUnit(id, text, '', true)
          this.sendPartial('', '')
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

    this.setStatus({ state: 'starting' })
    this.pushOverlayConfig()
    this.startLog()
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
        this.sendPartial(this.rtSrc, this.rtTrans)
      },
      onTranslationDelta: (d) => {
        this.rtTouch()
        this.rtTrans += d
        this.emitRtLive()
        this.sendPartial(this.rtSrc, this.rtTrans)
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
      this.log?.add(this.rtSrc, this.rtTrans)
      this.rtSrc = ''
      this.rtTrans = ''
    }
    this.rtLastDelta = now
  }

  /** Fresh per-session log that mirrors every finalized entry to the app. */
  private startLog(): void {
    // Translation-only notes need the translation engine; fall back to the
    // transcript so a transcribe-only session never produces empty notes.
    this.noteMode = this.settings.showTranslation ? this.settings.noteContent : 'original'
    this.log = new TranscriptLog(this.noteMode, (e) => {
      this.send(this.windows.control, IPC.transcriptEntry, {
        time: e.time.getTime(),
        original: e.original,
        translation: e.translation,
      } satisfies TranscriptEntryPayload)
    })
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

  /** Flush pending text, save the transcript, and tell the control window. */
  private finishLog(): void {
    const log = this.log
    this.log = null
    if (!log) return
    log.add(this.rtSrc, this.rtTrans)
    this.sendPartial('', '')
    // Checked at save time so the user can turn it off mid-session to
    // discard the current session's note.
    if (!store.get().notesEnabled) {
      console.log('[session] note taking disabled — transcript not saved')
      return
    }
    void log
      .save()
      .then(async (path) => {
        if (!path) return
        console.log('[session] transcript saved ->', path)
        this.notifySaved(path)
        // Title the note with a tiny model; keep the timestamp heading on failure.
        const key = getKey()
        if (!key) return
        const title = await summarizeTitle(key, log.sampleText())
        if (!title) return
        await log.applyTitle(title)
        console.log('[session] transcript titled ->', title)
        this.notifySaved(path) // re-notify so the notes list picks up the title
      })
      .catch((err) => console.error('[session] transcript save failed:', err))
  }

  private notifySaved(path: string): void {
    this.send(this.windows.control, IPC.transcriptSaved, {
      path,
      fileName: basename(path),
    } satisfies TranscriptSavedPayload)
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
