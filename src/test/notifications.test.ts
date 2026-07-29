import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:sockets', () => ({
  connect: vi.fn(),
}))

import worker from '../index'
import { validateNotificationConfig } from '../notifications/config'
import { createTestDb, makeAuthHeader, makeEnv } from './setup'

describe('notification provider configuration', () => {
  it('validates Slack webhook URLs before delivery', () => {
    expect(validateNotificationConfig('slack', {})).toBe('Slack webhook URL is required')
    expect(validateNotificationConfig('slack', {
      webhookUrl: 'https://example.com/services/not-a-slack-hook',
    })).toContain('valid Slack incoming webhook URL')
    expect(validateNotificationConfig('slack', {
      webhookUrl: 'https://hooks.slack.com/services/T000/B000/secret',
    })).toBeNull()
  })

  it('validates Telegram bot tokens and destinations before delivery', () => {
    expect(validateNotificationConfig('telegram', {
      botToken: 'not-a-token',
      chatId: '-1001234567890',
    })).toContain('BotFather')
    expect(validateNotificationConfig('telegram', {
      botToken: '123456789:AAExampleTokenThatIsLongEnough',
      chatId: 'not a chat',
    })).toContain('numeric Telegram chat ID')
    expect(validateNotificationConfig('telegram', {
      botToken: '123456789:AAExampleTokenThatIsLongEnough',
      chatId: '-1001234567890',
    })).toBeNull()
  })
})

describe('notification connection tests', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>
  let authHeader: string
  let providerFetch: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    ctx = await createTestDb()
    authHeader = await makeAuthHeader()
    providerFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', providerFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function post(path: string, body?: unknown) {
    return worker.fetch(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), makeEnv(ctx.d1))
  }

  it('rejects incomplete Slack channels instead of saving a broken configuration', async () => {
    const response = await post('/api/notifications', {
      name: 'Operations Slack',
      type: 'slack',
      config: {},
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'Slack webhook URL is required' })
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it('sends a real Slack preview without saving the channel', async () => {
    const response = await post('/api/notifications/test', {
      name: 'Operations Slack',
      type: 'slack',
      config: {
        webhookUrl: 'https://hooks.slack.com/services/T000/B000/secret',
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(providerFetch).toHaveBeenCalledOnce()
    expect(providerFetch.mock.calls[0][0]).toBe('https://hooks.slack.com/services/T000/B000/secret')
    expect(JSON.parse(String(providerFetch.mock.calls[0][1]?.body))).toMatchObject({
      text: expect.stringContaining('Test Monitor'),
    })
  })

  it('encrypts a saved Slack webhook and decrypts it for a later delivery test', async () => {
    const createResponse = await post('/api/notifications', {
      name: 'Operations Slack',
      type: 'slack',
      config: {
        webhookUrl: 'https://hooks.slack.com/services/T000/B000/secret',
      },
    })
    expect(createResponse.status).toBe(201)
    const channel = await createResponse.json() as { id: string; config: string; encryptedFields: string[] }
    expect(JSON.parse(channel.config).webhookUrl).toBe('')
    expect(channel.encryptedFields).toContain('webhookUrl')

    providerFetch.mockClear()
    const testResponse = await post(`/api/notifications/${channel.id}/test`)

    expect(testResponse.status).toBe(200)
    expect(providerFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/T000/B000/secret',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('sends Telegram previews to the configured chat', async () => {
    const response = await post('/api/notifications/test', {
      name: 'On-call Telegram',
      type: 'telegram',
      config: {
        botToken: '123456789:AAExampleTokenThatIsLongEnough',
        chatId: '-1001234567890',
      },
    })

    expect(response.status).toBe(200)
    expect(providerFetch).toHaveBeenCalledOnce()
    expect(providerFetch.mock.calls[0][0]).toContain(
      'https://api.telegram.org/bot123456789:AAExampleTokenThatIsLongEnough/sendMessage',
    )
    expect(JSON.parse(String(providerFetch.mock.calls[0][1]?.body))).toMatchObject({
      chat_id: '-1001234567890',
      parse_mode: 'HTML',
    })
  })
})
