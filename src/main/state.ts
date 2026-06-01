// Tiny shared mutable state for the main process (avoids circular imports
// between index.ts and tray.ts).
export const appState = { quitting: false }
