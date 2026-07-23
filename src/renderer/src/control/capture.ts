// Audio capture pipeline (runs in the control renderer so getDisplayMedia is
// invoked from a user gesture). System loopback audio + optional mic are mixed,
// resampled to 24kHz mono PCM16 by an AudioWorklet, and streamed to main.

let audioCtx: AudioContext | null = null
let worklet: AudioWorkletNode | null = null
let streams: MediaStream[] = []
let nodes: AudioNode[] = []
let running = false

export function isCapturing(): boolean {
  return running
}

export interface CaptureInputs {
  system: boolean
  mic: boolean
}

export async function startCapture({ system, mic }: CaptureInputs): Promise<void> {
  if (running) return
  if (!system && !mic) throw new Error('Enable system audio and/or the microphone in Settings.')
  running = true
  try {
    // 1) System audio via loopback. Auto-granted by the main-process
    //    setDisplayMediaRequestHandler (no picker dialog).
    let sysStream: MediaStream | null = null
    if (system) {
      await window.capture.enableLoopback()
      try {
        sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      } finally {
        await window.capture.disableLoopback()
      }
      sysStream.getVideoTracks().forEach((t) => {
        t.stop()
        sysStream!.removeTrack(t)
      })
      if (sysStream.getAudioTracks().length === 0) {
        throw new Error(
          'No system audio captured. Grant "Screen & System Audio Recording" to this app in System Settings → Privacy & Security, then restart.',
        )
      }
      streams.push(sysStream)
    }

    // 2) Web Audio graph + the resampling worklet.
    audioCtx = new AudioContext()
    const workletUrl = new URL('pcm-worklet.js', location.href).toString()
    await audioCtx.audioWorklet.addModule(workletUrl)
    worklet = new AudioWorkletNode(audioCtx, 'pcm-downsampler', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: 24000 },
    })
    worklet.port.onmessage = (ev: MessageEvent) => {
      window.capture.sendAudio(ev.data as ArrayBuffer)
    }

    const mixer = audioCtx.createGain()
    mixer.gain.value = 1
    nodes.push(mixer)

    if (sysStream) {
      const sysSource = audioCtx.createMediaStreamSource(sysStream)
      sysSource.connect(mixer)
      nodes.push(sysSource)
    }

    // 3) Optional microphone, mixed into the same stream.
    if (mic) {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      })
      streams.push(micStream)
      const micSource = audioCtx.createMediaStreamSource(micStream)
      micSource.connect(mixer)
      nodes.push(micSource)
    }

    mixer.connect(worklet)
    // The worklet only runs while it's part of a graph reaching the
    // destination. Route its (silent) output through a zero-gain node so it
    // keeps processing without producing any audible sound or feedback.
    const sink = audioCtx.createGain()
    sink.gain.value = 0
    nodes.push(sink)
    worklet.connect(sink)
    sink.connect(audioCtx.destination)

    await audioCtx.resume()
  } catch (err) {
    await stopCapture()
    throw err
  }
}

export async function stopCapture(): Promise<void> {
  running = false
  if (worklet) {
    worklet.port.onmessage = null
    try {
      worklet.disconnect()
    } catch {
      /* ignore */
    }
    worklet = null
  }
  for (const n of nodes) {
    try {
      n.disconnect()
    } catch {
      /* ignore */
    }
  }
  nodes = []
  for (const s of streams) s.getTracks().forEach((t) => t.stop())
  streams = []
  if (audioCtx) {
    try {
      await audioCtx.close()
    } catch {
      /* ignore */
    }
    audioCtx = null
  }
}
