import type { Channel, OpenAIChatRequest, ProviderAdapter, Usage } from '../types'
import { sseLine, SSE_DONE, takeSSEEvents, type SSEEvent } from '../../lib/stream'
import { deferred } from '../../lib/deferred'

/** 规范化 OpenAI 兼容 baseUrl:去掉尾部 /v1(避免拼成 /v1/v1) */
export function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v\d+(alpha|beta)?$/i, '')
}

export function openaiUrl(baseUrl: string, path: string): string {
  return `${normalizeBase(baseUrl)}${path}`
}

/**
 * OpenAI 及兼容类供应商(DeepSeek、OpenRouter、各类中转):请求/响应均直通。
 * 流式直通(零转换),仅在尾部嗅探 usage 用于计费,不缓冲整块。
 */
export const openaiAdapter: ProviderAdapter = {
  provider: 'openai',

  buildChatRequest(ch: Channel, key: string, req: OpenAIChatRequest, model: string) {
    return {
      url: openaiUrl(ch.baseUrl, '/v1/chat/completions'),
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...req, model }),
    }
  },

  async nonStreamChatResponse(res: Response, _model: string) {
    const json = (await res.clone().json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null
    return {
      response: new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }),
      usage: extractUsage(json),
    }
  },

  streamChatResponse(res: Response, _req: OpenAIChatRequest, _model: string) {
    let usage: Usage = { input: 0, output: 0 }
    const { promise, resolve } = deferred<Usage>()
    const upstream = res.body as ReadableStream<Uint8Array>
    let buf = ''
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const reader = upstream.getReader()
        const dec = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) ctrl.enqueue(value)
          buf += dec.decode(value ?? new Uint8Array(), { stream: true })
          const { events, rest } = takeSSEEvents(buf)
          buf = rest
          for (const ev of events) {
            const u = usageFromSSEData(ev.data)
            if (u) usage = u
          }
        }
        buf += dec.decode()
        const { events } = takeSSEEvents(buf, true)
        for (const ev of events) {
          const u = usageFromSSEData(ev.data)
          if (u) usage = u
        }
        ctrl.close()
        resolve(usage)
      },
    })
    return {
      response: new Response(stream, {
        status: res.status,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      }),
      usage: promise,
    }
  },
}

function usageFromSSEData(data: string): Usage | null {
  if (!data || data === '[DONE]') return null
  try {
    const j = JSON.parse(data) as { usage?: unknown }
    if (j.usage) {
      const u = extractUsage(j)
      if (u.input || u.output) return u
    }
  } catch {
    /* 非 JSON 块忽略 */
  }
  return null
}

export function extractUsage(json: unknown): Usage {
  const j = json as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null
  const u = j?.usage
  if (!u) return { input: 0, output: 0 }
  return { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 }
}

export { sseLine, SSE_DONE }
