import type { Env } from '../env'
import { OpenAIError } from '../lib/errors'
import { getEnv } from '../runtime'
import { outboundBody } from '../lib/stream'
import { pickKey, reportKeyResult } from './keys'
import { loadChannels } from './channels'
import { formatMeta } from './formats'
import type { Channel } from './types'

/**
 * 模式 A:透明代理(只换域名/换 key,正文零解析)。
 * /ai/<seg>/<上游路径> —— seg 优先按渠道 id 精确匹配,其次按 API 格式(openai/anthropic/gemini/responses)。
 */
const DROP_HEADERS = new Set([
  'authorization',
  'x-token',
  'cookie',
  'host',
  'connection',
  'keep-alive',
  'upgrade-insecure-requests',
  'accept-encoding',
  'content-length',
])

export function applyUpstreamAuth(format: string, headers: Headers, key: string): void {
  const meta = formatMeta(format)
  if (meta?.auth === 'x-api-key') {
    headers.set('x-api-key', key)
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')
  } else if (meta?.auth === 'x-goog-api-key') {
    headers.set('x-goog-api-key', key)
  } else {
    headers.set('authorization', `Bearer ${key}`)
  }
}

export function resolvePassthroughChannel(channels: Channel[], seg: string): Channel | undefined {
  const enabled = channels.filter((c) => c.enabled && c.keys.length > 0)
  const byId = enabled.find((c) => c.id === seg)
  if (byId) return byId
  return enabled.filter((c) => c.format === seg).sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))[0]
}

export function buildPassthroughUrl(baseUrl: string, rest: string, search: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  let path = rest.replace(/^\/+/, '')
  // 渠道 baseUrl 常含 /v1,客户端 SDK 又拼 v1/...,避免重复
  if (path.startsWith('v1/') && /\/v1$/i.test(base)) path = path.slice(3)
  return base + '/' + path + (search || '')
}

export async function passthroughUpstream(request: Request, seg: string, parsedBody?: unknown): Promise<Response> {
  const env = getEnv(request)
  const channel = resolvePassthroughChannel(await loadChannels(env), seg)
  if (!channel) {
    throw new OpenAIError(404, 'invalid_request_error', 'provider_not_found', `no channel matches id or format "${seg}"`)
  }
  const key = pickKey(channel)
  if (!key) throw new OpenAIError(503, 'api_error', 'keys_exhausted', `all keys for channel "${channel.id}" are cooling down`)

  const url = request.url
  const marker = '/ai/' + seg + '/'
  const at = url.indexOf(marker)
  const restPath = at === -1 ? '' : url.slice(at + marker.length)
  const qIdx = restPath.indexOf('?')
  const path = qIdx === -1 ? restPath : restPath.slice(0, qIdx)
  const search = qIdx === -1 ? '' : restPath.slice(qIdx)

  const headers = new Headers()
  for (const [k, v] of request.headers.entries()) {
    const lk = k.toLowerCase()
    if (DROP_HEADERS.has(lk) || lk.startsWith('cf-') || lk.startsWith('x-forwarded-')) continue
    headers.set(k, v)
  }
  applyUpstreamAuth(channel.format, headers, key)

  const res = await fetch(buildPassthroughUrl(channel.baseUrl, path, search), {
    method: request.method,
    headers,
    body: outboundBody(request, parsedBody),
    redirect: 'manual',
    duplex: 'half',
  } as RequestInit)

  const keyFailed = res.status === 401 || res.status === 403 || res.status === 408 || res.status === 429 || res.status >= 500
  reportKeyResult(channel.id, key, !keyFailed)

  const outHeaders = new Headers()
  for (const [k, v] of res.headers.entries()) {
    const lk = k.toLowerCase()
    if (lk.startsWith('cf-') || lk === 'server' || lk === 'set-cookie' || lk === 'x-request-id' || lk === 'x-frame-options' || lk.startsWith('content-security-policy')) continue
    outHeaders.set(k, v)
  }
  // 透传上游状态与响应体(含 SSE),不做解析
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: outHeaders })
}
