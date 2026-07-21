import { BrowserWindow, ipcMain, screen } from 'electron'
import { IPC, type DisplayInfo, type Settings } from '@shared/ipc'
import type { SessionManager } from './session'
import { store } from './store'
import * as secrets from './secrets'
import { positionOverlay } from './windows'

function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `${d.label || `Display ${i + 1}`} (${d.size.width}×${d.size.height})`,
    primary: d.id === primaryId,
  }))
}

export function registerIpc(
  session: SessionManager,
  windows: { control: BrowserWindow; overlay: BrowserWindow },
): void {
  ipcMain.handle(IPC.getSettings, () => store.get())
  ipcMain.handle(IPC.setSettings, (_e, partial: Partial<Settings>) => {
    const next = store.set(partial)
    session.applySettings(next)
    if ('displayId' in partial) positionOverlay(windows.overlay, next.displayId)
    return next
  })

  ipcMain.handle(IPC.getDisplays, () => listDisplays())

  // Keep the overlay on a valid display and the picker in sync when monitors
  // are plugged/unplugged.
  const onDisplaysChanged = (): void => {
    positionOverlay(windows.overlay, store.get().displayId)
    if (!windows.control.isDestroyed()) {
      windows.control.webContents.send(IPC.displaysChanged, listDisplays())
    }
  }
  screen.on('display-added', onDisplaysChanged)
  screen.on('display-removed', onDisplaysChanged)
  screen.on('display-metrics-changed', onDisplaysChanged)

  ipcMain.handle(IPC.hasKey, () => secrets.hasKey())
  ipcMain.handle(IPC.setKey, (_e, key: string) => secrets.setKey(key))
  ipcMain.handle(IPC.clearKey, () => secrets.clearKey())

  ipcMain.handle(IPC.startSession, () => session.start())
  ipcMain.handle(IPC.stopSession, () => session.stop())

  // High-frequency audio frames + capture-side errors (fire-and-forget).
  ipcMain.on(IPC.audioPcm, (_e, buf: ArrayBuffer) => session.pushAudio(buf))
  ipcMain.on(IPC.captureError, (_e, msg: string) => session.onCaptureError(msg))
}
