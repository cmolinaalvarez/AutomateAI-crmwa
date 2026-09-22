import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  engineSendMedia: vi.fn(),
  loadAccountMetaCredentials: vi.fn(),
  sendTypingIndicator: vi.fn(),
  transcribeWhatsAppAudio: vi.fn(),
  synthesizeLatinFemaleSpeech: vi.fn(),
  publishGeneratedSpeech: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    accountOwnerUserId: 'owner-1' as string | null,
    members: {} as Record<string, { user_id: string; full_name: string }>,
    presence: {} as Record<string, { status: 'online' | 'away'; last_seen_at: string }>,
    notificationPayloads: [] as Record<string, unknown>[],
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendMedia: h.engineSendMedia,
  loadAccountMetaCredentials: h.loadAccountMetaCredentials,
}))
vi.mock('./audio', () => ({
  audioServiceApiKey: (config: AiConfig) => config.apiKey,
  FIRST_AUDIO_REMINDER: 'Please continue in text.',
  transcribeWhatsAppAudio: h.transcribeWhatsAppAudio,
  synthesizeLatinFemaleSpeech: h.synthesizeLatinFemaleSpeech,
  publishGeneratedSpeech: h.publishGeneratedSpeech,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTypingIndicator: h.sendTypingIndicator,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: h.state.accountOwnerUserId
                    ? { owner_user_id: h.state.accountOwnerUserId }
                    : null,
                  error: null,
                }),
            }),
          }),
        }
      }
      if (table === 'notifications') {
        return {
          insert: (payload: Record<string, unknown>) => {
            h.state.notificationPayloads.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'profiles' || table === 'member_presence') {
        let userId = ''
        const chain = {
          select: () => chain,
          eq: (column: string, value: string) => {
            if (column === 'user_id') userId = value
            return chain
          },
          maybeSingle: () => Promise.resolve({
            data: table === 'profiles'
              ? h.state.members[userId] ?? null
              : h.state.presence[userId] ?? null,
            error: null,
          }),
        }
        return chain
      }
      // conversations
      const selectChain = {
        eq: () => selectChain,
        maybeSingle: () =>
          Promise.resolve({ data: h.state.conv, error: null }),
      }
      const updateChain = {
        eq: () => updateChain,
        then: (resolve: (value: { error: null }) => unknown) =>
          Promise.resolve({ error: null }).then(resolve),
      }
      return {
        select: () => selectChain,
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return updateChain
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    audioMode: 'text_only',
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    autoAssignmentEnabled: false,
    autoAssignmentRules: [],
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.accountOwnerUserId = 'owner-1'
  h.state.members = {}
  h.state.presence = {}
  h.state.notificationPayloads = []
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([
    { role: 'user', content: 'I need help with my order' },
  ])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.engineSendMedia.mockResolvedValue({ whatsapp_message_id: 'm2' })
  h.transcribeWhatsAppAudio.mockResolvedValue('I need help with billing')
  h.synthesizeLatinFemaleSpeech.mockResolvedValue(new Uint8Array([1]))
  h.publishGeneratedSpeech.mockResolvedValue('https://example.com/reply.mp3')
  h.loadAccountMetaCredentials.mockResolvedValue({
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })
  h.sendTypingIndicator.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('does not spend an AI call for audio when audio replies are disabled', async () => {
    await dispatchInboundToAiReply({ ...ARGS, inboundContentType: 'audio' })
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('processes and answers audio in full-audio mode', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ audioMode: 'full_audio' }))
    await dispatchInboundToAiReply({
      ...ARGS,
      inboundContentType: 'audio',
      inboundMediaId: 'media-1',
    })
    expect(h.transcribeWhatsAppAudio).toHaveBeenCalledTimes(1)
    expect(h.buildConversationContext).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      undefined,
      true,
    )
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audio', contentText: 'Hello!' }),
    )
  })

  it('only accepts audio as the first customer message in first-audio mode', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ audioMode: 'first_audio' }))
    await dispatchInboundToAiReply({
      ...ARGS,
      inboundContentType: 'audio',
      inboundMediaId: 'media-1',
      inboundIsFirstMessage: false,
    })
    expect(h.transcribeWhatsAppAudio).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()

    await dispatchInboundToAiReply({
      ...ARGS,
      inboundContentType: 'audio',
      inboundMediaId: 'media-1',
      inboundIsFirstMessage: true,
    })
    expect(h.transcribeWhatsAppAudio).toHaveBeenCalledTimes(1)
    expect(h.engineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        contentText: 'Hello!\n\nPlease continue in text.',
      }),
    )
  })

  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('answers a greeting locally without model, knowledge, or handoff', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Hola buenas tardes' },
    ])

    await dispatchInboundToAiReply(ARGS)

    expect(h.retrieveKnowledge).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '¡Hola! ¿En qué podemos ayudarte?',
      }),
    )
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('hands off when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    })
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('our team') }),
    )
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('hands off and informs the customer when the cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_summary: expect.stringContaining('reply limit reached'),
    })
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('our team') }),
    )
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAccountMetaCredentials).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
    )
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.inbound-1',
    })
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.sendTypingIndicator.mock.invocationCallOrder[0]
    const llmOrder = h.generateReply.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
    h.sendTypingIndicator.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
    h.loadAccountMetaCredentials.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundMessageId: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
    expect(h.state.notificationPayloads).toEqual([
      expect.objectContaining({
        user_id: 'owner-1',
        conversation_id: 'conv-1',
        title: 'AI handoff needs assignment',
      }),
    ])
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
    expect(h.state.notificationPayloads).toHaveLength(0)
  })

  it('automatically routes to the selected online specialist', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({
      autoAssignmentEnabled: true,
      autoAssignmentRules: [{
        key: 'billing',
        label: 'Billing',
        description: 'Invoices and refunds',
        targetUserId: 'agent-8',
      }],
    }))
    h.state.members['agent-8'] = { user_id: 'agent-8', full_name: 'Ada Billing' }
    h.state.presence['agent-8'] = {
      status: 'online',
      last_seen_at: new Date().toISOString(),
    }
    h.generateReply.mockResolvedValue({
      text: '',
      handoff: true,
      routingKey: 'billing',
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.updatePayload).toMatchObject({
      assigned_agent_id: 'agent-8',
      ai_autoreply_disabled: true,
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('selected Billing')
    expect(h.state.notificationPayloads).toHaveLength(0)
  })

  it('uses the global fallback and alerts the owner when the specialist is away', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({
      handoffAgentId: 'coordinator-1',
      autoAssignmentEnabled: true,
      autoAssignmentRules: [{
        key: 'sales',
        label: 'Sales',
        description: 'New purchases',
        targetUserId: 'agent-9',
      }],
    }))
    h.state.members['agent-9'] = { user_id: 'agent-9', full_name: 'Sam Sales' }
    h.state.presence['agent-9'] = {
      status: 'away',
      last_seen_at: new Date().toISOString(),
    }
    h.generateReply.mockResolvedValue({ text: '', handoff: true, routingKey: 'sales' })

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.updatePayload).toMatchObject({ assigned_agent_id: 'coordinator-1' })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('member is away')
    expect(h.state.notificationPayloads).toEqual([
      expect.objectContaining({
        user_id: 'owner-1',
        title: 'AI routing fallback needs attention',
      }),
    ])
  })

  it('falls back when the specialist heartbeat is stale', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({
      autoAssignmentEnabled: true,
      autoAssignmentRules: [{
        key: 'support',
        label: 'Support',
        description: 'Technical issues',
        targetUserId: 'agent-10',
      }],
    }))
    h.state.members['agent-10'] = { user_id: 'agent-10', full_name: 'Tess Support' }
    h.state.presence['agent-10'] = {
      status: 'online',
      last_seen_at: new Date(Date.now() - 120_000).toISOString(),
    }
    h.generateReply.mockResolvedValue({ text: '', handoff: true, routingKey: 'support' })

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('member is offline')
    expect(h.state.notificationPayloads).toHaveLength(1)
  })

  it('sends the customer-facing message included with a handoff', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Un especialista del equipo te escribirá en breve por este medio.',
      handoff: true,
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: 'Un especialista del equipo te escribirá en breve por este medio.',
        aiGenerated: true,
      }),
    )
  })
})
