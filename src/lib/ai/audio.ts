import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMediaPath } from '@/lib/storage/upload-media'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api'
import { aiRequestTimeoutMs } from './defaults'
import { AiError, type AiConfig } from './types'
import { providerHttpError, toNetworkError } from './providers/shared'

const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
const SPEECH_URL = 'https://api.openai.com/v1/audio/speech'
const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'
const SPEECH_MODEL = 'gpt-4o-mini-tts'
const SPEECH_VOICE = 'coral'
const AUDIO_BUCKET = 'chat-media'

export const FIRST_AUDIO_REMINDER =
    'Para continuar atendiéndote de la mejor manera, por favor escribe tus próximos mensajes en texto. Muchas gracias.'

export function audioServiceApiKey(config: AiConfig): string {
    const key = config.provider === 'openai'
        ? config.apiKey
        : config.embeddingsApiKey
    if (!key) {
        throw new AiError(
            'Audio modes require an OpenAI key as the provider key or services key.',
            { code: 'audio_key_required', status: 400 },
        )
    }
    return key
}

export async function transcribeWhatsAppAudio(args: {
    apiKey: string
    mediaId: string
    whatsappAccessToken: string
}): Promise<string> {
    const media = await getMediaUrl({
        mediaId: args.mediaId,
        accessToken: args.whatsappAccessToken,
    })
    const downloaded = await downloadMedia({
        downloadUrl: media.url,
        accessToken: args.whatsappAccessToken,
    })
    const mimeType = media.mimeType || downloaded.contentType || 'audio/ogg'
    const form = new FormData()
    form.append('model', TRANSCRIPTION_MODEL)
    form.append(
        'file',
        new Blob([new Uint8Array(downloaded.buffer)], { type: mimeType }),
        'voice-message.ogg',
    )

    let response: Response
    try {
        response = await fetch(TRANSCRIPTION_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${args.apiKey}` },
            body: form,
            signal: AbortSignal.timeout(aiRequestTimeoutMs()),
        })
    } catch (error) {
        throw toNetworkError(error)
    }
    if (!response.ok) throw await providerHttpError('OpenAI transcription', response)
    const data = (await response.json().catch(() => null)) as { text?: string } | null
    const text = data?.text?.trim()
    if (!text) {
        throw new AiError('Audio transcription was empty.', {
            code: 'empty_transcription',
        })
    }
    return text
}

export async function synthesizeLatinFemaleSpeech(
    apiKey: string,
    text: string,
): Promise<Uint8Array> {
    let response: Response
    try {
        response = await fetch(SPEECH_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: SPEECH_MODEL,
                voice: SPEECH_VOICE,
                input: text,
                instructions:
                    'Speak as a warm, respectful adult Latin American woman. Use a calm, professional customer-service tone and natural Spanish pronunciation.',
                response_format: 'mp3',
            }),
            signal: AbortSignal.timeout(aiRequestTimeoutMs()),
        })
    } catch (error) {
        throw toNetworkError(error)
    }
    if (!response.ok) throw await providerHttpError('OpenAI speech', response)
    return new Uint8Array(await response.arrayBuffer())
}

export async function publishGeneratedSpeech(
    db: SupabaseClient,
    accountId: string,
    bytes: Uint8Array,
): Promise<string> {
    const path = buildMediaPath(
        accountId,
        `ai-voice-${crypto.randomUUID()}.mp3`,
        null,
        'ai-audio',
    )
    const { error } = await db.storage.from(AUDIO_BUCKET).upload(path, bytes, {
        contentType: 'audio/mpeg',
        cacheControl: '3600',
        upsert: false,
    })
    if (error) throw new Error(`Could not store AI voice reply: ${error.message}`)
    const { data } = db.storage.from(AUDIO_BUCKET).getPublicUrl(path)
    if (!data.publicUrl) throw new Error('Could not publish AI voice reply.')
    return data.publicUrl
}