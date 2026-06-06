import WebSocket from 'ws'

export interface RealtimeTranslateOptions {
  apiKey: string
  /** ISO code for the target output language (e.g. "es", "en"). */
  targetCode: string
  onOpen: () => void
  /** Incremental source-language transcript text. */
  onSourceDelta: (delta: string) => void
  /** Incremental translated transcript text. */
  onTranslationDelta: (delta: string) => void
  onError: (message: string) => void
  onClose: () => void
}

const ENDPOINT = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate'
const MAX_RECONNECT_DELAY = 15_000

/**
 * Pace-matched streaming speech translation via OpenAI's gpt-realtime-translate.
 * A single session streams BOTH the source transcript and the translated
 * transcript continuously as audio arrives — no per-sentence round trips.
 * We ignore the translated *audio* output and use only the transcript deltas.
 */
export class RealtimeTranslateClient {
  private ws: WebSocket | null = null
  private closedByUser = false
  private everOpen = false
  private reconnectDelay = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private framesSent = 0
  private framesDropped = 0
  private peak = 0
  private seenTypes = new Set<string>()
  private gotSourceDelta = false

  constructor(private opts: RealtimeTranslateOptions) {}

  connect(): void {
    this.closedByUser = false
    const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${this.opts.apiKey}` } })
    this.ws = ws

    ws.on('open', () => {
      this.everOpen = true
      this.reconnectDelay = 1000
      this.sendSessionUpdate()
      this.opts.onOpen()
    })
    ws.on('message', (data) => this.handleMessage(data))
    ws.on('error', (err: Error) => console.error('[rt-translate] socket error:', err.message))
    ws.on('close', (code: number) => {
      this.ws = null
      if (this.closedByUser) return this.opts.onClose()
      if (code === 4001 || code === 1008 || code === 4401) {
        this.opts.onError('Authentication failed for gpt-realtime-translate. Check your API key and model access.')
        return this.opts.onClose()
      }
      if (!this.everOpen) {
        this.opts.onError('Could not connect to gpt-realtime-translate. Check network, API key, and model access.')
        return this.opts.onClose()
      }
      this.reconnectTimer = setTimeout(() => {
        if (!this.closedByUser) this.connect()
      }, this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY)
    })
  }

  setTarget(code: string): void {
    this.opts.targetCode = code
    this.sendSessionUpdate()
  }

  private sessionConfig(): unknown {
    return {
      type: 'session.update',
      session: {
        audio: {
          input: {
            transcription: { model: 'gpt-realtime-whisper' },
            noise_reduction: { type: 'near_field' },
          },
          output: { language: this.opts.targetCode },
        },
      },
    }
  }

  private sendSessionUpdate(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const cfg = this.sessionConfig()
      console.log('[rt-translate] session.update ->', JSON.stringify(cfg))
      this.ws.send(JSON.stringify(cfg))
    }
  }

  sendAudio(buf: ArrayBuffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.framesDropped++
      return
    }
    const nodeBuf = Buffer.from(buf as ArrayBuffer)
    // NOTE: this endpoint uses the `session.`-prefixed append event.
    this.ws.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: nodeBuf.toString('base64') }))
    this.framesSent++

    const i16 = new Int16Array(nodeBuf.buffer, nodeBuf.byteOffset, Math.floor(nodeBuf.byteLength / 2))
    for (let i = 0; i < i16.length; i += 7) {
      const a = Math.abs(i16[i])
      if (a > this.peak) this.peak = a
    }
    if (this.framesSent % 100 === 0) {
      console.log(
        `[rt-translate] audio: ${this.framesSent} frames, ${this.framesDropped} dropped, peak ${Math.round((this.peak / 32768) * 100)}%`,
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
    const t: string = typeof msg.type === 'string' ? msg.type : ''

    // Diagnostic: log each distinct event type once so we can see exactly which
    // event carries the source vs translated transcript.
    if (t && !this.seenTypes.has(t)) {
      this.seenTypes.add(t)
      console.log('[rt-translate] event type:', t)
    }

    // Translated transcript.
    if (t === 'session.output_transcript.delta') {
      if (msg.delta) this.opts.onTranslationDelta(msg.delta)
      return
    }

    // Source (original) transcript — accept the known + likely alternative names
    // (the input-transcription sub-model may emit the standard realtime event).
    if (
      t === 'session.input_transcript.delta' ||
      t === 'conversation.item.input_audio_transcription.delta' ||
      t === 'input_audio_transcription.delta'
    ) {
      const text = msg.delta ?? msg.transcript ?? msg.text ?? ''
      if (text) {
        this.gotSourceDelta = true
        this.opts.onSourceDelta(text)
      }
      return
    }
    // Fallback: some models emit only a completed event for the source.
    if (
      t === 'conversation.item.input_audio_transcription.completed' ||
      t === 'session.input_transcript.completed' ||
      t === 'session.input_transcript.done'
    ) {
      const text = msg.transcript ?? msg.text ?? ''
      if (text && !this.gotSourceDelta) this.opts.onSourceDelta(text + ' ')
      return
    }

    if (t === 'error') {
      console.error('[rt-translate] error event:', JSON.stringify(msg))
      this.opts.onError(
        `Translate error${msg.error?.code ? ` (${msg.error.code})` : ''}: ${msg.error?.message ?? 'unknown'}`,
      )
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
  }
}
