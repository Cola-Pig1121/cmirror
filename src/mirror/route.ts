import { Elysia } from 'elysia'
import { getEnv, getCtx } from '../runtime'
import { requireScope } from '../middleware/auth'
import { enforceRateLimit } from '../middleware/ratelimit'
import { noteMetric, debitRequest } from '../middleware/logger'
import { ApiError } from '../lib/errors'
import { validateTargetUrl, type SsrfResult } from '../lib/ssrf'
import { loadRules, matchRule, ruleAllowsPath, autoModeFor } from './rules'
import { sanitizeUpstreamHeaders, sanitizeResponseHeaders } from './headers'
import { resolveMode, isGitSmartPath } from './github'
import { rewriteHTMLResponse, rewriteCSSText } from './rewrite'
import { outboundBody } from '../lib/stream'

const BODYLESS = new Set(['GET', 'HEAD'])
const UPSTREAM_HEADER_TIMEOUT_MS = 20_000

export type ForcedMode = 'stream' | 'rewrite'

/**
 * 解析 /m/ 后的路径:可选模式段(/m/stream/…、/m/rewrite/…),裸 /m/ 为 auto。
 * 模式编码在路径里,HTML 改写后页面内链接自动继承。
 */
export function parseMirrorPath(raw: string): { mode: ForcedMode | null; rest: string } {
  if (raw.startsWith('stream/')) return { mode: 'stream', rest: raw.slice('stream/'.length) }
  if (raw.startsWith('rewrite/')) return { mode: 'rewrite', rest: raw.slice('rewrite/'.length) }
  return { mode: null, rest: raw }
}

/** 同时接受 /m/https://… 与 /m/https%3A%2F%2F… 两种写法 */
function decodeTarget(raw: string): SsrfResult {
  const candidates: string[] = []
  try {
    candidates.push(decodeURIComponent(raw))
  } catch {
    /* 编码畸形时退回原始串 */
  }
  candidates.push(raw)
  let firstFail: SsrfResult | null = null
  for (const cand of candidates) {
    const r = validateTargetUrl(cand)
    if (r.ok) return r
    if (!firstFail) firstFail = r
  }
  return firstFail ?? { ok: false, reason: 'invalid_url' }
}

export const mirrorModule = new Elysia({ name: 'mirror' })
  .all('/m/*', async (c) => {
    const env = getEnv(c.request)
    const ctx = getCtx(c.request)

    const token = await requireScope(c.request, env, 'mirror')
    noteMetric(c.request, { tokenId: token.id, scope: 'mirror' })
    await enforceRateLimit(env, ctx, c.request, token.id, { perToken: token.rpm })
    debitRequest(env, ctx, token.hashKey, token)

    const reqUrl = new URL(c.request.url)
    if (!reqUrl.pathname.startsWith('/m/')) throw new ApiError(400, 'invalid_target', 'empty target')
    const { mode: forced, rest } = parseMirrorPath(reqUrl.pathname.slice('/m/'.length))
    const check = decodeTarget(rest)
    if (!check.ok) throw new ApiError(400, 'invalid_target', `target rejected: ${check.reason}`)
    const target = check.url
    // 查询串单独携带(git smart HTTP 依赖 ?service=…),不经过 decode 避免二次解码破坏
    if (reqUrl.search) target.search = reqUrl.search

    const rules = await loadRules(env)
    const rule = matchRule(rules, target.hostname)
    if (rule && !ruleAllowsPath(rule, target.pathname)) throw new ApiError(403, 'path_not_allowed', 'path outside rule prefixes')
    // 模式优先级:git 协议路径恒 stream > URL 强制段 > 规则 > 按响应类型 auto
    let mode: 'rewrite' | 'stream' | 'auto'
    if (isGitSmartPath(target.pathname)) mode = 'stream'
    else if (forced) mode = forced
    else if (rule) mode = resolveMode(rule, target.pathname)
    else mode = 'auto'
    const mirrorBase = reqUrl.origin + '/m/' + (forced ? forced + '/' : '')

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_HEADER_TIMEOUT_MS)
    let upstream: Response
    try {
      upstream = await fetch(target.href, {
        method: c.request.method,
        headers: sanitizeUpstreamHeaders(c.request, target, rule?.referer),
        body: outboundBody(c.request, c.body),
        redirect: 'manual',
        signal: ctrl.signal,
        // Node(undici)对流式请求体要求 duplex;workerd 忽略未知键
        duplex: 'half',
      } as RequestInit)
    } catch (err) {
      if (err instanceof ApiError) throw err
      console.warn('mirror upstream fetch failed:', err instanceof Error ? err.message + ' / ' + err.name : String(err))
      throw new ApiError(502, 'upstream_error', 'failed to fetch upstream target')
    } finally {
      clearTimeout(timer)
    }

    const maxBytes = rule?.maxBytes ?? 100 * 1024 * 1024
    const len = Number(upstream.headers.get('content-length') ?? '0')
    if (len > maxBytes) throw new ApiError(413, 'too_large', `response exceeds ${maxBytes} byte mirror limit`)

    const ct = (upstream.headers.get('content-type') ?? '').toLowerCase()
    const effectiveMode = mode === 'auto' ? autoModeFor(ct) : mode
    const headers = sanitizeResponseHeaders(upstream.headers, { target, mirrorBase, mode: effectiveMode })
    const init = { status: upstream.status, statusText: upstream.statusText, headers }

    if (upstream.status >= 300 && upstream.status < 400) {
      return new Response(null, init)
    }

    if (effectiveMode === 'rewrite' && ct.includes('text/html')) {
      const rewritten = rewriteHTMLResponse(upstream, target, mirrorBase)
      const body = await rewritten.text()
      // 必须保留 content-length:Elysia 1.4.30 的 responseToSetHeaders 在无 content-length 走流分支时
      // 会丢弃全部响应头(只更新 set.headers 已有键),最终被默认 text/plain 覆盖导致浏览器不渲染
      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: new Headers({ ...Object.fromEntries(headers), 'content-length': String(new Blob([body]).size) }),
      })
    }
    if (effectiveMode === 'rewrite' && ct.includes('text/css')) {
      const css = await upstream.text()
      const body = rewriteCSSText(css, target, mirrorBase)
      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: new Headers({ ...Object.fromEntries(headers), 'content-length': String(new Blob([body]).size) }),
      })
    }
    // stream 模式:原样流式透传,零解析零拷贝,兼容大文件/下载/git 协议
    return new Response(upstream.body, init)
  })
