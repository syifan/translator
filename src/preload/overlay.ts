import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type OverlayConfig, type SubtitlePayload } from '@shared/ipc'

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
})
