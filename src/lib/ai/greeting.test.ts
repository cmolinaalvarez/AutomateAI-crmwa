import { describe, expect, it } from 'vitest'
import { greetingOnlyReply } from './greeting'

describe('greetingOnlyReply', () => {
    it('answers greeting-only messages without escalating them', () => {
        expect(greetingOnlyReply('Hola buenas tardes')).toBe(
            '¡Hola! ¿En qué podemos ayudarte?',
        )
        expect(greetingOnlyReply('Good morning!')).toBe('Hello! How can we help?')
        expect(greetingOnlyReply('Olá, bom dia')).toBe('Olá! Como podemos ajudar?')
    })

    it('does not intercept a greeting that includes a request', () => {
        expect(greetingOnlyReply('Hola, necesito una cotización')).toBeNull()
        expect(greetingOnlyReply('Buenas tardes, quiero hablar con una persona')).toBeNull()
    })
})