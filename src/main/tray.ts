import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import type { SessionManager } from './session'
import { appState } from './state'

let tray: Tray | null = null

export function createTray(
  session: SessionManager,
  windows: { control: BrowserWindow },
): Tray {
  const image = nativeImage.createFromPath(
    join(__dirname, '../../resources/trayTemplate.png'),
  )
  if (!image.isEmpty()) image.setTemplateImage(true)

  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('Live Translator')

  const menu = Menu.buildFromTemplate([
    {
      label: 'Show Controls',
      click: () => {
        windows.control.show()
        windows.control.focus()
      },
    },
    { type: 'separator' },
    { label: 'Start translating', click: () => void session.start() },
    { label: 'Stop', click: () => session.stop() },
    { type: 'separator' },
    {
      label: 'Quit',
      accelerator: 'CommandOrControl+Q',
      click: () => {
        appState.quitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(menu)
  return tray
}
