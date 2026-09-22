import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { greetingOnlyReply } from './greeting'
import { replyLimitMessage } from './reply-limit'
import {
  engineSendMedia,
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { derivePresence } from '@/lib/presence'
import type { AiConfig, AiRoutingRule, ChatMessage } from './types'
import {
  audioServiceApiKey,
  FIRST_AUDIO_REMINDER,
  publishGeneratedSpeech,
  synthesizeLatinFemaleSpeech,
  transcribeWhatsAppAudio,
} from './audio'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta's wamid of the customer message we're replying to. When set,
   *  a typing indicator (which also marks it read) is shown while the
   *  reply is generated. Optional so older callers keep working. */
  inboundMessageId?: string
  /** Content type of the inbound that triggered this run. */
  inboundContentType?: string
  /** Meta media id used to download and transcribe an inbound voice note. */
  inboundMediaId?: string
  /** True when this is the conversation's first customer message. */
  inboundIsFirstMessage?: boolean
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
    inboundContentType,
    inboundMediaId,
    inboundIsFirstMessage,
  } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return
    const isAudioInbound = inboundContentType === 'audio'
    if (isAudioInbound && config.audioMode === 'text_only') return
    if (
      isAudioInbound &&
      config.audioMode === 'first_audio' &&
      !inboundIsFirstMessage
    ) return
    if (isAudioInbound && !inboundMediaId) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // A reached cap transfers ownership instead of silently ignoring the
    // customer. This path performs no provider call.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      const messages = await buildConversationContext(
        db,
        conversationId,
        undefined,
        config.audioMode !== 'text_only',
      )
      await handoffAtReplyLimit(db, config, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        messages,
        replyCount: conv.ai_reply_count,
      })
      return
    }

    if (isAudioInbound) {
      const audioKey = audioServiceApiKey(config)
      const { accessToken } = await loadAccountMetaCredentials(db, accountId)
      const transcript = await transcribeWhatsAppAudio({
        apiKey: audioKey,
        mediaId: inboundMediaId!,
        whatsappAccessToken: accessToken,
      })
      await db
        .from('messages')
        .update({ content_text: transcript })
        .eq('conversation_id', conversationId)
        .eq('message_id', inboundMessageId)
      await db
        .from('conversations')
        .update({ last_message_text: transcript })
        .eq('id', conversationId)
        .eq('account_id', accountId)
    }

    const messages = await buildConversationContext(
      db,
      conversationId,
      undefined,
      config.audioMode !== 'text_only',
    )
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Every gate has passed — we're committed to attempting a reply, so
    // show the customer "typing…" (and mark their message read) while the
    // retrieval + LLM round trips run. Meta clears the indicator after
    // 25 s or when our reply lands, whichever is first, so there's
    // nothing to undo on the handoff / no-text path. Strictly
    // best-effort: a failed indicator must never cost us the reply.
    if (inboundMessageId) {
      await showTypingIndicator(db, accountId, inboundMessageId)
    }

    const latestCustomerText = latestUserMessage(messages)
    const localGreetingReply = greetingOnlyReply(latestCustomerText)
    let generated

    if (localGreetingReply) {
      generated = {
        text: localGreetingReply,
        handoff: false,
        usage: null,
      }
    } else {
      // Ground concrete requests in the account's knowledge base (best-effort).
      const knowledge = await retrieveKnowledge(
        db,
        accountId,
        config,
        latestCustomerText,
      )

      const systemPrompt = buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
        routingRules: config.autoAssignmentEnabled
          ? config.autoAssignmentRules
          : undefined,
      })

      generated = await generateReply({
        config,
        systemPrompt,
        messages,
      })

      // Record token spend only when the provider call happened.
      void logAiUsage(db, {
        accountId,
        conversationId,
        mode: 'auto_reply',
        provider: config.provider,
        model: config.model,
        usage: generated.usage,
      })
    }

    const { text, handoff, routingKey } = generated

    // This answer did not use the model, so it does not consume a paid
    // automatic-reply slot or shorten the useful conversation.
    if (localGreetingReply) {
      await sendAiResponse(db, config, {
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
        audio: false,
      })
      return
    }

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const route = config.autoAssignmentEnabled
        ? await resolveAutomaticRoute(db, accountId, config, routingKey)
        : null
      const handoffSummary = route?.audit
        ? `${summary} Automatic routing: ${route.audit}`
        : summary
      const assignedAgentId = route?.targetUserId ?? config.handoffAgentId
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: handoffSummary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (assignedAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = assignedAgentId
      }
      await db
        .from('conversations')
        .update(update)
        .eq('id', conversationId)
        .eq('account_id', accountId)

      // A configured target gets the existing assignment notification from
      // the database trigger. A shared-queue handoff has no assignee, so
      // explicitly alert the account owner to triage it instead of leaving
      // the paused conversation invisible until somebody checks the inbox.
      if (!assignedAgentId || route?.fellBack) {
        await notifyOwnerOfQueuedHandoff(db, {
          accountId,
          conversationId,
          contactId,
          summary: handoffSummary,
          title: route?.fellBack
            ? 'AI routing fallback needs attention'
            : undefined,
        })
      }

      // The model may include a final customer-facing expectation before
      // the handoff sentinel. Send it after the sticky pause is persisted,
      // so a delivery failure can never leave the bot active on this thread.
      if (
        (handoff && text) ||
        (isAudioInbound && config.audioMode === 'first_audio')
      ) {
        await sendAiResponse(db, config, {
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: text ?? '',
          audio: isAudioInbound,
        })
      }
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) {
      await handoffAtReplyLimit(db, config, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        messages,
        replyCount: config.autoReplyMaxPerConversation,
      })
      return
    }

    await sendAiResponse(db, config, {
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      audio: isAudioInbound,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

async function handoffAtReplyLimit(
  db: ReturnType<typeof supabaseAdmin>,
  config: AiConfig,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
    messages: ChatMessage[]
    replyCount: number
  },
): Promise<void> {
  const summary = `${buildHandoffSummary({
    messages: args.messages,
    replyCount: args.replyCount,
  })} Automatic reply limit reached.`
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary,
  }
  if (config.handoffAgentId) update.assigned_agent_id = config.handoffAgentId

  await db
    .from('conversations')
    .update(update)
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  if (!config.handoffAgentId) {
    await notifyOwnerOfQueuedHandoff(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      summary,
      title: 'AI reply limit needs attention',
    })
  }

  await engineSendText({
    accountId: args.accountId,
    userId: args.configOwnerUserId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    text: replyLimitMessage(args.messages),
    aiGenerated: true,
  })
}

async function sendAiResponse(
  db: ReturnType<typeof supabaseAdmin>,
  config: AiConfig,
  args: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    text: string
    audio: boolean
  },
): Promise<void> {
  if (!args.audio) {
    await engineSendText({ ...args, aiGenerated: true })
    return
  }

  const spokenText = config.audioMode === 'first_audio'
    ? [args.text, FIRST_AUDIO_REMINDER].filter(Boolean).join('\n\n')
    : args.text
  try {
    const apiKey = audioServiceApiKey(config)
    const bytes = await synthesizeLatinFemaleSpeech(apiKey, spokenText)
    const link = await publishGeneratedSpeech(db, args.accountId, bytes)
    await engineSendMedia({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      kind: 'audio',
      link,
      contentText: spokenText,
      mediaType: 'audio/mpeg',
      aiGenerated: true,
    })
  } catch (error) {
    console.warn('[ai auto-reply] voice response failed; sending text:', error)
    await engineSendText({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: spokenText,
      aiGenerated: true,
    })
  }
}

async function notifyOwnerOfQueuedHandoff(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    summary: string
    title?: string
  },
): Promise<void> {
  try {
    const { data: account, error: accountErr } = await db
      .from('accounts')
      .select('owner_user_id')
      .eq('id', args.accountId)
      .maybeSingle()
    if (accountErr || !account?.owner_user_id) {
      console.warn(
        '[ai auto-reply] could not resolve coordinator for queued handoff:',
        accountErr,
      )
      return
    }

    const { error: notificationErr } = await db.from('notifications').insert({
      account_id: args.accountId,
      user_id: account.owner_user_id,
      type: 'conversation_assigned',
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      actor_user_id: null,
      title: args.title ?? 'AI handoff needs assignment',
      body: args.summary,
    })
    if (notificationErr) {
      console.warn(
        '[ai auto-reply] failed to notify coordinator of queued handoff:',
        notificationErr,
      )
    }
  } catch (err) {
    console.warn(
      '[ai auto-reply] failed to notify coordinator of queued handoff:',
      err,
    )
  }
}

async function resolveAutomaticRoute(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  config: AiConfig,
  routingKey: string | undefined,
): Promise<{ targetUserId?: string; fellBack: boolean; audit: string }> {
  if (!routingKey) {
    return {
      fellBack: true,
      audit: 'no destination was selected; used the configured fallback.',
    }
  }
  const rule = config.autoAssignmentRules.find((item) => item.key === routingKey)
  if (!rule) {
    return {
      fellBack: true,
      audit: `the model returned unknown route “${routingKey}”; used the configured fallback.`,
    }
  }

  const { data: member } = await db
    .from('profiles')
    .select('user_id, full_name')
    .eq('account_id', accountId)
    .eq('user_id', rule.targetUserId)
    .maybeSingle()
  if (!member) return unavailableRoute(rule, 'is no longer an account member')

  const { data: presence } = await db
    .from('member_presence')
    .select('status, last_seen_at')
    .eq('account_id', accountId)
    .eq('user_id', rule.targetUserId)
    .maybeSingle()
  const status = derivePresence(
    presence?.status,
    presence?.last_seen_at,
    Date.now(),
  )
  if (status !== 'online') return unavailableRoute(rule, `is ${status}`)

  return {
    targetUserId: rule.targetUserId,
    fellBack: false,
    audit: `selected ${rule.label} (${rule.description}) and assigned ${member.full_name}.`,
  }
}

function unavailableRoute(
  rule: AiRoutingRule,
  reason: string,
): { fellBack: true; audit: string } {
  return {
    fellBack: true,
    audit: `selected ${rule.label} (${rule.description}), but its member ${reason}; used the configured fallback.`,
  }
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * — the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundMessageId,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing):', err)
  }
}
