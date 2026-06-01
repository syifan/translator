import WebSocket from 'ws'

export interface TranscriptionOptions {
  apiKey: string
  model: string
  /** "auto" => let the model detect the language. */
  languageHint: string
  /** Server-VAD silence (ms) before a segment is finalized. */
  silenceMs: number
  onOpen: () => void
  onDelta: (itemId: string, fullText: string) => void
  onCompleted: (itemId: string, fullText: string) => void
  onError: (message: string) => void
  onClose: () => void
}

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
const MAX_RECONNECT_DELAY = 15_000

/**
 * Streams 24kHz mono PCM16 audio to OpenAI's Realtime transcription session and
 * emits incremental ("delta") and finalized ("completed") transcripts.
 *
 * Connection failures before the first successful open are surfaced as errors;
 * drops *after* a session is established trigger silent reconnection so a brief
 * network blip doesn't tear down a running session.
 */
export class TranscriptionClient {
  private ws: WebSocket | null = null
  private closedByUser = false
  private everOpen = false
  private reconnectDelay = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Accumulated text per transcription item id. */
  private partials = new Map<string, string>()
  // Diagnostics
  private framesSent = 0
  private framesDropped = 0
  private bytesSent = 0
  private peak = 0
  private gotFirstDelta = false

  constructor(private opts: TranscriptionOptions) {}

  connect(): void {
    this.closedByUser = false
    const ws = new WebSocket(REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        // NOTE: the GA Realtime API rejects the old `OpenAI-Beta: realtime=v1`
        // header ("The Realtime Beta API is no longer supported"). Do not add it.
      },
    })
    this.ws = ws

    ws.on('open', () => {
      this.everOpen = true
      this.reconnectDelay = 1000
      this.sendSessionUpdate()
      this.opts.onOpen()
    })

    ws.on('message', (data) => this.handleMessage(data))

    ws.on('error', (err: Error) => {
      // 'close' fires right after and drives reconnect/auth handling.
      console.error('[transcription] socket error:', err.message)
    })

    ws.on('close', (code: number) => {
      this.ws = null
      if (this.closedByUser) {
        this.opts.onClose()
        return
      }
      // Auth / policy failures: do not retry.
      if (code === 4001 || code === 1008 || code === 4401) {
        this.opts.onError('Authentication failed. Check your OpenAI API key and that it has access to the realtime transcription model.')
        this.opts.onClose()
        return
      }
      if (!this.everOpen) {
        this.opts.onError('Could not connect to the OpenAI Realtime API. Check your network connection and API key.')
        this.opts.onClose()
        return
      }
      // Mid-session drop: reconnect with backoff.
      this.reconnectTimer = setTimeout(() => {
        if (!this.closedByUser) this.connect()
      }, this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY)
    })
  }

  /** Update language/VAD config on a live session (re-sends session.update). */
  configure(patch: { languageHint?: string; silenceMs?: number }): void {
    if (patch.languageHint !== undefined) this.opts.languageHint = patch.languageHint
    if (patch.silenceMs !== undefined) this.opts.silenceMs = patch.silenceMs
    this.sendSessionUpdate()
  }

  private sessionConfig(): unknown {
    const lang =
      this.opts.languageHint && this.opts.languageHint !== 'auto'
        ? this.opts.languageHint
        : undefined
    return {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: {
              model: this.opts.model,
              ...(lang ? { language: lang } : {}),
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              silence_duration_ms: this.opts.silenceMs,
            },
          },
        },
      },
    }
  }

  private sendSessionUpdate(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const config = this.sessionConfig()
      console.log('[transcription] session.update ->', JSON.stringify(config))
      this.ws.send(JSON.stringify(config))
    }
  }

  /** Append a chunk of 24kHz mono PCM16 audio (little-endian). */
  sendAudio(buf: ArrayBuffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.framesDropped++
      return
    }
    const nodeBuf = Buffer.from(buf as ArrayBuffer)
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: nodeBuf.toString('base64') }))
    this.framesSent++
    this.bytesSent += nodeBuf.byteLength

    // Diagnostic: track peak amplitude so we can tell "silent capture" from
    // "audio flowing but not transcribed". Logged ~once/10s.
    const i16 = new Int16Array(nodeBuf.buffer, nodeBuf.byteOffset, Math.floor(nodeBuf.byteLength / 2))
    for (let i = 0; i < i16.length; i += 7) {
      const a = Math.abs(i16[i])
      if (a > this.peak) this.peak = a
    }
    if (this.framesSent % 100 === 0) {
      console.log(
        `[transcription] audio: ${this.framesSent} frames, ${Math.round(this.bytesSent / 1024)} KB sent, ` +
          `${this.framesDropped} dropped(pre-open), peak level ${Math.round((this.peak / 32768) * 100)}%`,
      )
      this.peak = 0
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: any
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }

    // Diagnostic: log every non-delta event the server sends (session acks,
    // VAD speech_started/stopped/committed, completed, error).
    if (typeof msg.type === 'string' && !msg.type.endsWith('.delta')) {
      console.log('[transcription] <<', msg.type)
    }

    switch (msg.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        if (!this.gotFirstDelta) {
          this.gotFirstDelta = true
          console.log('[transcription] first transcript delta received')
        }
        const id: string = msg.item_id ?? 'live'
        const next = (this.partials.get(id) ?? '') + (msg.delta ?? '')
        this.partials.set(id, next)
        this.opts.onDelta(id, next)
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const id: string = msg.item_id ?? 'live'
        const text: string = msg.transcript ?? this.partials.get(id) ?? ''
        this.partials.delete(id)
        this.opts.onCompleted(id, text)
        break
      }
      case 'transcription_session.created':
      case 'transcription_session.updated':
      case 'session.created':
      case 'session.updated':
        console.log(`[transcription] ${msg.type}`)
        break
      case 'error': {
        console.error('[transcription] error event:', JSON.stringify(msg))
        const err = msg.error ?? {}
        const code = err.code ? ` (${err.code})` : ''
        const m = err.message ?? 'Unknown transcription error'
        this.opts.onError(`Transcription error${code}: ${m}`)
        break
      }
      default:
        break
    }
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
    this.partials.clear()
  }
}
