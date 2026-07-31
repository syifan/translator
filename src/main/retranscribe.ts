import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REALTIME_TRANSLATE_CODES } from '@shared/ipc'
import { store } from './store'
import { getKey } from './secrets'
import { loadChunks } from './audio-store'
import { batchTranscribe } from './openai/batch-transcribe'
import { translateLines } from './openai/translate-text'
import { summarizeTitle } from './openai/summarize'
import { renderMarkdown, transcriptsDir } from './transcript-log'

/**
 * Rebuild a saved note from its stored audio, batch-transcribing every chunk
 * with the given language ("Auto" = detect). Translation and note-content
 * settings are taken from the current app settings. Overwrites the .md file
 * and regenerates the AI title.
 */
export async function retranscribeNote(fileName: string, languageName: string): Promise<void> {
  const stem = fileName.replace(/\.md$/, '')
  const key = getKey()
  if (!key) throw new Error('No API key set.')
  const chunks = await loadChunks(stem)
  if (chunks.length === 0) throw new Error('No audio is stored for this note.')

  const settings = store.get()
  const languageCode = REALTIME_TRANSLATE_CODES[languageName] ?? undefined
  const mode = settings.showTranslation ? settings.noteContent : 'original'
  const translateTo = settings.showTranslation && mode !== 'original' ? settings.targetLang : null

  const entries: { time: Date; original: string; translation: string }[] = []
  let prevTail = ''
  for (const chunk of chunks) {
    const { segments } = await batchTranscribe(key, chunk.wav, prevTail, languageCode)
    let translations: string[] | null = null
    if (translateTo && segments.length > 0) {
      translations = await translateLines(
        key,
        segments.map((s) => s.text),
        translateTo,
      )
    }
    for (let i = 0; i < segments.length; i++) {
      const original = mode === 'translation' ? '' : segments[i].text
      const translation = mode === 'original' ? '' : (translations?.[i] ?? '')
      if (!original && !translation) continue
      entries.push({
        time: new Date(chunk.startMs + Math.round(segments[i].startSec * 1000)),
        original,
        translation,
      })
    }
    prevTail = segments.map((s) => s.text).join(' ').slice(-800)
  }

  const path = join(transcriptsDir(), fileName)
  const langLabel = languageCode ? ` (${languageName})` : ''
  await writeFile(path, renderMarkdown(`Transcript${langLabel} — ${stem}`, entries), 'utf8')
  console.log(`[retranscribe] ${fileName}: ${entries.length} entries as ${languageName}`)

  const sample = entries
    .map((e) => e.translation || e.original)
    .join('\n')
    .slice(0, 6000)
  const title = await summarizeTitle(key, sample)
  if (title) {
    const clean = title.replace(/\s+/g, ' ').replace(/^["'#\s]+|["'.\s]+$/g, '').slice(0, 80)
    if (clean) await writeFile(path, renderMarkdown(clean, entries), 'utf8')
  }
}
