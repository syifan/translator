// Accumulates the session's 24kHz mono PCM16 audio and cuts it into chunks
// for batch (high-accuracy) re-transcription. Cuts prefer a silent moment near
// the target length so words aren't split mid-syllable.

const SAMPLE_RATE = 24_000
/** First chunk is short so the note upgrades quickly after session start. */
const FIRST_TARGET_MS = 60_000
const TARGET_MS = 300_000
/** Past target+this, cut even without silence. */
const FORCE_EXTRA_MS = 30_000
/** RMS (of 32767) below which a 300ms window counts as silence. */
const SILENCE_RMS = 250
/** Chunk peak below this = whole chunk is silence; skip uploading it. */
const SILENT_CHUNK_PEAK = 500
/** Ignore trailing chunks shorter than this. */
const MIN_FINAL_MS = 2_000

const SILENCE_WINDOW_SAMPLES = Math.floor(SAMPLE_RATE * 0.3)

export interface AudioChunk {
  /** WAV file bytes (24kHz mono PCM16), or null for a silent (skipped) chunk. */
  wav: Buffer | null
  /** Wall-clock ms of the chunk's first audio sample. */
  startMs: number
  /** Wall-clock ms of the chunk's last audio sample. */
  endMs: number
  durationMs: number
}

export interface ChunkTargets {
  firstMs: number
  nextMs: number
}

export class AudioChunker {
  private parts: Int16Array[] = []
  private sampleCount = 0
  private chunkStartMs: number | null = null
  private peak = 0
  private firstChunkDone = false

  constructor(
    private onChunk: (chunk: AudioChunk) => void,
    private targets: ChunkTargets = { firstMs: FIRST_TARGET_MS, nextMs: TARGET_MS },
  ) {}

  append(buf: ArrayBuffer): void {
    const samples = new Int16Array(buf.slice(0))
    if (samples.length === 0) return
    if (this.chunkStartMs === null) this.chunkStartMs = Date.now()
    this.parts.push(samples)
    this.sampleCount += samples.length
    for (let i = 0; i < samples.length; i += 7) {
      const a = Math.abs(samples[i])
      if (a > this.peak) this.peak = a
    }

    const elapsedMs = (this.sampleCount / SAMPLE_RATE) * 1000
    const target = this.firstChunkDone ? this.targets.nextMs : this.targets.firstMs
    if (elapsedMs < target) return
    if (elapsedMs >= target + FORCE_EXTRA_MS || this.tailIsSilent()) {
      this.cut()
    }
  }

  /** Flush whatever is buffered (session end). */
  final(): void {
    const elapsedMs = (this.sampleCount / SAMPLE_RATE) * 1000
    if (elapsedMs >= MIN_FINAL_MS) this.cut()
    this.reset()
  }

  private tailIsSilent(): boolean {
    // RMS over the most recent ~300ms of audio.
    let needed = SILENCE_WINDOW_SAMPLES
    let sumSq = 0
    let counted = 0
    for (let p = this.parts.length - 1; p >= 0 && needed > 0; p--) {
      const part = this.parts[p]
      const from = Math.max(0, part.length - needed)
      for (let i = from; i < part.length; i++) {
        sumSq += part[i] * part[i]
        counted++
      }
      needed -= part.length - from
    }
    if (counted === 0) return false
    return Math.sqrt(sumSq / counted) < SILENCE_RMS
  }

  private cut(): void {
    const startMs = this.chunkStartMs ?? Date.now()
    const durationMs = (this.sampleCount / SAMPLE_RATE) * 1000
    const endMs = startMs + Math.round(durationMs)
    const silent = this.peak < SILENT_CHUNK_PEAK
    const chunk: AudioChunk = {
      wav: silent ? null : encodeWav(this.parts, this.sampleCount),
      startMs,
      endMs,
      durationMs: Math.round(durationMs),
    }
    this.firstChunkDone = true
    this.reset()
    this.chunkStartMs = endMs // next chunk starts where this one ended
    this.onChunk(chunk)
  }

  private reset(): void {
    this.parts = []
    this.sampleCount = 0
    this.peak = 0
    this.chunkStartMs = null
  }
}

/** Minimal 16-bit mono WAV encoder. */
function encodeWav(parts: Int16Array[], sampleCount: number): Buffer {
  const dataBytes = sampleCount * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  let offset = 44
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      buf.writeInt16LE(part[i], offset)
      offset += 2
    }
  }
  return buf
}
