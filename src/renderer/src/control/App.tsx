import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Download, Settings as SettingsIcon, Trash2, Zap } from 'lucide-react'
import {
  REALTIME_TRANSLATE_CODES,
  type DisplayInfo,
  type QuickStart,
  type SessionStatus,
  type Settings,
  type TranscriptEntryPayload,
  type TranscriptFileInfo,
  type TranscriptPartialPayload,
} from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { isCapturing, startCapture, stopCapture } from './capture'

// Target languages = the output languages gpt-realtime-translate supports.
const LANGUAGES = Object.keys(REALTIME_TRANSLATE_CODES)

const STATUS_META: Record<SessionStatus['state'], { label: string; dot: string }> = {
  idle: { label: 'Idle', dot: 'bg-muted-foreground' },
  starting: { label: 'Starting…', dot: 'bg-amber-400' },
  running: { label: 'Live', dot: 'bg-emerald-400' },
  error: { label: 'Error', dot: 'bg-red-400' },
}

/** Row of a displayed note — the live payload and parsed saved files share it. */
interface NoteRow {
  time: string
  original: string
  translation: string
  /** Realtime draft not yet upgraded by the high-accuracy pass. */
  draft?: boolean
}

/** Parse the Markdown we write in transcript-log.ts back into rows. */
function parseTranscriptMd(md: string): NoteRow[] {
  const rows: NoteRow[] = []
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('# ')) continue
    const m = /^\*\*\[(\d{2}:\d{2}:\d{2})\]\*\*\s*(.*)$/.exec(line)
    if (m) {
      rows.push({ time: m[1], original: m[2], translation: '' })
    } else if (line.startsWith('> ') && rows.length > 0) {
      const last = rows[rows.length - 1]
      last.translation = last.translation ? `${last.translation} ${line.slice(2)}` : line.slice(2)
    } else if (rows.length > 0) {
      rows.push({ time: '', original: line, translation: '' })
    }
  }
  return rows
}

function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8)
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [hasKey, setHasKey] = useState(false)
  const [status, setStatus] = useState<SessionStatus>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Notes sidebar: 'live' is the in-memory session; strings are saved files.
  const [notes, setNotes] = useState<TranscriptFileInfo[]>([])
  const [selected, setSelected] = useState<string>('live')
  const [noteRows, setNoteRows] = useState<NoteRow[]>([])
  const [noteError, setNoteError] = useState<string | null>(null)
  // File name whose download just finished (briefly shows a checkmark).
  const [downloaded, setDownloaded] = useState<string | null>(null)
  const [quickstarts, setQuickstarts] = useState<QuickStart[]>([])
  // Live transcript state.
  const [entries, setEntries] = useState<TranscriptEntryPayload[]>([])
  const [partial, setPartial] = useState<TranscriptPartialPayload>({ original: '', translation: '' })
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const refreshNotes = useCallback(() => {
    void window.api.listTranscripts().then(setNotes)
  }, [])

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
    void window.api.hasKey().then(setHasKey)
    void window.api.getDisplays().then(setDisplays)
    void window.api.listQuickStarts().then(setQuickstarts)
    refreshNotes()
    const offDisplays = window.api.onDisplaysChanged(setDisplays)
    const offStatus = window.api.onStatus((s) => {
      setStatus(s)
      if (s.state === 'starting') {
        setEntries([])
        setPartial({ original: '', translation: '' })
        setSelected('live')
      }
      if ((s.state === 'idle' || s.state === 'error') && isCapturing()) void stopCapture()
    })
    const offStop = window.capture.onStopCapture(() => {
      if (isCapturing()) void stopCapture()
    })
    const offSaved = window.api.onTranscriptSaved(() => refreshNotes())
    const offReplace = window.api.onTranscriptReplace(setEntries)
    const offPartial = window.api.onTranscriptPartial(setPartial)
    return () => {
      offStatus()
      offStop()
      offDisplays()
      offSaved()
      offReplace()
      offPartial()
    }
  }, [refreshNotes])

  // Load a saved note when selected.
  useEffect(() => {
    if (selected === 'live') return
    setNoteRows([])
    setNoteError(null)
    window.api
      .readTranscript(selected)
      .then((md) => setNoteRows(parseTranscriptMd(md)))
      .catch(() => setNoteError('Could not read this transcript.'))
  }, [selected])

  // Keep the live transcript pinned to the bottom as text streams in.
  useEffect(() => {
    if (selected !== 'live') return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, partial, selected])

  const active = status.state === 'running' || status.state === 'starting'

  function update(partialSettings: Partial<Settings>) {
    setSettings((prev) => (prev ? { ...prev, ...partialSettings } : prev))
    void window.api.setSettings(partialSettings)
  }

  async function start(withSettings?: Settings) {
    const s = withSettings ?? settings
    if (!s || busy) return
    setBusy(true)
    try {
      await startCapture({ system: s.systemAudioEnabled, mic: s.micEnabled })
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

  async function deleteNote(fileName: string) {
    await window.api.deleteTranscript(fileName)
    if (selected === fileName) setSelected('live')
    refreshNotes()
  }

  /** Apply a saved quick start's settings, then start the session with them. */
  async function runQuickStart(qs: QuickStart) {
    if (busy || active) return
    const next = await window.api.setSettings(qs.settings)
    setSettings(next)
    await start(next)
  }

  async function downloadNote(fileName: string) {
    await window.api.downloadTranscript(fileName)
    setDownloaded(fileName)
    setTimeout(() => setDownloaded((cur) => (cur === fileName ? null : cur)), 1500)
  }

  const meta = STATUS_META[status.state]

  if (!settings) {
    return <div className="p-10 text-muted-foreground">Loading…</div>
  }

  const inputsOff = !settings.systemAudioEnabled && !settings.micEnabled
  const hasPartial = !!(partial.original.trim() || partial.translation.trim())
  const liveEmpty = entries.length === 0 && !hasPartial

  const liveRows: NoteRow[] = entries.map((e) => ({
    time: clock(e.time),
    original: e.original,
    translation: e.translation,
    draft: !e.refined,
  }))

  return (
    <div className="flex h-screen flex-col">
      {/* Toolbar (draggable, inset for the macOS traffic lights) */}
      <header className="flex h-13 shrink-0 items-center gap-3 border-b pr-3.5 pl-21 [-webkit-app-region:drag]">
        <span className="text-sm font-semibold">Live Translator</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', meta.dot)} />
          {meta.label}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          <Button variant="ghost" size="icon-sm" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon />
            <span className="sr-only">Settings</span>
          </Button>
          {quickstarts.map((qs) => (
            <Button
              key={qs.name}
              size="sm"
              variant="secondary"
              title={`Quick start: ${qs.name} — right-click to delete`}
              onClick={() => void runQuickStart(qs)}
              onContextMenu={(e) => {
                e.preventDefault()
                void window.api.deleteQuickStart(qs.name).then(setQuickstarts)
              }}
              disabled={busy || active || !hasKey}
            >
              <Zap className="size-3.5" />
              {qs.name}
            </Button>
          ))}
          <Button
            size="sm"
            variant={active ? 'destructive' : 'default'}
            onClick={active ? stop : () => start()}
            disabled={busy || (!active && (!hasKey || inputsOff))}
          >
            {active ? 'Stop' : busy ? 'Starting…' : 'Start listening'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Notes sidebar */}
        <aside className="flex w-56 shrink-0 flex-col border-r">
          <div className="px-4 pt-3 pb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            Notes
          </div>
          <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            <button
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/60',
                selected === 'live' && 'bg-accent text-accent-foreground',
              )}
              onClick={() => setSelected('live')}
            >
              <span className={cn('size-1.5 shrink-0 rounded-full', meta.dot)} />
              <span className="truncate">{active ? 'Live session' : 'Current session'}</span>
            </button>
            {notes.map((n) => (
              <div
                key={n.fileName}
                role="button"
                tabIndex={0}
                title={n.fileName.replace(/\.md$/, '')}
                className={cn(
                  'group flex w-full cursor-pointer items-center gap-1 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/60',
                  selected === n.fileName && 'bg-accent text-accent-foreground',
                )}
                onClick={() => setSelected(n.fileName)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setSelected(n.fileName)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{n.title}</span>
                {downloaded === n.fileName ? (
                  <Check className="size-3.5 shrink-0 text-emerald-400" />
                ) : (
                  <button
                    className="hidden shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
                    title="Download to Downloads folder"
                    onClick={(e) => {
                      e.stopPropagation()
                      void downloadNote(n.fileName)
                    }}
                  >
                    <Download className="size-3.5" />
                  </button>
                )}
                <button
                  className="hidden shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-red-400 group-hover:block"
                  title="Move to Trash"
                  onClick={(e) => {
                    e.stopPropagation()
                    void deleteNote(n.fileName)
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            {notes.length === 0 ? (
              <p className="px-2.5 py-1.5 text-xs text-muted-foreground">No saved notes yet.</p>
            ) : null}
          </nav>
        </aside>

        {/* Note / live transcript view */}
        <main className="flex min-w-0 flex-1 flex-col">
          {status.state === 'error' && status.message ? (
            <div className="border-b border-red-400/30 bg-red-400/10 px-4 py-2 text-xs text-red-300">
              {status.message}
            </div>
          ) : null}
          {!hasKey || inputsOff ? (
            <div className="border-b border-amber-400/25 bg-amber-400/8 px-4 py-2 text-xs text-amber-300">
              {!hasKey ? 'Add your OpenAI API key in ' : 'Both audio inputs are off — enable one in '}
              <button
                className="cursor-pointer underline underline-offset-2"
                onClick={() => setSettingsOpen(true)}
              >
                Settings
              </button>
              {!hasKey ? ' to start.' : '.'}
            </div>
          ) : null}

          <div ref={scrollRef} className="flex-1 cursor-text overflow-y-auto px-5 py-4 select-text">
            {selected === 'live' ? (
              liveEmpty ? (
                <EmptyState
                  text={
                    active
                      ? settings.liveNotes
                        ? 'Listening — the transcript will appear here.'
                        : 'Listening — the high-accuracy transcript appears every few minutes.'
                      : 'Press “Start listening” to begin a new session. Finished sessions appear in the Notes list.'
                  }
                />
              ) : (
                <>
                  {liveRows.map((r, i) => (
                    <NoteRowView key={i} row={r} />
                  ))}
                  {hasPartial ? (
                    <NoteRowView
                      row={{
                        time: clock(Date.now()),
                        original: partial.original.trim(),
                        translation: partial.translation.trim(),
                      }}
                      dim
                    />
                  ) : null}
                </>
              )
            ) : noteError ? (
              <EmptyState text={noteError} />
            ) : noteRows.length === 0 ? (
              <EmptyState text="This note is empty." />
            ) : (
              noteRows.map((r, i) => <NoteRowView key={i} row={r} />)
            )}
          </div>
        </main>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[80vh] gap-0 overflow-y-auto p-0 sm:max-w-md">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle className="text-base">Settings</DialogTitle>
          </DialogHeader>
          <SettingsContent
            settings={settings}
            hasKey={hasKey}
            setHasKey={setHasKey}
            active={active}
            displays={displays}
            update={update}
            quickstarts={quickstarts}
            setQuickstarts={setQuickstarts}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-full cursor-default items-center justify-center px-10 text-center text-[13px] text-muted-foreground select-none">
      {text}
    </div>
  )
}

function NoteRowView({ row, dim }: { row: NoteRow; dim?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-baseline gap-3 py-1.5',
        dim && 'opacity-55 italic',
        // Draft rows are slightly muted until the high-accuracy pass lands.
        !dim && row.draft && 'opacity-75',
      )}
    >
      <span className="w-14 shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {row.time}
      </span>
      <div className="min-w-0 flex-1">
        {row.original ? (
          <div className="text-sm leading-relaxed break-words">{row.original}</div>
        ) : null}
        {row.translation ? (
          <div className="mt-0.5 text-[13px] leading-relaxed break-words text-sky-300/90">
            {row.translation}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b px-5 py-4 last:border-b-0">
      <h3 className="mb-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function ToggleRow(props: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm">{props.label}</div>
        {props.hint ? <div className="text-xs text-muted-foreground">{props.hint}</div> : null}
      </div>
      <Switch checked={props.checked} disabled={props.disabled} onCheckedChange={props.onChange} />
    </div>
  )
}

function SliderRow(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground">{props.label}</div>
      <Slider
        value={[props.value]}
        min={props.min}
        max={props.max}
        step={props.step}
        onValueChange={([v]) => props.onChange(v)}
      />
    </div>
  )
}

function SettingsContent(props: {
  settings: Settings
  hasKey: boolean
  setHasKey: (v: boolean) => void
  active: boolean
  displays: DisplayInfo[]
  update: (p: Partial<Settings>) => void
  quickstarts: QuickStart[]
  setQuickstarts: (q: QuickStart[]) => void
}) {
  const { settings, hasKey, setHasKey, active, displays, update, quickstarts, setQuickstarts } =
    props
  const [keyInput, setKeyInput] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [qsName, setQsName] = useState('')

  async function saveQuickStart() {
    const name = qsName.trim()
    if (!name) return
    setQuickstarts(await window.api.saveQuickStart(name))
    setQsName('')
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

  return (
    <div>
      <SettingsSection title="AI">
        {hasKey ? (
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-emerald-400">✓ OpenAI API key saved</span>
            <Button variant="outline" size="sm" onClick={clearKey} disabled={active}>
              Clear
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="OpenAI API key (sk-…)"
              value={keyInput}
              spellCheck={false}
              autoComplete="off"
              className="h-8"
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey()
              }}
            />
            <Button size="sm" onClick={saveKey} disabled={keySaving || !keyInput.trim()}>
              {keySaving ? '…' : 'Save'}
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Used only on your machine to call OpenAI for transcription &amp; translation.
        </p>
      </SettingsSection>

      <SettingsSection title="Input">
        <ToggleRow
          label="System audio"
          hint="Capture what your Mac is playing"
          checked={settings.systemAudioEnabled}
          disabled={active}
          onChange={(v) => update({ systemAudioEnabled: v })}
        />
        <ToggleRow
          label="Microphone"
          hint="Mix your mic in (for live calls)"
          checked={settings.micEnabled}
          disabled={active}
          onChange={(v) => update({ micEnabled: v })}
        />
      </SettingsSection>

      <SettingsSection title="Caption">
        <ToggleRow
          label="Captions"
          hint="Show the original (as-spoken) line on the overlay"
          checked={settings.showOriginal}
          onChange={(v) => update({ showOriginal: v })}
        />
      </SettingsSection>

      <SettingsSection title="Translation">
        <ToggleRow
          label="Translation"
          hint="Off = transcribe only (cheaper)"
          checked={settings.showTranslation}
          disabled={active}
          onChange={(v) => update({ showTranslation: v })}
        />
        {settings.showTranslation ? (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">Translate into</div>
            <Select
              value={settings.targetLang}
              disabled={active}
              onValueChange={(v) => update({ targetLang: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Notes">
        <ToggleRow
          label="Save notes"
          hint="Keep a Markdown note of each session (can be turned off mid-session)"
          checked={settings.notesEnabled}
          onChange={(v) => update({ notesEnabled: v })}
        />
        {settings.notesEnabled ? (
          <ToggleRow
            label="Real-time note"
            hint="Show the live draft instantly; the high-accuracy pass replaces it. Off = note builds every few minutes (cheaper when the overlay is off)."
            checked={settings.liveNotes}
            disabled={active}
            onChange={(v) => update({ liveNotes: v })}
          />
        ) : null}
        {settings.notesEnabled ? (
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Include in notes</div>
          <Select
            value={settings.noteContent}
            disabled={active}
            onValueChange={(v) => update({ noteContent: v as Settings['noteContent'] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="both">Transcript + translation</SelectItem>
              <SelectItem value="original">Transcript only</SelectItem>
              <SelectItem value="translation">Translation only</SelectItem>
            </SelectContent>
          </Select>
          {!settings.showTranslation && settings.noteContent !== 'original' ? (
            <p className="text-xs text-muted-foreground">
              Translation is off, so notes fall back to the transcript.
            </p>
          ) : null}
        </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Overlay UI">
        {displays.length > 1 ? (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">Display</div>
            <Select
              value={String(settings.displayId ?? displays.find((d) => d.primary)?.id ?? '')}
              onValueChange={(v) => update({ displayId: Number(v) })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {displays.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.label}
                    {d.primary ? ' — main' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <SliderRow
          label={`Font size — ${settings.fontSize}px`}
          value={settings.fontSize}
          min={16}
          max={56}
          step={1}
          onChange={(v) => update({ fontSize: v })}
        />
        <SliderRow
          label={`Background — ${Math.round(settings.opacity * 100)}%`}
          value={settings.opacity}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => update({ opacity: v })}
        />
        <SliderRow
          label={`Keep on screen — ${settings.holdSeconds}s`}
          value={settings.holdSeconds}
          min={2}
          max={20}
          step={1}
          onChange={(v) => update({ holdSeconds: v })}
        />
        <SliderRow
          label={`Lines shown — ${settings.maxLines}`}
          value={settings.maxLines}
          min={1}
          max={5}
          step={1}
          onChange={(v) => update({ maxLines: v })}
        />
      </SettingsSection>

      <SettingsSection title="Quick start">
        {quickstarts.map((qs) => (
          <div key={qs.name} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-sm">
              <Zap className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{qs.name}</span>
            </span>
            <button
              className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-red-400"
              title="Delete quick start"
              onClick={async () => setQuickstarts(await window.api.deleteQuickStart(qs.name))}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <Input
            placeholder="Name (e.g. “Meeting → EN”)"
            value={qsName}
            className="h-8"
            onChange={(e) => setQsName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveQuickStart()
            }}
          />
          <Button size="sm" onClick={saveQuickStart} disabled={!qsName.trim()}>
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Saves the settings above under a name — it appears as a one-click start button in the
          toolbar.
        </p>
        <p className="pt-1 text-center text-[11px] text-muted-foreground">
          ⌘⇧T stop · ⌘⇧O toggle overlay
        </p>
      </SettingsSection>
    </div>
  )
}
