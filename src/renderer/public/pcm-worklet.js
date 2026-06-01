// AudioWorklet processor: downmix to mono, resample the context's sample rate
// down to `targetRate`, convert to 16-bit PCM, and post ~100ms batches as
// transferable ArrayBuffers. Runs off the main thread.
class PCMDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    this.targetRate = opts.targetRate || 24000
    // input samples consumed per output sample (e.g. 48000/24000 = 2)
    this.ratio = sampleRate / this.targetRate
    this.pos = 0 // fractional read cursor within the current block
    this.carry = null // last sample of the previous block (boundary interp)
    this.batch = []
    this.flushEvery = Math.max(1, Math.floor(this.targetRate / 10)) // ~100ms
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0]) return true
    const frames = input[0].length
    if (frames === 0) return true
    const channels = input.length

    // Downmix to mono.
    const mono = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += input[c][i]
      mono[i] = sum / channels
    }

    const sampleAt = (idx) => {
      if (idx < 0) return this.carry == null ? mono[0] : this.carry
      if (idx >= frames) return mono[frames - 1]
      return mono[idx]
    }

    let pos = this.pos
    while (pos < frames) {
      const i0 = Math.floor(pos)
      const frac = pos - i0
      const a = sampleAt(i0)
      const b = sampleAt(i0 + 1)
      let v = a + (b - a) * frac
      if (v > 1) v = 1
      else if (v < -1) v = -1
      this.batch.push(v < 0 ? v * 0x8000 : v * 0x7fff)
      pos += this.ratio
    }
    this.pos = pos - frames
    this.carry = mono[frames - 1]

    if (this.batch.length >= this.flushEvery) {
      const out = new Int16Array(this.batch)
      this.batch.length = 0
      this.port.postMessage(out.buffer, [out.buffer])
    }
    return true
  }
}

registerProcessor('pcm-downsampler', PCMDownsampler)
