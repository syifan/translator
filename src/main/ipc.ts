import { BrowserWindow, ipcMain } from 'electron'
import { IPC, type Settings } from '@shared/ipc'
import type { SessionManager } from './session'
import { store } from './store'
import * as secrets from './secrets'

export function registerIpc(
  session: SessionManager,
  _windows: { control: BrowserWindow; overlay: BrowserWindow },
): void {
  ipcMain.handle(IPC.getSettings, () => store.get())
  ipcMain.handle(IPC.setSettings, (_e, partial: Partial<Settings>) => {
    const next = store.set(partial)
    session.applySettings(next)
    return next
  })

  ipcMain.handle(IPC.hasKey, () => secrets.hasKey())
  ipcMain.handle(IPC.setKey, (_e, key: string) => secrets.setKey(key))
  ipcMain.handle(IPC.clearKey, () => secrets.clearKey())

  ipcMain.handle(IPC.startSession, () => session.start())
  ipcMain.handle(IPC.stopSession, () => session.stop())

  // High-frequency audio frames + capture-side errors (fire-and-forget).
  ipcMain.on(IPC.audioPcm, (_e, buf: ArrayBuffer) => session.pushAudio(buf))
  ipcMain.on(IPC.captureError, (_e, msg: string) => session.onCaptureError(msg))
}
