// Shared contract between the main process, preloads, and renderers.
// Channel names + payload types live here so both sides stay in sync.

export interface Settings {
  /** Target output language (one of REALTIME_TRANSLATE_CODES). Source is auto-detected. */
  targetLang: string
  /** Mix the microphone into the captured audio. */
  micEnabled: boolean
  /** Overlay translation font size in px. */
  fontSize: number
  /** Overlay caption background opacity (0..1). */
  opacity: number
  /** How long (seconds) the last subtitle stays on screen after updates stop. */
  holdSeconds: number
  /** Number of recent sentences kept on the overlay at once. */
  maxLines: number
  /** Show the original (untranslated) line above the translation. */
  showOriginal: boolean
  /** Display the overlay shows on; null = primary display. */
  displayId: number | null
}

export interface DisplayInfo {
  id: number
  label: string
  primary: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  targetLang: 'English',
  micEnabled: false,
  fontSize: 30,
  opacity: 0.55,
  holdSeconds: 6,
  maxLines: 3,
  showOriginal: true,
  displayId: null,
}

/**
 * The 13 output languages supported by gpt-realtime-translate, mapped to ISO
 * codes. The target language picker is limited to these. Source is auto-detected.
 */
export const REALTIME_TRANSLATE_CODES: Record<string, string> = {
  English: 'en',
  Spanish: 'es',
  Portuguese: 'pt',
  French: 'fr',
  German: 'de',
  Italian: 'it',
  Japanese: 'ja',
  Korean: 'ko',
  Russian: 'ru',
  Hindi: 'hi',
  Indonesian: 'id',
  Vietnamese: 'vi',
  'Chinese (Simplified)': 'zh',
  'Chinese (Traditional)': 'zh',
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
  getDisplays: 'displays:get',

  // main -> control window (send)
  statusChanged: 'session:status',
  displaysChanged: 'displays:changed',
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
