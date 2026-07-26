// Batch (whole-chunk) transcription for high-accuracy notes.
//
// whisper-1 is used because it returns per-segment timestamps
// (response_format=verbose_json), which the note view needs for true clock
// times. Swap TRANSCRIBE_BATCH_MODEL if a timestamped gpt-4o-transcribe
// variant becomes preferable.
const TRANSCRIBE_BATCH_MODEL = 'whisper-1'

export interface BatchSegment {
  /** Seconds from the start of the uploaded chunk. */
  startSec: number
  endSec: number
  text: string
}

export async function batchTranscribe(
  apiKey: string,
  wav: Buffer,
  prompt?: string,
): Promise<BatchSegment[]> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('model', TRANSCRIBE_BATCH_MODEL)
  form.append('response_format', 'verbose_json')
  // Carrying the previous chunk's tail keeps terminology/spelling consistent
  // across chunk boundaries.
  if (prompt) form.append('prompt', prompt.slice(-800))

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    throw new Error(`batch transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  const data = (await res.json()) as {
    text?: string
    duration?: number
    segments?: { start: number; end: number; text: string }[]
  }
  if (Array.isArray(data.segments) && data.segments.length > 0) {
    return data.segments
      .map((s) => ({ startSec: s.start, endSec: s.end, text: s.text.trim() }))
      .filter((s) => s.text)
  }
  // Fallback: no segment detail — return the whole text as one segment.
  const text = data.text?.trim()
  return text ? [{ startSec: 0, endSec: data.duration ?? 0, text }] : []
}
