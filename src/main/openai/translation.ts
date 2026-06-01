// Streaming translation via the Chat Completions API. Uses the global fetch
// (Node 18+) so we don't pull in the OpenAI SDK.

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

interface Turn {
  src: string
  dst: string
}

export class Translator {
  private history: Turn[] = []

  constructor(
    private apiKey: string,
    private model: string,
    private target: string,
  ) {}

  setTarget(target: string): void {
    this.target = target
  }

  /**
   * Translate `text` into the target language, invoking `onPartial` with the
   * cumulative translation as tokens stream in. Resolves with the full text.
   */
  async translate(text: string, onPartial: (cumulative: string) => void): Promise<string> {
    const system =
      `You are a real-time subtitle translator. Translate the user's text into ${this.target}. ` +
      `Output ONLY the translation — no quotes, no notes, no transliteration, no commentary. ` +
      `Preserve meaning, tone, and proper nouns; keep it concise enough to read on screen. ` +
      `If the text is already in ${this.target}, return it unchanged.`

    // A little rolling context improves coherence across segments.
    const context = this.history.slice(-3).flatMap((t) => [
      { role: 'user', content: t.src },
      { role: 'assistant', content: t.dst },
    ])

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          ...context,
          { role: 'user', content: text },
        ],
      }),
    })

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Translation failed (${res.status}): ${detail.slice(0, 200)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let acc = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const json = JSON.parse(data)
          const delta: string = json.choices?.[0]?.delta?.content ?? ''
          if (delta) {
            acc += delta
            onPartial(acc)
          }
        } catch {
          /* ignore keep-alive / partial json */
        }
      }
    }

    this.history.push({ src: text, dst: acc })
    if (this.history.length > 6) this.history.shift()
    return acc
  }
}
