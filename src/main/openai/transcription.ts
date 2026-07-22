import WebSocket from 'ws'

export interface TranscriptionOptions {
  apiKey: string
  model: string
  onOpen: () => void
  onDelta: (itemId: string, fullText: string) => void
  onCompleted: (itemId: string, fullText: string) => void
  onError: (message: string) => void
  onClose: () => void
}

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
const MAX_RECONNECT_DELAY = 15_000

/**
 * Transcribe-only engine: streams 24kHz mono PCM16 audio to OpenAI's Realtime
 * transcription session and emits incremental ("delta") and finalized
 * ("completed") transcripts. Language is auto-detected.
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

  private sessionConfig(): unknown {
    return {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: this.opts.model },
            // No noise reduction: this is clean captured media audio, not a
            // close-talking mic. "near_field" filtering suppressed quieter /
            // secondary speakers in a conversation, so they were never heard.
            noise_reduction: null,
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              silence_duration_ms: 500,
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
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const base64 = Buffer.from(buf).toString('base64')
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }))
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: any
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }

    switch (msg.type) {
      case 'conversation.item.input_audio_transcription.delta': {
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
