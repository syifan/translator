import type { BrowserWindow } from 'electron'
import {
  IPC,
  REALTIME_TRANSLATE_CODES,
  type OverlayConfig,
  type SessionStatus,
  type Settings,
  type SubtitlePayload,
} from '@shared/ipc'
import { store } from './store'
import { getKey } from './secrets'
import { TranscriptionClient } from './openai/transcription'
import { Translator } from './openai/translation'
import { RealtimeTranslateClient } from './openai/realtime-translate'

interface Windows {
  control: BrowserWindow
  overlay: BrowserWindow
}

/**
 * Orchestrates a live session: audio (sent up from the control renderer) ->
 * realtime transcription -> translation -> overlay. Owns lifecycle + status.
 */
export class SessionManager {
  private transcription: TranscriptionClient | null = null
  private translator: Translator | null = null
  private rt: RealtimeTranslateClient | null = null
  private settings: Settings
  private status: SessionStatus = { state: 'idle' }
  /** Per-transcription-item: how many complete sentences we've already emitted. */
  private segments = new Map<string, { committed: number }>()
  // Realtime-translate rolling buffers.
  private rtSrc = ''
  private rtTrans = ''
  private rtLastDelta = 0

  constructor(private windows: Windows) {
    this.settings = store.get()
  }

  applySettings(next: Settings): void {
    this.settings = next
    this.pushOverlayConfig()
    this.translator?.setTarget(next.targetLang)
    this.transcription?.configure({ languageHint: next.sourceLang, silenceMs: next.vadSilenceMs })
    const code = REALTIME_TRANSLATE_CODES[next.targetLang]
    if (this.rt && code) this.rt.setTarget(code)
  }

  isActive(): boolean {
    return this.status.state === 'running' || this.status.state === 'starting'
  }

  async start(): Promise<void> {
    if (this.status.state === 'running' || this.status.state === 'starting') return

    const key = getKey()
    if (!key) {
      this.setStatus({ state: 'error', message: 'No API key set. Add your OpenAI API key first.' })
      return
    }

    this.settings = store.get()
    this.setStatus({ state: 'starting' })
    this.pushOverlayConfig()
    this.segments.clear()
    this.rtSrc = ''
    this.rtTrans = ''

    const targetCode = REALTIME_TRANSLATE_CODES[this.settings.targetLang]
    if (targetCode) {
      this.startRealtime(key, targetCode)
    } else {
      this.startClassic(key)
    }
  }

  /** Low-latency path: gpt-realtime-translate streams source + translation. */
  private startRealtime(key: string, targetCode: string): void {
    console.log('[session] engine: realtime-translate ->', targetCode)
    this.rt = new RealtimeTranslateClient({
      apiKey: key,
      targetCode,
      onOpen: () => this.setStatus({ state: 'running' }),
      onSourceDelta: (d) => {
        this.rtTouch()
        this.rtSrc += d
        this.emitRtLive()
      },
      onTranslationDelta: (d) => {
        this.rtTouch()
        this.rtTrans += d
        this.emitRtLive()
      },
      onError: (message) => this.setStatus({ state: 'error', message }),
      onClose: () => {
        this.hideOverlay()
        if (this.status.state !== 'error') this.setStatus({ state: 'idle' })
      },
    })
    this.rt.connect()
  }

  /** Fallback path: realtime transcription + chat-completions translation. */
  private startClassic(key: string): void {
    console.log('[session] engine: transcribe + translate (target not realtime-supported)')
    this.translator = new Translator(key, this.settings.translateModel, this.settings.targetLang)
    this.transcription = new TranscriptionClient({
      apiKey: key,
      model: this.settings.transcribeModel,
      languageHint: this.settings.sourceLang,
      silenceMs: this.settings.vadSilenceMs,
      onOpen: () => this.setStatus({ state: 'running' }),
      onDelta: (id, text) => this.onDelta(id, text),
      onCompleted: (id, text) => this.onCompleted(id, text),
      onError: (message) => this.setStatus({ state: 'error', message }),
      onClose: () => {
        this.hideOverlay()
        if (this.status.state !== 'error') this.setStatus({ state: 'idle' })
      },
    })
    this.transcription.connect()
  }

  /** Reset rolling buffers if there was a long pause (new utterance). */
  private rtTouch(): void {
    const now = Date.now()
    if (now - this.rtLastDelta > 2500) {
      this.rtSrc = ''
      this.rtTrans = ''
    }
    this.rtLastDelta = now
  }

  private emitRtLive(): void {
    this.emitUnit('rt:live', tailText(this.rtSrc), tailText(this.rtTrans), false)
  }

  stop(): void {
    this.transcription?.close()
    this.transcription = null
    this.rt?.close()
    this.rt = null
    this.translator = null
    this.segments.clear()
    this.rtSrc = ''
    this.rtTrans = ''
    this.hideOverlay()
    // Ask the renderer to tear down the audio capture graph too.
    this.send(this.windows.control, IPC.captureCommand, { action: 'stop' })
    this.setStatus({ state: 'idle' })
  }

  pushAudio(buf: ArrayBuffer): void {
    this.transcription?.sendAudio(buf)
    this.rt?.sendAudio(buf)
  }

  onCaptureError(message: string): void {
    this.setStatus({ state: 'error', message })
    this.transcription?.close()
    this.transcription = null
    this.rt?.close()
    this.rt = null
    this.hideOverlay()
  }

  // --- internals ---------------------------------------------------------

  private onDelta(itemId: string, text: string): void {
    this.processTranscript(itemId, text, false)
  }

  private onCompleted(itemId: string, rawText: string): void {
    this.processTranscript(itemId, rawText.trim(), true)
    this.segments.delete(itemId)
  }

  /**
   * Break a (possibly growing) transcript into sentences. Each complete sentence
   * becomes its own overlay unit and is translated as soon as it appears — so
   * long, run-on speech is translated sentence-by-sentence instead of waiting
   * for the speaker to stop. The trailing partial is shown live (original only).
   */
  private processTranscript(itemId: string, fullText: string, isFinal: boolean): void {
    const state = this.segments.get(itemId) ?? { committed: 0 }
    this.segments.set(itemId, state)

    const { sentences, tail } = splitSentences(fullText)

    // Newly-complete sentences -> translate + emit, once each.
    for (let i = state.committed; i < sentences.length; i++) {
      this.emitUnit(`${itemId}:${i}`, sentences[i], '', false)
      void this.translateUnit(`${itemId}:${i}`, sentences[i])
    }
    state.committed = Math.max(state.committed, sentences.length)

    if (isFinal) {
      // A trailing chunk without terminal punctuation is the final sentence.
      if (tail) {
        const key = `${itemId}:${sentences.length}`
        this.emitUnit(key, tail, '', false)
        void this.translateUnit(key, tail)
      }
      this.emitUnit(`${itemId}:tail`, '', '', true) // remove the live tail
    } else if (tail) {
      this.emitUnit(`${itemId}:tail`, tail, '', false) // live, original only
    }
  }

  private emitUnit(key: string, original: string, translation: string, isFinal: boolean): void {
    this.send(this.windows.overlay, IPC.subtitleUpdate, {
      itemId: key,
      original,
      translation,
      isFinal,
    } satisfies SubtitlePayload)
  }

  private async translateUnit(key: string, text: string): Promise<void> {
    const translator = this.translator
    if (!translator || !text.trim()) return
    try {
      const full = await translator.translate(text, (partial) => this.emitUnit(key, text, partial, false))
      this.emitUnit(key, text, full, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitUnit(key, text, `⚠︎ ${message}`, true)
    }
  }

  private setStatus(status: SessionStatus): void {
    this.status = status
    this.send(this.windows.control, IPC.statusChanged, status)
    // Mirror to the overlay so it can show "Connecting…/Listening…" feedback,
    // and drive overlay visibility from the session state.
    this.send(this.windows.overlay, IPC.overlayStatus, status)
    if (status.state === 'starting' || status.state === 'running') this.showOverlay()
    else this.hideOverlay()
  }

  private pushOverlayConfig(): void {
    this.send(this.windows.overlay, IPC.overlayConfig, {
      fontSize: this.settings.fontSize,
      opacity: this.settings.opacity,
      holdSeconds: this.settings.holdSeconds,
      maxLines: this.settings.maxLines,
      showOriginal: this.settings.showOriginal,
    } satisfies OverlayConfig)
  }

  private showOverlay(): void {
    if (!this.windows.overlay.isDestroyed()) this.windows.overlay.showInactive()
  }

  private hideOverlay(): void {
    if (!this.windows.overlay.isDestroyed()) this.windows.overlay.hide()
  }

  private send(win: BrowserWindow, channel: string, payload: unknown): void {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Split text into complete sentences (ending in terminal punctuation) plus a
 * trailing partial. Handles ASCII and CJK/full-width punctuation.
 */
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
