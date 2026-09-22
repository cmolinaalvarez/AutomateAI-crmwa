import type { ChatMessage } from './types'

const REPLIES = {
    es: 'Para continuar ayudándote, voy a dejar la conversación con nuestro equipo. Una persona te responderá por este medio.',
    en: 'To continue helping you, I’ll leave this conversation with our team. A person will reply here.',
    pt: 'Para continuar ajudando, vou deixar esta conversa com nossa equipe. Uma pessoa responderá por aqui.',
    ko: '계속 도움을 드릴 수 있도록 담당 팀에 대화를 전달하겠습니다. 담당자가 이 채팅으로 답변드릴 예정입니다.',
} as const

/** Deterministic customer notice used when the automatic-reply cap is reached. */
export function replyLimitMessage(messages: ChatMessage[]): string {
    const latest = [...messages]
        .reverse()
        .find((message) => message.role === 'user' && message.content.trim())
        ?.content.toLowerCase() ?? ''

    if (/[가-힣]/.test(latest)) return REPLIES.ko
    if (/\b(olá|ola|você|voce|ajuda|projeto|boa tarde|bom dia)\b/u.test(latest)) {
        return REPLIES.pt
    }
    if (/\b(hola|quiero|quisiera|saber|ayuda|proyecto|buenas tardes|buenos días|que|qué)\b/u.test(latest)) {
        return REPLIES.es
    }
    return REPLIES.en
}