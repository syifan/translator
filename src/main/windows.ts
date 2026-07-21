import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

const isDev = !!process.env.ELECTRON_RENDERER_URL

function loadPage(win: BrowserWindow, page: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}.html`))
  }
}

function preloadPath(name: string): string {
  return join(__dirname, `../preload/${name}.js`)
}

export function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 720,
    minWidth: 380,
    minHeight: 560,
    title: 'Live Translator',
    show: false,
    backgroundColor: '#0b0f1a',
    webPreferences: {
      preload: preloadPath('control'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the audio worklet running while the window is hidden in the tray.
      backgroundThrottling: false,
    },
  })

  win.once('ready-to-show', () => win.show())
  if (isDev) win.webContents.openDevTools({ mode: 'detach' })
  loadPage(win, 'control')
  return win
}

export function createOverlayWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = Math.min(1100, workArea.width - 80)
  const height = 320

  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 48),
    // 'panel' (NSPanel) is what lets the window float over OTHER apps' native
    // fullscreen Spaces — a normal window stays behind them on macOS.
    type: 'panel',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: preloadPath('overlay'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  // Click-through: pointer events pass to the app underneath.
  win.setIgnoreMouseEvents(true, { forward: true })

  // Apply the float-over-fullscreen behavior once the window is ready (applying
  // it at creation races and often fails to stick on macOS).
  win.once('ready-to-show', () => applyOverlayFloat(win))

  loadPage(win, 'overlay')
  return win
}

/**
 * Make the overlay float above everything — including OTHER apps' native
 * fullscreen Spaces. Order matters: set the all-Spaces collection behavior
 * first, then the window level. Safe to call repeatedly (e.g. each time the
 * overlay is shown) to re-assert over a fullscreen app.
 */
export function applyOverlayFloat(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  // skipTransformProcessType: without it, visibleOnFullScreen flips the app to
  // the "accessory" activation policy, which hides the Dock icon. The overlay
  // is an NSPanel, so it floats over fullscreen without that transform.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })
  win.setAlwaysOnTop(true, 'screen-saver')
}
