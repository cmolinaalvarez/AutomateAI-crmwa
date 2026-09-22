import { describe, expect, it } from 'vitest'
import { replyLimitMessage } from './reply-limit'

describe('replyLimitMessage', () => {
    it('uses the language of the latest customer request', () => {
        expect(replyLimitMessage([
            { role: 'assistant', content: '¿En qué puedo ayudarte?' },
            { role: 'user', content: 'Primero quiero saber en detalle a qué se dedican' },
        ])).toContain('nuestro equipo')
        expect(replyLimitMessage([
            { role: 'user', content: 'I need more details about your services' },
        ])).toContain('our team')
    })
})