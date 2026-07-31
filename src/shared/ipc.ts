// Shared contract between the main process, preloads, and renderers.
// Channel names + payload types live here so both sides stay in sync.

/** What gets written into a session's note. */
export type NoteContent = 'both' | 'original' | 'translation'

export interface Settings {
  /** Target output language (one of REALTIME_TRANSLATE_CODES). Source is auto-detected. */
  targetLang: string
  /**
   * Spoken (source) language, or 'Auto'. Pinning it stops the high-accuracy
   * pass from mis-detecting the language on noisy/music-heavy chunks.
   */
  sourceLang: string
  /** Capture system (loopback) audio. */
  systemAudioEnabled: boolean
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
  /** Show the original (untranslated) transcription line. */
  showOriginal: boolean
  /** Show the translated line. Off = transcribe-only session (no translation model). */
  showTranslation: boolean
  /** Display the overlay shows on; null = primary display. */
  displayId: number | null
  /** Save a note (Markdown file) when a session ends. Off = live view only. */
  notesEnabled: boolean
  /**
   * Show the realtime draft in the note immediately (replaced by the
   * high-accuracy pass). Off = the note builds from refined chunks only, and
   * no realtime engine runs unless the overlay needs one.
   */
  liveNotes: boolean
  /** What the saved note (and live transcript view) contains. */
  noteContent: NoteContent
}

export interface DisplayInfo {
  id: number
  label: string
  primary: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  targetLang: 'English',
  sourceLang: 'Auto',
  systemAudioEnabled: true,
  micEnabled: false,
  fontSize: 30,
  opacity: 0.55,
  holdSeconds: 6,
  maxLines: 3,
  showOriginal: true,
  showTranslation: true,
  displayId: null,
  notesEnabled: true,
  liveNotes: true,
  noteContent: 'both',
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
  showTranslation: boolean
}

export interface CaptureCommand {
  action: 'stop'
}

export interface TranscriptSavedPayload {
  /** Absolute path of the transcript file that was just written. */
  path: string
  /** Basename shown in the UI ("2026-07-22 14-30-05.md"). */
  fileName: string
}

/** One note entry, sent to the control window in full-list replacements. */
export interface TranscriptEntryPayload {
  /** Epoch ms of the utterance. */
  time: number
  original: string
  translation: string
  /** True once this entry came from the high-accuracy (batch) pass. */
  refined: boolean
}

/** The in-progress (not yet finalized) utterance text. */
export interface TranscriptPartialPayload {
  original: string
  translation: string
}

/** A named settings snapshot that can be applied + started with one click. */
export interface QuickStart {
  name: string
  settings: Settings
}

/** A saved transcript file, listed in the notes sidebar. */
export interface TranscriptFileInfo {
  fileName: string
  /** Last-modified epoch ms (list is sorted newest first). */
  mtimeMs: number
  /** Display title (from the note's # heading; AI-generated after save). */
  title: string
  /** True when session audio is stored, enabling re-transcription. */
  hasAudio: boolean
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
  listTranscripts: 'transcripts:list',
  readTranscript: 'transcripts:read',
  deleteTranscript: 'transcripts:delete',
  downloadTranscript: 'transcripts:download',
  retranscribeTranscript: 'transcripts:retranscribe',
  listQuickStarts: 'quickstarts:list',
  saveQuickStart: 'quickstarts:save',
  deleteQuickStart: 'quickstarts:delete',

  // main -> control window (send)
  statusChanged: 'session:status',
  displaysChanged: 'displays:changed',
  captureCommand: 'capture:command',
  transcriptSaved: 'transcript:saved',
  transcriptReplace: 'transcript:replace',
  transcriptPartial: 'transcript:partial',

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
