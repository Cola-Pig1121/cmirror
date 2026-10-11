const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** AI 网关内抛错使用 OpenAI 兼容错误体,保证官方 SDK 客户端能解析 */
export class OpenAIError extends Error {
  constructor(
    public status: number,
    public type: string,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OpenAIError'
  }
}

export function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: JSON_HEADERS })
}

export function openaiError(status: number, type: string, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type, code } }), { status, headers: JSON_HEADERS })
}

/** 上游 HTTP 状态 → OpenAI 错误 type */
export function openaiTypeFromStatus(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500 || status === 408) return 'api_error'
  return 'invalid_request_error'
}
