/** 渠道配置(存 KV channel:<id>,见 docs/plan.md §9) */
export interface Channel {
  id: string
  /** 'anthropic' | 'gemini' | 其余一律按 OpenAI 兼容处理 */
  provider: string
  /** 根地址,如 https://api.openai.com;OpenAI 兼容系若含 /v1 会自动识别 */
  baseUrl: string
  keys: string[]
  /** 支持的模型;'*' = 全部直通 */
  models: string[]
  weight: number
  enabled: boolean
  note?: string
}

export interface OpenAIChatRequest {
  model: string
  messages: unknown[]
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  max_completion_tokens?: number
  stop?: string | string[]
  tools?: { type?: string; function?: { name: string; description?: string; parameters?: Record<string, unknown> } }[]
  tool_choice?: unknown
  stream_options?: { include_usage?: boolean }
  [k: string]: unknown
}

export interface Usage {
  input: number
  output: number
}

export interface UpstreamRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * 供应商适配器:把 OpenAI 格式请求转换到上游,并把响应(含 SSE)转换回 OpenAI 格式。
 * usage 在流式场景下于流正常结束/收到 usage 事件后 resolve;客户端断开则不 resolve,
 * 调用方必须用 ctx.waitUntil 承接以免丢额度且不阻塞响应。
 */
export interface ProviderAdapter {
  provider: string
  buildChatRequest(ch: Channel, key: string, req: OpenAIChatRequest, model: string): UpstreamRequest
  /** 上游成功响应 → OpenAI 格式 JSON 响应 + usage */
  nonStreamChatResponse(res: Response, model: string): Promise<{ response: Response; usage: Usage }>
  /** 上游 SSE → OpenAI SSE */
  streamChatResponse(res: Response, req: OpenAIChatRequest, model: string): { response: Response; usage: Promise<Usage> }
}

export const DEFAULT_TIMEOUT_MS = 30_000

export function openaiErrorBody(status: number, message: string, type: string, code?: string): string {
  return JSON.stringify({ error: { message, type, code: code ?? String(status) } })
}
