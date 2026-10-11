import type { Env } from '../env'
import { ApiError } from '../lib/errors'

const WINDOW_MS = 60_000
const TTL_S = 120

export interface RateLimits {
  perIp?: number
  perToken?: number
}

const DEFAULT_LIMITS: Required<RateLimits> = { perIp: 30, perToken: 60 }

/**
 * 粗粒度限流:KV 按 60s 窗口计数(read-modify-write,允许少量并发误差,见 docs/plan.md §6)。
 * 计数写入走 ctx.waitUntil,不阻塞响应。
 */
export async function enforceRateLimit(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  tokenId: string,
  limits: RateLimits = {},
): Promise<void> {
  const perIp = limits.perIp ?? DEFAULT_LIMITS.perIp
  const perToken = limits.perToken ?? DEFAULT_LIMITS.perToken
  const ip = request.headers.get('cf-connecting-ip') ?? 'local'
  const bucket = Math.floor(Date.now() / WINDOW_MS)

  const results = await Promise.all([
    bumpKV(env, ctx, `rl:ip:${ip}:${bucket}`, perIp),
    bumpKV(env, ctx, `rl:t:${tokenId}:${bucket}`, perToken),
  ])
  const hit = results.find((r) => r.over)
  if (hit) {
    throw new ApiError(429, 'rate_limited', `rate limit exceeded (${hit.limit}/min)`)
  }
}

async function bumpKV(env: Env, ctx: ExecutionContext, key: string, limit: number) {
  const cur = Number((await env.KV.get(key, { type: 'text' })) ?? '0')
  const next = (Number.isFinite(cur) ? cur : 0) + 1
  ctx.waitUntil(env.KV.put(key, String(next), { expirationTtl: TTL_S }))
  return { over: next > limit, limit }
}
