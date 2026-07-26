/** Cheapest/smallest OpenAI chat model — good enough for a 5-word title. */
const TITLE_MODEL = 'gpt-4.1-nano'

/**
 * Generate a short note title for a transcript. Returns null on any failure —
 * the caller keeps the default timestamp heading in that case.
 */
export async function summarizeTitle(apiKey: string, text: string): Promise<string | null> {
  if (!text.trim()) return null
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: TITLE_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You title transcript notes. Reply with ONLY a concise title (3–8 words) in the same language as the transcript. No quotes, no trailing period.',
          },
          { role: 'user', content: text },
        ],
        max_tokens: 40,
      }),
    })
    if (!res.ok) {
      console.error('[summarize] title request failed:', res.status, await res.text())
      return null
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const title = data.choices?.[0]?.message?.content?.trim()
    return title || null
  } catch (err) {
    console.error('[summarize] title request error:', err)
    return null
  }
}
