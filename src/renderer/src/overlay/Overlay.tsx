import { useEffect, useRef, useState } from 'react'
import type { OverlayConfig, SessionStatus, SubtitlePayload } from '@shared/ipc'

const DEFAULT_CONFIG: OverlayConfig = {
  fontSize: 30,
  opacity: 0.55,
  holdSeconds: 6,
  maxLines: 3,
  showOriginal: true,
}

export function Overlay() {
  // Ordered list of sentence "units", keyed by itemId. Newest is last.
  const [units, setUnits] = useState<SubtitlePayload[]>([])
  const [cfg, setCfg] = useState<OverlayConfig>(DEFAULT_CONFIG)
  const [status, setStatus] = useState<SessionStatus>({ state: 'idle' })

  // Latest config reachable from the mount-only subtitle listener.
  const cfgRef = useRef(cfg)
  useEffect(() => {
    cfgRef.current = cfg
  }, [cfg])

  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | null = null
    const offSub = window.overlay.onSubtitle((p) => {
      setUnits((prev) => {
        const maxLines = Math.max(1, cfgRef.current.maxLines || 1)
        const idx = prev.findIndex((u) => u.itemId === p.itemId)
        // Empty payload => remove that unit (e.g. the live tail on finalize).
        if (!p.original && !p.translation) {
          return idx >= 0 ? prev.filter((_, i) => i !== idx) : prev
        }
        let next: SubtitlePayload[]
        if (idx >= 0) {
          next = prev.slice()
          next[idx] = p // update in place, preserving order
        } else {
          next = [...prev, p]
        }
        return next.length > maxLines ? next.slice(next.length - maxLines) : next
      })
      // Clear everything only after `holdSeconds` of no updates.
      if (clearTimer) clearTimeout(clearTimer)
      clearTimer = setTimeout(() => setUnits([]), Math.max(1, cfgRef.current.holdSeconds) * 1000)
    })
    const offCfg = window.overlay.onConfig((c) => setCfg(c))
    const offStatus = window.overlay.onStatus((s) => setStatus(s))
    return () => {
      offSub()
      offCfg()
      offStatus()
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [])

  const bg = `rgba(0, 0, 0, ${cfg.opacity})`

  if (units.length === 0) {
    const hint =
      status.state === 'running' ? '● Listening…' : status.state === 'starting' ? 'Connecting…' : null
    if (!hint) return null
    return (
      <div style={{ ...container, justifyContent: 'flex-end', alignItems: 'center' }}>
        <div style={{ background: bg, color: '#cfd4de', fontSize: 14, fontWeight: 600, padding: '4px 12px', borderRadius: 999, opacity: 0.85 }}>
          {hint}
        </div>
      </div>
    )
  }

  return (
    <div style={container}>
      {units.map((u, i) => {
        const newest = i === units.length - 1
        const transSize = Math.round(cfg.fontSize * (newest ? 1 : 0.8))
        const origSize = Math.round(transSize * 0.68)
        return (
          <div
            key={u.itemId}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, maxWidth: '94%', opacity: newest ? 1 : 0.7 }}
          >
            {cfg.showOriginal && u.original ? (
              <div
                style={{
                  background: bg, color: '#d6dae3', fontSize: origSize, fontWeight: 500, lineHeight: 1.25,
                  padding: '3px 12px', borderRadius: 9, textAlign: 'center', textShadow: '0 1px 3px rgba(0,0,0,0.9)',
                  backdropFilter: 'blur(2px)',
                }}
              >
                {u.original}
              </div>
            ) : null}
            {u.translation ? (
              <div
                style={{
                  background: bg, color: '#ffffff', fontSize: transSize, fontWeight: 700, lineHeight: 1.3,
                  padding: '5px 16px', borderRadius: 12, textAlign: 'center', textShadow: '0 2px 5px rgba(0,0,0,0.95)',
                  backdropFilter: 'blur(2px)', opacity: u.isFinal ? 1 : 0.95,
                }}
              >
                {u.translation}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

const container: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 8,
  padding: 18,
  boxSizing: 'border-box',
  pointerEvents: 'none',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
}
