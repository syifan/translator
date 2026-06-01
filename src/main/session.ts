import type { BrowserWindow } from 'electron'
import {
  IPC,
  type OverlayConfig,
  type SessionStatus,
  type Settings,
  type SubtitlePayload,
} from '@shared/ipc'
import { store } from './store'
import { getKey } from './secrets'
import { TranscriptionClient } from './openai/transcription'
import { Translator } from './openai/translation'

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
  private settings: Settings
  private status: SessionStatus = { state: 'idle' }

  constructor(private windows: Windows) {
    this.settings = store.get()
  }

  applySettings(next: Settings): void {
    this.settings = next
    this.pushOverlayConfig()
    this.translator?.setTarget(next.targetLang)
    this.transcription?.setLanguageHint(next.sourceLang)
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

    this.translator = new Translator(key, this.settings.translateModel, this.settings.targetLang)

    this.transcription = new TranscriptionClient({
      apiKey: key,
      model: this.settings.transcribeModel,
      languageHint: this.settings.sourceLang,
      onOpen: () => {
        this.setStatus({ state: 'running' })
        this.showOverlay()
      },
      onDelta: (id, text) => this.onDelta(id, text),
      onCompleted: (id, text) => void this.onCompleted(id, text),
      onError: (message) => this.setStatus({ state: 'error', message }),
      onClose: () => {
        this.hideOverlay()
        if (this.status.state !== 'error') this.setStatus({ state: 'idle' })
      },
    })
    this.transcription.connect()
  }

  stop(): void {
    this.transcription?.close()
    this.transcription = null
    this.translator = null
    this.hideOverlay()
    // Ask the renderer to tear down the audio capture graph too.
    this.send(this.windows.control, IPC.captureCommand, { action: 'stop' })
    this.setStatus({ state: 'idle' })
  }

  pushAudio(buf: ArrayBuffer): void {
    this.transcription?.sendAudio(buf)
  }

  onCaptureError(message: string): void {
    this.setStatus({ state: 'error', message })
    this.transcription?.close()
    this.transcription = null
    this.hideOverlay()
  }

  // --- internals ---------------------------------------------------------

  private onDelta(itemId: string, text: string): void {
    this.send(this.windows.overlay, IPC.subtitleUpdate, {
      itemId,
      original: text,
      translation: '',
      isFinal: false,
    } satisfies SubtitlePayload)
  }

  private async onCompleted(itemId: string, rawText: string): Promise<void> {
    const text = rawText.trim()
    const emit = (translation: string, isFinal: boolean) =>
      this.send(this.windows.overlay, IPC.subtitleUpdate, {
        itemId,
        original: text,
        translation,
        isFinal,
      } satisfies SubtitlePayload)

    if (!text || !this.translator) {
      emit('', true)
      return
    }

    emit('', false)
    const translator = this.translator
    try {
      const full = await translator.translate(text, (partial) => emit(partial, false))
      emit(full, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit(`⚠︎ ${message}`, true)
    }
  }

  private setStatus(status: SessionStatus): void {
    this.status = status
    this.send(this.windows.control, IPC.statusChanged, status)
  }

  private pushOverlayConfig(): void {
    this.send(this.windows.overlay, IPC.overlayConfig, {
      fontSize: this.settings.fontSize,
      opacity: this.settings.opacity,
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
