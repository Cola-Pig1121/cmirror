import type { Env, TokenRecord } from '../env'
import type { Channel, OpenAIChatRequest, ProviderAdapter, Usage } from './types'
import { getAlias, loadChannels } from './channels'
import { pickKey, reportKeyResult } from './keys'
import { OpenAIError, openaiTypeFromStatus } from '../lib/errors'
import { openaiAdapter } from './providers/openai'
import { anthropicAdapter } from './providers/anthropic'
import { geminiAdapter } from './providers/gemini'
import { responsesAdapter } from './providers/responses'

export const ADAPTERS: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  responses: responsesAdapter,
}

export function adapterFor(ch: Channel): ProviderAdapter {
  return ADAPTERS[ch.format] ?? openaiAdapter
}

export function channelHasModel(ch: Channel, model: string): boolean {
  return ch.models.includes('*') || ch.models.includes(model)
}

export interface RouteCandidate {
  channel: Channel
  model: string
}

/** 别名解析 + 渠道过滤 + 按权重排序(降级顺序) */
export async function planChannels(env: Env, model: string): Promise<RouteCandidate[]> {
  let target = model
  let forcedChannel: string | undefined
  const alias = await getAlias(env, model)
  if (alias) {
    target = alias.model
    forcedChannel = alias.channel
  }
  const channels = await loadChannels(env)
  return channels
    .filter((c) => c.enabled && c.keys.length > 0)
    .filter((c) => !forcedChannel || c.id === forcedChannel)
    .filter((c) => channelHasModel(c, target))
    .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))
    .map((c) => ({ channel: c, model: target }))
}

export function checkModelAllowed(token: TokenRecord, model: string): void {
  if (!token.models || token.models.length === 0 || token.models.includes('all')) return
  if (token.models.includes(model)) return
  throw new OpenAIError(403, 'invalid_request_error', 'model_not_allowed', `token is not allowed to use model "${model}"`)
}

interface UpstreamCall {
  url: string
  headers: Record<string, string>
  body?: string
}

/** 仅对"取得响应头"计时;流式开始后的读取不受此超时影响(流式一旦输出不再切换) */
async function fetchHeadersWithin(call: UpstreamCall, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(call.url, { method: 'POST', headers: call.headers, body: call.body, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function upstreamErrorMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string }; message?: string; msg?: string }
    return j?.error?.message ?? j?.message ?? j?.msg ?? `upstream http ${res.status}`
  } catch {
    return `upstream http ${res.status}`
  }
}

export interface ChatResult {
  response: Response
  usage: Usage | Promise<Usage>
  channel: Channel
  model: string
}

/**
 * 模型 → 渠道 → key 的执行与降级:
 * 429 / 408 / 5xx / 网络错误时切换下一个渠道(key 连续失败会进入熔断);
 * 其余状态(含 4xx 参数错误)直接返回 OpenAI 格式错误;流式响应返回后不再切换。
 */
export async function executeChat(env: Env, req: OpenAIChatRequest, model: string): Promise<ChatResult> {
  const plans = await planChannels(env, model)
  if (!plans.length) {
    throw new OpenAIError(404, 'invalid_request_error', 'model_not_found', `no enabled channel supports model "${model}"`)
  }
  const stream = req.stream === true
  let lastError: { status: number; message: string } | null = null

  for (const plan of plans) {
    const adapter = adapterFor(plan.channel)
    const tried = new Set<string>()
    for (;;) {
      const key = pickKey(plan.channel, tried)
      if (!key) break
      tried.add(key)
      const call = adapter.buildChatRequest(plan.channel, key, req, plan.model)
      let res: Response
      try {
        res = await fetchHeadersWithin(call, stream ? 30_000 : 120_000)
      } catch {
        reportKeyResult(plan.channel.id, key, false)
        lastError = { status: 502, message: 'upstream network error' }
        continue // 网络错误:先试同渠道其他 key
      }
      if (res.ok) {
        reportKeyResult(plan.channel.id, key, true)
        const out = stream ? adapter.streamChatResponse(res, req, plan.model) : await adapter.nonStreamChatResponse(res, plan.model)
        return { ...out, channel: plan.channel, model: plan.model }
      }
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500
      if (res.status === 401 || res.status === 403 || retryable) reportKeyResult(plan.channel.id, key, false)
      lastError = { status: res.status, message: await upstreamErrorMessage(res) }
      if (!retryable) {
        throw new OpenAIError(res.status, openaiTypeFromStatus(res.status), 'upstream_error', lastError.message)
      }
      break // 切换下一个渠道
    }
  }
  throw new OpenAIError(lastError?.status ?? 502, openaiTypeFromStatus(lastError?.status ?? 502), 'all_channels_failed', lastError?.message ?? 'no healthy upstream')
}

interface EmbedResult {
  openaiBody: unknown
  channel: Channel
}

/** /v1/embeddings:openai 兼容直通;gemini 走 embedContent 转换;其余渠道不支持 */
export async function executeEmbeddings(env: Env, body: Record<string, unknown>): Promise<EmbedResult> {
  const model = typeof body.model === 'string' ? body.model : ''
  const plans = await planChannels(env, model)
  // embeddings:OpenAI 兼容直通 + Gemini 转换;Anthropic / Responses 无 embeddings 接口
  const usable = plans.filter((p) => p.channel.format !== 'anthropic' && p.channel.format !== 'responses')
  if (!usable.length) {
    throw new OpenAIError(404, 'invalid_request_error', 'model_not_found', `no enabled embedding-capable channel for model "${model}"`)
  }
  let lastError: { status: number; message: string } | null = null
  for (const plan of usable) {
    const tried = new Set<string>()
    for (;;) {
      const key = pickKey(plan.channel, tried)
      if (!key) break
      tried.add(key)
      try {
        let res: Response
        if (plan.channel.format === 'gemini') {
          const input = Array.isArray(body.input) ? (body.input as unknown[]) : [body.input]
          const call = {
            url: `${plan.channel.baseUrl.replace(/\/+$/, '').replace(/\/v1(beta)?$/i, '')}/v1beta/models/${encodeURIComponent(plan.model)}:embedContent`,
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ content: { parts: input.map((t) => ({ text: String(t) })) } }),
          }
          res = await fetchHeadersWithin(call, 60_000)
          if (!res.ok) {
            lastError = { status: res.status, message: await upstreamErrorMessage(res) }
            const retryable = res.status === 429 || res.status >= 500
            if (!retryable) throw new OpenAIError(res.status, openaiTypeFromStatus(res.status), 'upstream_error', lastError.message)
            break
          }
          const j = (await res.json()) as { embedding?: { values?: number[] } }
          return { openaiBody: { object: 'list', data: [{ index: 0, object: 'embedding', embedding: j.embedding?.values ?? [] }], model: plan.model }, channel: plan.channel }
        }
        const call = {
          url: openaiStyleUrl(plan.channel.baseUrl, '/v1/embeddings'),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, accept: 'application/json' },
          body: JSON.stringify({ ...body, model: plan.model }),
        }
        res = await fetchHeadersWithin(call, 60_000)
        if (!res.ok) {
          lastError = { status: res.status, message: await upstreamErrorMessage(res) }
          const retryable = res.status === 429 || res.status >= 500
          if (!retryable) throw new OpenAIError(res.status, openaiTypeFromStatus(res.status), 'upstream_error', lastError.message)
          break
        }
        return { openaiBody: await res.json(), channel: plan.channel }
      } catch (err) {
        if (err instanceof OpenAIError) throw err
        reportKeyResult(plan.channel.id, key, false)
        lastError = { status: 502, message: 'upstream network error' }
        continue
      }
    }
  }
  throw new OpenAIError(lastError?.status ?? 502, 'api_error', 'all_channels_failed', lastError?.message ?? 'no healthy upstream')
}

function openaiStyleUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `${/\/v\d+$/.test(base) ? base : base + '/v1'}`.replace(/\/v\d+$/, '') + path
}
