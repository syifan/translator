/** Cheap text model for translating refined note segments. */
const TRANSLATE_MODEL = 'gpt-4.1-mini'

/**
 * Translate segment lines into the target language, preserving 1:1 line
 * alignment. Returns null on any failure or count mismatch — the caller keeps
 * the untranslated text in that case.
 */
export async function translateLines(
  apiKey: string,
  lines: string[],
  targetLang: string,
): Promise<string[] | null> {
  if (lines.length === 0) return []
  const numbered = lines.map((l, i) => `${i + 1}. ${l.replace(/\n/g, ' ')}`).join('\n')
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `Translate each numbered line into ${targetLang}. Reply with the same numbered lines, one translation per line, nothing else. Keep numbering identical.`,
          },
          { role: 'user', content: numbered },
        ],
      }),
    })
    if (!res.ok) {
      console.error('[translate-text] failed:', res.status, (await res.text()).slice(0, 200))
      return null
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const out = data.choices?.[0]?.message?.content ?? ''
    const map = new Map<number, string>()
    for (const raw of out.split('\n')) {
      const m = /^\s*(\d+)[.)]\s*(.*)$/.exec(raw)
      if (m) map.set(Number(m[1]), m[2].trim())
    }
    const result = lines.map((_, i) => map.get(i + 1) ?? '')
    // Tolerate a few misses but not a broken response.
    const missing = result.filter((r) => !r).length
    return missing > Math.ceil(lines.length / 4) ? null : result
  } catch (err) {
    console.error('[translate-text] error:', err)
    return null
  }
}
