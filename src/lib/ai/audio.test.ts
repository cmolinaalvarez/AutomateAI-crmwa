import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiConfig } from './types'
import {
    audioServiceApiKey,
    synthesizeLatinFemaleSpeech,
    transcribeWhatsAppAudio,
} from './audio'

vi.mock('@/lib/whatsapp/meta-api', () => ({
    getMediaUrl: vi.fn().mockResolvedValue({
        url: 'https://meta.example/audio',
        mimeType: 'audio/ogg',
        fileSize: 4,
    }),
    downloadMedia: vi.fn().mockResolvedValue({
        buffer: Buffer.from([1, 2, 3, 4]),
        contentType: 'audio/ogg',
    }),
}))

afterEach(() => vi.unstubAllGlobals())

describe('AI audio services', () => {
    it('uses the chat key for OpenAI and the services key for other providers', () => {
        const base = {
            apiKey: 'chat-key',
            embeddingsApiKey: 'services-key',
        } as AiConfig
        expect(audioServiceApiKey({ ...base, provider: 'openai' })).toBe('chat-key')
        expect(audioServiceApiKey({ ...base, provider: 'anthropic' })).toBe('services-key')
    })

    it('uploads WhatsApp audio as multipart and returns its transcript', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ text: 'Necesito ayuda' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        )
        vi.stubGlobal('fetch', fetchMock)

        await expect(transcribeWhatsAppAudio({
            apiKey: 'sk-test',
            mediaId: 'media-1',
            whatsappAccessToken: 'wa-token',
        })).resolves.toBe('Necesito ayuda')

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(init.headers).toEqual({ Authorization: 'Bearer sk-test' })
        expect(init.body).toBeInstanceOf(FormData)
        expect((init.body as FormData).get('model')).toBe('gpt-4o-mini-transcribe')
    })

    it('requests respectful Latin female speech in MP3 format', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(new Uint8Array([9, 8, 7]), { status: 200 }),
        )
        vi.stubGlobal('fetch', fetchMock)

        await expect(synthesizeLatinFemaleSpeech('sk-test', 'Hola')).resolves.toEqual(
            new Uint8Array([9, 8, 7]),
        )
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        const body = JSON.parse(String(init.body))
        expect(body).toMatchObject({
            model: 'gpt-4o-mini-tts',
            voice: 'coral',
            input: 'Hola',
            response_format: 'mp3',
        })
        expect(body.instructions).toContain('Latin American woman')
    })
})