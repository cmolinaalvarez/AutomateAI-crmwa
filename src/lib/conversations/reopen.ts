import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Re-open a closed conversation because the customer wrote again
 * (issue #409).
 *
 * Reopening starts a fresh service session on the same durable thread:
 * message history and assignment remain available, while the AI reply
 * budget and handoff state from the resolved session are cleared.
 *
 * Lives here rather than inline in the webhook so it can be tested
 * without standing up the whole route, and so any future inbound path
 * gets the same behaviour for free.
 */
export async function reopenClosedConversation(
  db: SupabaseClient,
  conversation: { id: string; status?: string | null },
): Promise<boolean> {
  // Nothing to do for open/pending threads, which is the common case —
  // skipping the round trip keeps inbound processing as cheap as it was.
  if (conversation.status !== 'closed') return false

  const { error } = await db
    .from('conversations')
    .update({
      status: 'open',
      ai_reply_count: 0,
      ai_autoreply_disabled: false,
      ai_handoff_summary: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
    // Re-checked in SQL, not just in the `if` above: the caller's row was
    // read earlier in the request, so two concurrent inbound deliveries
    // both holding a stale `status: 'closed'` must not be able to write
    // 'open' back over an agent who re-closed the thread in between.
    .eq('status', 'closed')

  if (error) {
    // Best-effort, same as the conversation update this follows: a failed
    // re-open must not abort inbound processing (and make Meta redeliver).
    console.error('Error re-opening conversation:', error)
    return false
  }

  return true
}
