import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type DisplayInfo,
  type QuickStart,
  type SessionStatus,
  type Settings,
  type TranscriptEntryPayload,
  type TranscriptFileInfo,
  type TranscriptPartialPayload,
  type TranscriptSavedPayload,
} from '@shared/ipc'

// Settings / session control surface.
contextBridge.exposeInMainWorld('api', {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (partial: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC.setSettings, partial),
  hasKey: (): Promise<boolean> => ipcRenderer.invoke(IPC.hasKey),
  setKey: (key: string): Promise<boolean> => ipcRenderer.invoke(IPC.setKey, key),
  clearKey: (): Promise<boolean> => ipcRenderer.invoke(IPC.clearKey),
  startSession: (): Promise<void> => ipcRenderer.invoke(IPC.startSession),
  stopSession: (): Promise<void> => ipcRenderer.invoke(IPC.stopSession),
  onStatus: (cb: (s: SessionStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, s: SessionStatus) => cb(s)
    ipcRenderer.on(IPC.statusChanged, listener)
    return () => ipcRenderer.removeListener(IPC.statusChanged, listener)
  },
  getDisplays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke(IPC.getDisplays),
  listTranscripts: (): Promise<TranscriptFileInfo[]> => ipcRenderer.invoke(IPC.listTranscripts),
  readTranscript: (fileName: string): Promise<string> =>
    ipcRenderer.invoke(IPC.readTranscript, fileName),
  deleteTranscript: (fileName: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteTranscript, fileName),
  downloadTranscript: (fileName: string): Promise<string> =>
    ipcRenderer.invoke(IPC.downloadTranscript, fileName),
  listQuickStarts: (): Promise<QuickStart[]> => ipcRenderer.invoke(IPC.listQuickStarts),
  saveQuickStart: (name: string): Promise<QuickStart[]> =>
    ipcRenderer.invoke(IPC.saveQuickStart, name),
  deleteQuickStart: (name: string): Promise<QuickStart[]> =>
    ipcRenderer.invoke(IPC.deleteQuickStart, name),
  onTranscriptSaved: (cb: (p: TranscriptSavedPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: TranscriptSavedPayload) => cb(p)
    ipcRenderer.on(IPC.transcriptSaved, listener)
    return () => ipcRenderer.removeListener(IPC.transcriptSaved, listener)
  },
  onTranscriptReplace: (cb: (p: TranscriptEntryPayload[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: TranscriptEntryPayload[]) => cb(p)
    ipcRenderer.on(IPC.transcriptReplace, listener)
    return () => ipcRenderer.removeListener(IPC.transcriptReplace, listener)
  },
  onTranscriptPartial: (cb: (p: TranscriptPartialPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: TranscriptPartialPayload) => cb(p)
    ipcRenderer.on(IPC.transcriptPartial, listener)
    return () => ipcRenderer.removeListener(IPC.transcriptPartial, listener)
  },
  onDisplaysChanged: (cb: (d: DisplayInfo[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, d: DisplayInfo[]) => cb(d)
    ipcRenderer.on(IPC.displaysChanged, listener)
    return () => ipcRenderer.removeListener(IPC.displaysChanged, listener)
  },
})

// Audio capture surface. The loopback channels are handled by
// electron-audio-loopback's initMain() in the main process.
contextBridge.exposeInMainWorld('capture', {
  enableLoopback: (): Promise<void> => ipcRenderer.invoke(IPC.enableLoopback),
  disableLoopback: (): Promise<void> => ipcRenderer.invoke(IPC.disableLoopback),
  sendAudio: (buf: ArrayBuffer): void => ipcRenderer.send(IPC.audioPcm, buf),
  reportError: (msg: string): void => ipcRenderer.send(IPC.captureError, msg),
  onStopCapture: (cb: () => void): (() => void) => {
    const listener = () => cb()
    ipcRenderer.on(IPC.captureCommand, listener)
    return () => ipcRenderer.removeListener(IPC.captureCommand, listener)
  },
})
