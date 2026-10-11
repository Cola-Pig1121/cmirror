/**
 * API 格式注册表:渠道按"上游 API 格式"而非厂商划分(docs/plan.md 修订)。
 * - openai:Chat Completions(/v1/chat/completions),所有 OpenAI 兼容中转同用此格式
 * - anthropic:Anthropic Messages(/v1/messages)
 * - gemini:Gemini generateContent(/v1beta/...:generateContent)
 * - responses:OpenAI Responses(/v1/responses)
 */
export type FormatKey = 'openai' | 'anthropic' | 'gemini' | 'responses'

export interface FormatMeta {
  key: FormatKey
  /** UI 展示名 */
  label: string
  /** 上游鉴权头风格 */
  auth: 'bearer' | 'x-api-key' | 'x-goog-api-key'
  /** 模式 A 无渠道配置时的默认上游根地址 */
  defaultBase?: string
}

export const FORMATS: FormatMeta[] = [
  { key: 'openai', label: 'Chat Completions (/chat/completions)', auth: 'bearer', defaultBase: 'https://api.openai.com' },
  { key: 'anthropic', label: 'Anthropic Messages (/v1/messages)', auth: 'x-api-key', defaultBase: 'https://api.anthropic.com' },
  { key: 'gemini', label: 'Gemini (generateContent)', auth: 'x-goog-api-key', defaultBase: 'https://generativelanguage.googleapis.com' },
  { key: 'responses', label: 'Responses (/responses)', auth: 'bearer', defaultBase: 'https://api.openai.com' },
]

export function formatMeta(key: string): FormatMeta | undefined {
  return FORMATS.find((f) => f.key === key)
}

export function isFormatKey(key: string): key is FormatKey {
  return FORMATS.some((f) => f.key === key)
}
