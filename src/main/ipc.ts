import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { copyFile, readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { IPC, type DisplayInfo, type Settings, type TranscriptFileInfo } from '@shared/ipc'
import type { SessionManager } from './session'
import { store } from './store'
import * as secrets from './secrets'
import { positionOverlay } from './windows'
import { transcriptsDir } from './transcript-log'
import { deleteQuickStart, listQuickStarts, saveQuickStart } from './quickstarts'

/** Title from a note's "# " heading; falls back to the file name's timestamp. */
async function noteTitle(path: string, fileName: string): Promise<string> {
  const fallback = fileName.replace(/\.md$/, '')
  try {
    const firstLine = (await readFile(path, 'utf8')).split('\n', 1)[0].trim()
    if (!firstLine.startsWith('# ')) return fallback
    // Pre-title default headings ("Transcript — <date>") read better as the date.
    return firstLine.slice(2).replace(/^Transcript — /, '') || fallback
  } catch {
    return fallback
  }
}

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

  ipcMain.handle(IPC.listQuickStarts, () => listQuickStarts())
  // Snapshot the CURRENT settings under the given name (upsert).
  ipcMain.handle(IPC.saveQuickStart, (_e, name: string) => saveQuickStart(name, store.get()))
  ipcMain.handle(IPC.deleteQuickStart, (_e, name: string) => deleteQuickStart(name))

  ipcMain.handle(IPC.hasKey, () => secrets.hasKey())
  ipcMain.handle(IPC.setKey, (_e, key: string) => secrets.setKey(key))
  ipcMain.handle(IPC.clearKey, () => secrets.clearKey())

  ipcMain.handle(IPC.listTranscripts, async (): Promise<TranscriptFileInfo[]> => {
    const dir = transcriptsDir()
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const infos = await Promise.all(
      names
        .filter((n) => n.endsWith('.md'))
        .map(async (n) => {
          const s = await stat(join(dir, n))
          return { fileName: n, mtimeMs: s.mtimeMs, title: await noteTitle(join(dir, n), n) }
        }),
    )
    return infos.sort((a, b) => b.mtimeMs - a.mtimeMs)
  })

  ipcMain.handle(IPC.deleteTranscript, async (_e, fileName: string) => {
    if (basename(fileName) !== fileName || !fileName.endsWith('.md')) {
      throw new Error('Invalid transcript file name')
    }
    // Recoverable delete: move to the macOS Trash instead of unlinking.
    await shell.trashItem(join(transcriptsDir(), fileName))
  })

  ipcMain.handle(IPC.downloadTranscript, async (_e, fileName: string): Promise<string> => {
    if (basename(fileName) !== fileName || !fileName.endsWith('.md')) {
      throw new Error('Invalid transcript file name')
    }
    const downloads = app.getPath('downloads')
    const stem = fileName.slice(0, -3)
    // Don't clobber an existing download: "name.md", "name (1).md", …
    let dest = join(downloads, fileName)
    for (let i = 1; existsSync(dest); i++) dest = join(downloads, `${stem} (${i}).md`)
    await copyFile(join(transcriptsDir(), fileName), dest)
    return dest
  })

  ipcMain.handle(IPC.readTranscript, async (_e, fileName: string): Promise<string> => {
    // Only bare .md file names inside the transcripts dir are ever read.
    if (basename(fileName) !== fileName || !fileName.endsWith('.md')) {
      throw new Error('Invalid transcript file name')
    }
    return readFile(join(transcriptsDir(), fileName), 'utf8')
  })

  ipcMain.handle(IPC.startSession, () => session.start())
  ipcMain.handle(IPC.stopSession, () => session.stop())

  // High-frequency audio frames + capture-side errors (fire-and-forget).
  ipcMain.on(IPC.audioPcm, (_e, buf: ArrayBuffer) => session.pushAudio(buf))
  ipcMain.on(IPC.captureError, (_e, msg: string) => session.onCaptureError(msg))
}
