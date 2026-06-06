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
import { applyOverlayFloat } from './windows'
import { RealtimeTranslateClient } from './openai/realtime-translate'

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
  private settings: Settings
  private status: SessionStatus = { state: 'idle' }
  // Rolling transcript buffers for the live caption.
  private rtSrc = ''
  private rtTrans = ''
  private rtLastDelta = 0

  constructor(private windows: Windows) {
    this.settings = store.get()
  }

  applySettings(next: Settings): void {
    this.settings = next
    this.pushOverlayConfig()
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

  stop(): void {
    this.rt?.close()
    this.rt = null
    this.rtSrc = ''
    this.rtTrans = ''
    this.hideOverlay()
    // Ask the renderer to tear down the audio capture graph too.
    this.send(this.windows.control, IPC.captureCommand, { action: 'stop' })
    this.setStatus({ state: 'idle' })
  }

  pushAudio(buf: ArrayBuffer): void {
    this.rt?.sendAudio(buf)
  }

  onCaptureError(message: string): void {
    this.setStatus({ state: 'error', message })
    this.rt?.close()
    this.rt = null
    this.hideOverlay()
  }

  // --- internals ---------------------------------------------------------

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
    if (this.windows.overlay.isDestroyed()) return
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
