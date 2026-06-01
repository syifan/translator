import { app, BrowserWindow } from 'electron'
import { initMain } from 'electron-audio-loopback'
import { createControlWindow, createOverlayWindow } from './windows'
import { registerIpc } from './ipc'
import { SessionManager } from './session'
import { createTray } from './tray'
import { registerShortcuts, unregisterShortcuts } from './shortcuts'
import { appState } from './state'

// IMPORTANT: must run before `app` is ready. It appends the Chromium feature
// switches that enable macOS system-audio loopback capture and registers the
// `enable-loopback-audio` / `disable-loopback-audio` IPC handlers.
initMain()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let control: BrowserWindow | undefined
  let overlay: BrowserWindow | undefined

  app.whenReady().then(() => {
    control = createControlWindow()
    overlay = createOverlayWindow()

    const session = new SessionManager({ control, overlay })
    registerIpc(session, { control, overlay })

    try {
      createTray(session, { control })
    } catch (err) {
      console.error('[main] tray init failed:', err)
    }

    registerShortcuts(session, { control, overlay })

    // Closing the control window hides it to the tray instead of quitting, so
    // the audio capture pipeline (which lives in that renderer) keeps running.
    control.on('close', (e) => {
      if (!appState.quitting) {
        e.preventDefault()
        control?.hide()
      }
    })

    console.log('[main] windows created')
  })

  app.on('second-instance', () => {
    control?.show()
    control?.focus()
  })

  app.on('activate', () => {
    control?.show()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    appState.quitting = true
  })

  app.on('will-quit', () => {
    unregisterShortcuts()
  })
}
