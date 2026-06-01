import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type SessionStatus, type Settings } from '@shared/ipc'

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
