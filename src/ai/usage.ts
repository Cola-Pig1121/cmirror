import type { Env, TokenRecord } from '../env'
import type { Channel, Usage } from './types'
import { noteMetric } from '../middleware/logger'

/**
 * AI 用量记录:
 * - 请求元数据(model / 渠道 / token 数)写入本次请求的指标,由 afterResponse 统一进 Analytics Engine;
 * - 额度扣减写 KV(token:<hash>),走 waitUntil 不阻塞响应;提示词与回复内容不落盘。
 */
export function noteAIUsage(request: Request, channel: Channel, model: string): void {
  noteMetric(request, { model, channel: channel.id, provider: channel.provider })
}

export async function debitTokenUsage(env: Env, tokenKey: string, record: TokenRecord, usage: Usage): Promise<void> {
  const { raw, hashKey, ...rest } = record
  const current = (await env.KV.get<TokenRecord>(tokenKey, 'json')) ?? rest
  await env.KV.put(
    tokenKey,
    JSON.stringify({
      ...current,
      usedRequests: (current.usedRequests ?? 0) + 1,
      usedTokens: (current.usedTokens ?? 0) + usage.input + usage.output,
    }),
  )
}

export function trackAIUsage(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  token: TokenRecord,
  channel: Channel,
  model: string,
  usage: Usage | Promise<Usage>,
): void {
  noteAIUsage(request, channel, model)
  if (token.id === 'admin' || !token.hashKey) return
  const key = token.hashKey
  ctx.waitUntil(
    Promise.resolve(usage)
      .then((u) => debitTokenUsage(env, key, token, u))
      .catch(() => {}),
  )
}
