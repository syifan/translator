import type {
  DisplayInfo,
  QuickStart,
  OverlayConfig,
  SessionStatus,
  Settings,
  SubtitlePayload,
  TranscriptEntryPayload,
  TranscriptFileInfo,
  TranscriptPartialPayload,
  TranscriptSavedPayload,
} from '@shared/ipc'

declare global {
  interface Window {
    api: {
      getSettings(): Promise<Settings>
      setSettings(partial: Partial<Settings>): Promise<Settings>
      hasKey(): Promise<boolean>
      setKey(key: string): Promise<boolean>
      clearKey(): Promise<boolean>
      startSession(): Promise<void>
      stopSession(): Promise<void>
      onStatus(cb: (s: SessionStatus) => void): () => void
      getDisplays(): Promise<DisplayInfo[]>
      onDisplaysChanged(cb: (d: DisplayInfo[]) => void): () => void
      listTranscripts(): Promise<TranscriptFileInfo[]>
      readTranscript(fileName: string): Promise<string>
      deleteTranscript(fileName: string): Promise<void>
      downloadTranscript(fileName: string): Promise<string>
      listQuickStarts(): Promise<QuickStart[]>
      saveQuickStart(name: string): Promise<QuickStart[]>
      deleteQuickStart(name: string): Promise<QuickStart[]>
      onTranscriptSaved(cb: (p: TranscriptSavedPayload) => void): () => void
      onTranscriptReplace(cb: (p: TranscriptEntryPayload[]) => void): () => void
      onTranscriptPartial(cb: (p: TranscriptPartialPayload) => void): () => void
    }
    capture: {
      enableLoopback(): Promise<void>
      disableLoopback(): Promise<void>
      sendAudio(buf: ArrayBuffer): void
      reportError(msg: string): void
      onStopCapture(cb: () => void): () => void
    }
    overlay: {
      onSubtitle(cb: (p: SubtitlePayload) => void): () => void
      onConfig(cb: (c: OverlayConfig) => void): () => void
      onStatus(cb: (s: SessionStatus) => void): () => void
    }
  }
}

export {}
