import type { Env } from '../env'
import { getBindings } from '../runtime'

export interface RequestMetric {
  tokenId?: string
  scope?: string
  model?: string
  channel?: string
  format?: string
  inputTokens?: number
  outputTokens?: number
  status?: number
}

const starts = new WeakMap<Request, number>()
const metrics = new WeakMap<Request, RequestMetric>()

export function markStart(request: Request) {
  starts.set(request, Date.now())
}

export function noteMetric(request: Request, patch: RequestMetric): void {
  const cur = metrics.get(request) ?? {}
  metrics.set(request, { ...cur, ...patch })
}

export function getMetric(request: Request): RequestMetric {
  return metrics.get(request) ?? {}
}

export function logRequest(request: Request, status: number) {
  const { env } = getBindings(request)
  const m = metrics.get(request) ?? {}
  const ms = Date.now() - (starts.get(request) ?? Date.now())
  const url = new URL(request.url)
  try {
    // @cloudflare/workers-types v5 形态:indexes / doubles / blobs
    env.ANALYTICS?.writeDataPoint({
      indexes: [
        url.pathname.startsWith('/m/') ? 'mirror' : m.scope ?? 'other',
        String(status),
        m.model ?? '',
        m.channel ?? m.format ?? '',
      ],
      doubles: [ms, m.inputTokens ?? 0, m.outputTokens ?? 0],
      blobs: [url.pathname.slice(0, 48), request.method],
    })
    console.log(JSON.stringify({ ts: Date.now(), path: url.pathname, status, ms, token: m.tokenId ?? null }))
  } catch (err) {
    console.warn('metric write failed:', err instanceof Error ? err.message : String(err))
  }
}

/** 额度扣减(按请求次数;AI 路径由 trackAIUsage 合并处理):写 KV,走 waitUntil */
export function debitRequest(
  env: Env,
  ctx: ExecutionContext,
  tokenKey: string | undefined,
  record: import('../env').TokenRecord,
): void {
  if (!tokenKey || tokenKey.startsWith('admin')) return
  const { raw, hashKey, ...rest } = record
  ctx.waitUntil(
    env.KV.put(tokenKey, JSON.stringify({ ...rest, usedRequests: (rest.usedRequests ?? 0) + 1 })),
  )
}
