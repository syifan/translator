import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type OverlayConfig, type SessionStatus, type SubtitlePayload } from '@shared/ipc'

contextBridge.exposeInMainWorld('overlay', {
  onSubtitle: (cb: (p: SubtitlePayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: SubtitlePayload) => cb(p)
    ipcRenderer.on(IPC.subtitleUpdate, listener)
    return () => ipcRenderer.removeListener(IPC.subtitleUpdate, listener)
  },
  onConfig: (cb: (c: OverlayConfig) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, c: OverlayConfig) => cb(c)
    ipcRenderer.on(IPC.overlayConfig, listener)
    return () => ipcRenderer.removeListener(IPC.overlayConfig, listener)
  },
  onStatus: (cb: (s: SessionStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, s: SessionStatus) => cb(s)
    ipcRenderer.on(IPC.overlayStatus, listener)
    return () => ipcRenderer.removeListener(IPC.overlayStatus, listener)
  },
})
