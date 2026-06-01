import { BrowserWindow, globalShortcut } from 'electron'
import type { SessionManager } from './session'

// Global hotkeys. Note: starting a session needs a user gesture in the control
// window (for getDisplayMedia), so the toggle hotkey *stops* when running and
// otherwise surfaces the control window so the user can press Start.
export function registerShortcuts(
  session: SessionManager,
  windows: { control: BrowserWindow; overlay: BrowserWindow },
): void {
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    if (session.isActive()) {
      session.stop()
    } else {
      windows.control.show()
      windows.control.focus()
    }
  })

  globalShortcut.register('CommandOrControl+Shift+O', () => {
    const overlay = windows.overlay
    if (overlay.isDestroyed()) return
    if (overlay.isVisible()) overlay.hide()
    else if (session.isActive()) overlay.showInactive()
  })
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
