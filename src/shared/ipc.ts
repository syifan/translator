// Shared contract between the main process, preloads, and renderers.
// Channel names + payload types live here so both sides stay in sync.

export interface Settings {
  /** Target language to translate into, e.g. "English", "Spanish". */
  targetLang: string
  /** Source language hint; "auto" lets the model detect it. */
  sourceLang: string
  /** Realtime transcription model. */
  transcribeModel: string
  /** Chat model used for translation. */
  translateModel: string
  /** Mix the microphone into the captured audio. */
  micEnabled: boolean
  /** Overlay translation font size in px. */
  fontSize: number
  /** Overlay caption background opacity (0..1). */
  opacity: number
  /** How long (seconds) the last subtitle stays on screen after updates stop. */
  holdSeconds: number
  /** Reserved for future multi-line history. */
  maxLines: number
  /** Show the original (untranslated) line above the translation. */
  showOriginal: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  targetLang: 'English',
  sourceLang: 'auto',
  transcribeModel: 'gpt-4o-transcribe',
  translateModel: 'gpt-4o-mini',
  micEnabled: false,
  fontSize: 30,
  opacity: 0.55,
  holdSeconds: 6,
  maxLines: 2,
  showOriginal: true,
}

export type SessionState = 'idle' | 'starting' | 'running' | 'error'

export interface SessionStatus {
  state: SessionState
  message?: string
}

export interface SubtitlePayload {
  /** Transcription item id; identifies one spoken segment. */
  itemId: string
  original: string
  translation: string
  /** True once the segment's transcript + translation are final. */
  isFinal: boolean
}

export interface OverlayConfig {
  fontSize: number
  opacity: number
  holdSeconds: number
  maxLines: number
  showOriginal: boolean
}

export interface CaptureCommand {
  action: 'stop'
}

/** IPC channel names. Suffix convention: nothing special, just unique strings. */
export const IPC = {
  // control window <-> main (invoke/handle)
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  hasKey: 'key:has',
  setKey: 'key:set',
  clearKey: 'key:clear',
  startSession: 'session:start',
  stopSession: 'session:stop',

  // main -> control window (send)
  statusChanged: 'session:status',
  captureCommand: 'capture:command',

  // control window -> main (send)
  audioPcm: 'audio:pcm',
  captureError: 'capture:error',

  // main -> overlay window (send)
  subtitleUpdate: 'subtitle:update',
  overlayConfig: 'overlay:config',
  overlayStatus: 'overlay:status',

  // electron-audio-loopback registers these on ipcMain (do not rename):
  enableLoopback: 'enable-loopback-audio',
  disableLoopback: 'disable-loopback-audio',
} as const
