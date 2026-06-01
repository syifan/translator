import { useEffect, useMemo, useState } from 'react'
import type { SessionStatus, Settings } from '@shared/ipc'
import { isCapturing, startCapture, stopCapture } from './capture'

const LANGUAGES = [
  'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese',
  'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean',
  'Russian', 'Arabic', 'Hindi', 'Dutch', 'Turkish', 'Vietnamese', 'Thai',
  'Polish', 'Ukrainian', 'Indonesian', 'Swedish', 'Greek', 'Hebrew',
]

// Suggestions only — the fields accept any model name your key can access.
// gpt-4o-transcribe works with automatic (server-VAD) segmentation, which is
// what the pipeline uses. gpt-realtime-whisper needs manual buffer commits, so
// it's intentionally not a default/suggestion yet.
const TRANSCRIBE_MODELS = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']
const TRANSLATE_MODELS = [
  'gpt-4o-mini',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.5',
  'gpt-5-chat-latest',
]

const STATUS_META: Record<SessionStatus['state'], { label: string; color: string }> = {
  idle: { label: 'Idle', color: '#7b8499' },
  starting: { label: 'Starting…', color: '#e0a44b' },
  running: { label: 'Live', color: '#3ecf8e' },
  error: { label: 'Error', color: '#f0616d' },
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [hasKey, setHasKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [status, setStatus] = useState<SessionStatus>({ state: 'idle' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
    void window.api.hasKey().then(setHasKey)
    const offStatus = window.api.onStatus((s) => {
      setStatus(s)
      if ((s.state === 'idle' || s.state === 'error') && isCapturing()) void stopCapture()
    })
    const offStop = window.capture.onStopCapture(() => {
      if (isCapturing()) void stopCapture()
    })
    return () => {
      offStatus()
      offStop()
    }
  }, [])

  const active = status.state === 'running' || status.state === 'starting'

  function update(partial: Partial<Settings>) {
    setSettings((prev) => (prev ? { ...prev, ...partial } : prev))
    void window.api.setSettings(partial)
  }

  async function saveKey() {
    const key = keyInput.trim()
    if (!key) return
    setKeySaving(true)
    try {
      await window.api.setKey(key)
      setHasKey(true)
      setKeyInput('')
    } finally {
      setKeySaving(false)
    }
  }

  async function clearKey() {
    await window.api.clearKey()
    setHasKey(false)
  }

  async function start() {
    if (!settings || busy) return
    setBusy(true)
    try {
      await startCapture(settings.micEnabled)
      await window.api.startSession()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      window.capture.reportError(message)
      if (isCapturing()) await stopCapture()
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    try {
      await window.api.stopSession()
    } finally {
      if (isCapturing()) await stopCapture()
      setBusy(false)
    }
  }

  const meta = STATUS_META[status.state]

  if (!settings) {
    return <div style={S.loading}>Loading…</div>
  }

  return (
    <div style={S.page}>
      <header style={S.header}>
        <h1 style={S.title}>Live Translator</h1>
        <span style={{ ...S.pill, color: meta.color, borderColor: meta.color }}>
          <span style={{ ...S.dot, background: meta.color }} />
          {meta.label}
        </span>
      </header>

      <Section title="OpenAI API key">
        {hasKey ? (
          <div style={S.row}>
            <span style={S.keySaved}>✓ Key saved (stored encrypted)</span>
            <button style={S.ghostBtn} onClick={clearKey} disabled={active}>
              Replace / clear
            </button>
          </div>
        ) : (
          <div style={S.row}>
            <input
              style={S.input}
              type="password"
              placeholder="sk-…"
              value={keyInput}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey()
              }}
            />
            <button style={S.primarySmall} onClick={saveKey} disabled={keySaving || !keyInput.trim()}>
              {keySaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
        <p style={S.hint}>Used only on your machine to call OpenAI for transcription &amp; translation.</p>
      </Section>

      <Section title="Languages">
        <Field label="Translate into">
          <select style={S.select} value={settings.targetLang} onChange={(e) => update({ targetLang: e.target.value })}>
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </Field>
        <Field label="Spoken language">
          <select style={S.select} value={settings.sourceLang} onChange={(e) => update({ sourceLang: e.target.value })}>
            <option value="auto">Auto-detect</option>
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Audio">
        <Toggle
          label="Include microphone"
          hint="Mix your mic in (useful for live calls)"
          checked={settings.micEnabled}
          disabled={active}
          onChange={(v) => update({ micEnabled: v })}
        />
      </Section>

      <Section title="Overlay">
        <Field label={`Font size — ${settings.fontSize}px`}>
          <input
            style={S.slider} type="range" min={16} max={56} step={1}
            value={settings.fontSize}
            onChange={(e) => update({ fontSize: Number(e.target.value) })}
          />
        </Field>
        <Field label={`Background — ${Math.round(settings.opacity * 100)}%`}>
          <input
            style={S.slider} type="range" min={0} max={1} step={0.05}
            value={settings.opacity}
            onChange={(e) => update({ opacity: Number(e.target.value) })}
          />
        </Field>
        <Field label={`Keep on screen — ${settings.holdSeconds}s`}>
          <input
            style={S.slider} type="range" min={2} max={20} step={1}
            value={settings.holdSeconds}
            onChange={(e) => update({ holdSeconds: Number(e.target.value) })}
          />
        </Field>
        <Toggle
          label="Show original text"
          checked={settings.showOriginal}
          onChange={(v) => update({ showOriginal: v })}
        />
      </Section>

      <Section title="Models">
        <Field label="Transcription (speech-to-text)">
          <Combo
            listId="transcribe-models"
            value={settings.transcribeModel}
            options={TRANSCRIBE_MODELS}
            disabled={active}
            onChange={(v) => update({ transcribeModel: v })}
          />
        </Field>
        <Field label="Translation (chat model)">
          <Combo
            listId="translate-models"
            value={settings.translateModel}
            options={TRANSLATE_MODELS}
            disabled={active}
            onChange={(v) => update({ translateModel: v })}
          />
        </Field>
        <p style={S.hint}>Type any model your API key can access — the list is just suggestions.</p>
      </Section>

      <div style={S.footer}>
        {status.state === 'error' && status.message ? (
          <div style={S.error}>{status.message}</div>
        ) : null}
        {!hasKey ? <div style={S.warn}>Add your API key to start.</div> : null}
        <button
          style={active ? S.stopBtn : S.startBtn}
          onClick={active ? stop : start}
          disabled={busy || (!active && !hasKey)}
        >
          {active ? 'Stop' : busy ? 'Starting…' : 'Start translating'}
        </button>
        <p style={S.shortcuts}>⌘⇧T stop · ⌘⇧O toggle overlay</p>
      </div>
    </div>
  )
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section style={S.section}>
      <h2 style={S.sectionTitle}>{props.title}</h2>
      {props.children}
    </section>
  )
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label style={S.field}>
      <span style={S.fieldLabel}>{props.label}</span>
      {props.children}
    </label>
  )
}

function Toggle(props: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label style={{ ...S.toggleRow, opacity: props.disabled ? 0.5 : 1 }}>
      <span>
        <span style={S.toggleLabel}>{props.label}</span>
        {props.hint ? <span style={S.toggleHint}>{props.hint}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        style={S.checkbox}
      />
    </label>
  )
}

function Combo(props: {
  listId: string
  value: string
  options: string[]
  disabled?: boolean
  onChange: (v: string) => void
}) {
  return (
    <>
      <input
        style={S.select}
        list={props.listId}
        value={props.value}
        disabled={props.disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => props.onChange(e.target.value)}
      />
      <datalist id={props.listId}>
        {props.options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  )
}

const S: Record<string, React.CSSProperties> = {
  loading: { color: '#9aa3b2', padding: 40, fontFamily: 'system-ui' },
  page: {
    fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    color: '#e7eaf0',
    padding: '18px 20px 24px',
    background: '#0b0f1a',
    minHeight: '100vh',
    boxSizing: 'border-box',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 18, fontWeight: 700, margin: 0, letterSpacing: 0.2 },
  pill: {
    display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600,
    padding: '4px 10px', borderRadius: 999, border: '1px solid', background: 'rgba(255,255,255,0.03)',
  },
  dot: { width: 7, height: 7, borderRadius: 999, display: 'inline-block' },
  section: {
    background: '#121826', border: '1px solid #1f2839', borderRadius: 12,
    padding: '14px 16px', marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2,
    color: '#7b8499', margin: '0 0 10px',
  },
  row: { display: 'flex', gap: 8, alignItems: 'center' },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 },
  fieldLabel: { fontSize: 12, color: '#9aa3b2' },
  input: {
    flex: 1, background: '#0b0f1a', border: '1px solid #2a3447', color: '#e7eaf0',
    borderRadius: 8, padding: '9px 11px', fontSize: 13, outline: 'none',
  },
  select: {
    background: '#0b0f1a', border: '1px solid #2a3447', color: '#e7eaf0',
    borderRadius: 8, padding: '9px 11px', fontSize: 13, outline: 'none', width: '100%',
  },
  slider: { width: '100%', accentColor: '#3b82f6' },
  hint: { fontSize: 11, color: '#6b7488', margin: '8px 0 0' },
  keySaved: { flex: 1, fontSize: 13, color: '#3ecf8e' },
  toggleRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '4px 0', cursor: 'pointer',
  },
  toggleLabel: { fontSize: 13, display: 'block' },
  toggleHint: { fontSize: 11, color: '#6b7488', display: 'block', marginTop: 2 },
  checkbox: { width: 18, height: 18, accentColor: '#3b82f6' },
  footer: { marginTop: 4 },
  error: {
    background: 'rgba(240,97,109,0.12)', border: '1px solid rgba(240,97,109,0.4)',
    color: '#ff97a0', borderRadius: 8, padding: '9px 11px', fontSize: 12, marginBottom: 10,
  },
  warn: { color: '#e0a44b', fontSize: 12, marginBottom: 10, textAlign: 'center' },
  startBtn: {
    width: '100%', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 10,
    padding: '13px', fontSize: 15, fontWeight: 700, cursor: 'pointer',
  },
  stopBtn: {
    width: '100%', background: '#f0616d', color: '#fff', border: 'none', borderRadius: 10,
    padding: '13px', fontSize: 15, fontWeight: 700, cursor: 'pointer',
  },
  primarySmall: {
    background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8,
    padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  ghostBtn: {
    background: 'transparent', color: '#9aa3b2', border: '1px solid #2a3447',
    borderRadius: 8, padding: '7px 10px', fontSize: 12, cursor: 'pointer',
  },
  shortcuts: {
    textAlign: 'center', color: '#5b6478', fontSize: 11, margin: '10px 0 0',
  },
}
