import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
}

export const AUDIO_CONTEXT_MARKER = '[Customer sent a voice message]'

/**
 * Fetch the last N text/audio messages of a conversation and map them to
 * the provider-neutral chat shape. Audio has no transcript, so customer
 * voice notes become a fixed marker the system prompt handles safely.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
  includeAudio = false,
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', includeAudio ? ['text', 'audio'] : ['text'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .map((message) => ({
      role: message.sender_type === 'customer' ? 'user' as const : 'assistant' as const,
      content: message.content_type === 'audio' && message.sender_type === 'customer'
        ? message.content_text?.trim()
          ? `[Voice transcript]\n${message.content_text.trim()}`
          : AUDIO_CONTEXT_MARKER
        : message.content_text?.trim() ?? '',
    }))
    .filter((message) => message.content)
}
