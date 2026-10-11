import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeChat, checkModelAllowed, planChannels, channelHasModel } from '../src/ai/router'
import { pickKey, reportKeyResult, keyAvailable, __resetKeyStates } from '../src/ai/keys'
import { OpenAIError } from '../src/lib/errors'
import { makeEnv, seedChannel, sseStream } from './helpers'
import type { Channel } from '../src/ai/types'

const A1: Channel = { id: 'a1', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', keys: ['k1'], models: ['claude-test'], weight: 2, enabled: true }
const A2: Channel = { id: 'a2', provider: 'anthropic', baseUrl: 'https://alt.anthropic.example', keys: ['k2'], models: ['claude-test'], weight: 1, enabled: true }

const anthropicJSON = {
  id: 'msg_1',
  model: 'claude-test',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 1, output_tokens: 2 },
}

beforeEach(() => __resetKeyStates())
afterEach(() => vi.unstubAllGlobals())

describe('keys pool', () => {
  it('round-robins keys', () => {
    const ch: Channel = { ...A1, keys: ['k1', 'k2', 'k3'] }
    const picks = [pickKey(ch), pickKey(ch), pickKey(ch)]
    expect(new Set(picks).size).toBe(3)
  })
  it('skips excluded and circuit-breaks after 3 consecutive failures', () => {
    const ch: Channel = { ...A1, keys: ['k1', 'k2'] }
    reportKeyResult(ch.id, 'k1', false)
    reportKeyResult(ch.id, 'k1', false)
    expect(keyAvailable(ch.id, 'k1')).toBe(true)
    reportKeyResult(ch.id, 'k1', false)
    expect(keyAvailable(ch.id, 'k1')).toBe(false)
    expect(pickKey(ch)).toBe('k2')
    // 成功恢复
    expect(keyAvailable(ch.id, 'k1', Date.now() + 61_000)).toBe(true)
    reportKeyResult(ch.id, 'k2', true)
    expect(keyAvailable(ch.id, 'k2')).toBe(true)
  })
})

describe('planChannels', () => {
  it('filters enabled & model-matching, sorts by weight', async () => {
    const { env } = makeEnv()
    await seedChannel(env.KV as never, { ...A1 })
    await seedChannel(env.KV as never, { ...A2 })
    await seedChannel(env.KV as never, { ...A1, id: 'other', models: ['gpt-x'] })
    await seedChannel(env.KV as never, { ...A1, id: 'off', enabled: false })
    const plans = await planChannels(env, 'claude-test')
    expect(plans.map((p) => p.channel.id)).toEqual(['a1', 'a2'])
  })
  it('alias resolves model and can pin channel', async () => {
    const { env } = makeEnv()
    await seedChannel(env.KV as never, A1)
    await env.KV.put('alias:fast', JSON.stringify({ model: 'claude-test', channel: 'a2' }))
    await seedChannel(env.KV as never, A2)
    const plans = await planChannels(env, 'fast')
    expect(plans).toHaveLength(1)
    expect(plans[0]!.channel.id).toBe('a2')
    expect(plans[0]!.model).toBe('claude-test')
  })
  it('wildcard model match', () => {
    expect(channelHasModel({ ...A1, models: ['*'] }, 'anything')).toBe(true)
  })
})

describe('checkModelAllowed', () => {
  it('empty models = unrestricted; list restricts', () => {
    const t: import('../src/env').TokenRecord = { id: 'x', name: 'x', scopes: ['ai'], createdAt: 0 }
    expect(() => checkModelAllowed(t, 'any')).not.toThrow()
    expect(() => checkModelAllowed({ ...t, models: ['gpt-a'] }, 'gpt-b')).toThrow(OpenAIError)
    expect(() => checkModelAllowed({ ...t, models: ['gpt-a'] }, 'gpt-a')).not.toThrow()
  })
})

describe('executeChat', () => {
  it('falls through on 429 to the next channel', async () => {
    const { env } = makeEnv()
    await seedChannel(env.KV as never, { ...A1 })
    await seedChannel(env.KV as never, { ...A2 })
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      async (url: RequestInfo | URL) => {
        const u = String(url)
        calls.push(u)
        if (u.includes('api.anthropic.com')) return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 })
        return new Response(JSON.stringify(anthropicJSON), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    )
    const result = await executeChat(env, { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }, 'claude-test')
    expect(calls).toHaveLength(2)
    expect(result.channel.id).toBe('a2')
    const body = (await result.response.json()) as { choices: { message: { content: string } }[] }
    expect(body.choices[0]!.message.content).toBe('ok')
  })

  it('non-retryable 400 returns openai error immediately without trying next channel', async () => {
    const { env } = makeEnv()
    await seedChannel(env.KV as never, { ...A1 })
    await seedChannel(env.KV as never, { ...A2 })
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })
    })
    await expect(executeChat(env, { model: 'claude-test', messages: [] }, 'claude-test')).rejects.toThrow(/bad request/)
    expect(calls).toBe(1)
  })

  it('no channel → model_not_found', async () => {
    const { env } = makeEnv()
    await expect(executeChat(env, { model: 'nope', messages: [] }, 'nope')).rejects.toThrow(/model_not_found|no enabled channel/)
  })

  it('all keys cooling down → 502, and request does not hang', async () => {
    const { env } = makeEnv()
    const ch = { ...A1, keys: ['only'] }
    await seedChannel(env.KV as never, ch)
    reportKeyResult(ch.id, 'only', false)
    reportKeyResult(ch.id, 'only', false)
    reportKeyResult(ch.id, 'only', false)
    let called = false
    vi.stubGlobal('fetch', async () => {
      called = true
      return new Response(JSON.stringify(anthropicJSON))
    })
    await expect(executeChat(env, { model: 'claude-test', messages: [] }, 'claude-test')).rejects.toThrow(/no healthy upstream/)
    expect(called).toBe(false)
  })

  it('network error on first channel falls back, marks key failed', async () => {
    const { env } = makeEnv()
    await seedChannel(env.KV as never, { ...A1 })
    await seedChannel(env.KV as never, { ...A2 })
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      if (String(url).includes('api.anthropic.com')) throw new TypeError('connection reset')
      return new Response(JSON.stringify(anthropicJSON), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const result = await executeChat(env, { model: 'claude-test', messages: [] }, 'claude-test')
    expect(result.channel.id).toBe('a2')
    expect(keyAvailable(A1.id, 'k1')).toBe(true) // 单次网络错误未达阈值
  })

  it('stream passthrough for openai-compatible', async () => {
    const { env } = makeEnv()
    const ch: Channel = { id: 'o1', provider: 'openai', baseUrl: 'https://api.openai.com', keys: ['sk'], models: ['gpt-x'], weight: 1, enabled: true }
    await seedChannel(env.KV as never, ch)
    const sse = 'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n'
    vi.stubGlobal('fetch', async () => new Response(sseStream(sse), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const result = await executeChat(env, { model: 'gpt-x', messages: [], stream: true }, 'gpt-x')
    expect(result.response.status).toBe(200)
    const text = await result.response.text()
    expect(text).toBe(sse) // 逐字节直通
    expect(await result.usage).toEqual({ input: 3, output: 4 })
  })
})
