import { useEffect, useRef, useState } from 'react'
import type { OverlayConfig, SubtitlePayload } from '@shared/ipc'

const DEFAULT_CONFIG: OverlayConfig = {
  fontSize: 30,
  opacity: 0.55,
  holdSeconds: 6,
  maxLines: 2,
  showOriginal: true,
}

const EMPTY: SubtitlePayload = { itemId: '', original: '', translation: '', isFinal: false }

export function Overlay() {
  const [sub, setSub] = useState<SubtitlePayload>(EMPTY)
  const [cfg, setCfg] = useState<OverlayConfig>(DEFAULT_CONFIG)

  // Keep the latest hold time reachable from the mount-only subtitle listener.
  const holdRef = useRef(cfg.holdSeconds)
  useEffect(() => {
    holdRef.current = cfg.holdSeconds
  }, [cfg.holdSeconds])

  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | null = null
    const offSub = window.overlay.onSubtitle((p) => {
      // Ignore blank payloads so a pause never wipes the caption.
      if (!p.original && !p.translation) return
      setSub(p)
      // Clear only after `holdSeconds` of no further updates.
      if (clearTimer) clearTimeout(clearTimer)
      clearTimer = setTimeout(() => setSub(EMPTY), Math.max(1, holdRef.current) * 1000)
    })
    const offCfg = window.overlay.onConfig((c) => setCfg(c))
    return () => {
      offSub()
      offCfg()
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [])

  const hasContent = sub.original || sub.translation
  if (!hasContent) return null

  const bg = `rgba(0, 0, 0, ${cfg.opacity})`

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 6,
        padding: 18,
        boxSizing: 'border-box',
        pointerEvents: 'none',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      }}
    >
      {cfg.showOriginal && sub.original ? (
        <div
          style={{
            background: bg,
            color: '#d6dae3',
            fontSize: Math.round(cfg.fontSize * 0.68),
            fontWeight: 500,
            lineHeight: 1.25,
            padding: '4px 14px',
            borderRadius: 10,
            maxWidth: '92%',
            textAlign: 'center',
            textShadow: '0 1px 3px rgba(0,0,0,0.9)',
            backdropFilter: 'blur(2px)',
          }}
        >
          {sub.original}
        </div>
      ) : null}

      {sub.translation ? (
        <div
          style={{
            background: bg,
            color: '#ffffff',
            fontSize: cfg.fontSize,
            fontWeight: 700,
            lineHeight: 1.3,
            padding: '6px 18px',
            borderRadius: 12,
            maxWidth: '94%',
            textAlign: 'center',
            textShadow: '0 2px 5px rgba(0,0,0,0.95)',
            backdropFilter: 'blur(2px)',
            opacity: sub.isFinal ? 1 : 0.96,
          }}
        >
          {sub.translation}
        </div>
      ) : null}
    </div>
  )
}
