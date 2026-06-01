# Live Translator

A macOS desktop app that listens to your **system audio** (and, optionally, your
microphone), and uses OpenAI's **gpt-realtime-translate** model to show **both the
original transcript and a live translation as a floating subtitle overlay** on top
of everything — including fullscreen video.

You bring your own OpenAI API key; it's stored encrypted on your machine and only
ever used from the app's main process.

## How it works

```
control window (settings + audio capture)        overlay window (transparent, click-through)
        │  getDisplayMedia loopback + mic                    ▲ original + translation
        │  → AudioWorklet → 24kHz mono PCM16                 │
        ▼  (IPC: audio frames)                               │ (IPC: subtitles)
                       main process
   gpt-realtime-translate  (one WebSocket session)
   streams source transcript + translated transcript, pace-matched
```

- **Engine:** a single `gpt-realtime-translate` Realtime session
  (`wss://api.openai.com/v1/realtime/translations`) that streams the source
  transcript (`session.input_transcript.delta`) and the translation
  (`session.output_transcript.delta`) continuously as you speak — no per-sentence
  round trips. The translated audio it also produces is ignored; we use only text.
- **Languages:** source is auto-detected (70+ languages); the target must be one of
  the model's 13 output languages (English, Spanish, Portuguese, French, German,
  Italian, Japanese, Korean, Chinese, Russian, Hindi, Indonesian, Vietnamese).
- **System audio:** captured via Electron's CoreAudio Tap loopback — no virtual
  audio driver needed.

## Requirements

- macOS 13+ (developed on macOS 26, Apple Silicon)
- Node.js 20+
- An OpenAI API key with access to `gpt-realtime-translate`

## Develop

```bash
npm install
npm run gen:icons   # generates the tray icon (one-time / after edits)
npm run dev
```

On first run macOS will ask for permissions:

1. **Microphone** — prompted automatically (only needed if you enable the mic).
2. **Screen & System Audio Recording** — grant it to the app under
   **System Settings → Privacy & Security → Screen & System Audio Recording**,
   then **restart the app**. This permission is what lets it capture system audio.

Then: paste your API key, pick a target language, and click **Start translating**.
Play any audio/video and the overlay appears at the bottom of the screen.

### Global shortcuts

- **⌘⇧T** — stop the session (or bring up the controls to start one)
- **⌘⇧O** — show/hide the overlay

## Build a macOS app

```bash
npm run package:dir   # unpacked .app in dist/  (fast, for local testing)
npm run dist          # .dmg in dist/
```

The build is unsigned. To run an unsigned build, right-click the app → Open the
first time (or clear the quarantine flag).

## Configuration

All settings (target language, mic, overlay font/opacity/lines/hold) are in the
control window and persist to `settings.json` in the app's user-data directory.
The API key is stored separately, encrypted via the OS keychain (`safeStorage`).

## Project layout

| Path | Role |
| --- | --- |
| `src/main/` | App lifecycle, windows, tray, IPC, session orchestration, OpenAI clients |
| `src/preload/` | `contextBridge` APIs for the control and overlay windows |
| `src/renderer/src/control/` | Settings UI (React) + audio capture pipeline |
| `src/renderer/src/overlay/` | Subtitle overlay (React) |
| `src/renderer/public/pcm-worklet.js` | AudioWorklet: downmix + resample to PCM16 |
| `src/shared/ipc.ts` | Shared IPC channel names + payload types |
