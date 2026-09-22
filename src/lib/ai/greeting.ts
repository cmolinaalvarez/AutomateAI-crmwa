const GREETINGS = new Set([
    'hola',
    'hola buenos dias',
    'hola buenas tardes',
    'hola buenas noches',
    'buenas',
    'buenos dias',
    'buenas tardes',
    'buenas noches',
    'hello',
    'hi',
    'hey',
    'good morning',
    'good afternoon',
    'good evening',
    'ola',
    'ola bom dia',
    'ola boa tarde',
    'ola boa noite',
    'bom dia',
    'boa tarde',
    'boa noite',
    '안녕하세요',
])

function normalizeGreeting(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s가-힣]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/** Return a local reply only when the complete customer turn is a greeting. */
export function greetingOnlyReply(message: string): string | null {
    const normalized = normalizeGreeting(message)
    if (!GREETINGS.has(normalized)) return null

    if (/[가-힣]/.test(normalized)) return '안녕하세요! 무엇을 도와드릴까요?'
    if (/^(ola|bom dia|boa tarde|boa noite)/.test(normalized)) {
        return 'Olá! Como podemos ajudar?'
    }
    if (/^(hello|hi|hey|good )/.test(normalized)) {
        return 'Hello! How can we help?'
    }
    return '¡Hola! ¿En qué podemos ayudarte?'
}