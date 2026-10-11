import type { MirrorRule } from './rules'

/** 网关自有令牌等敏感头,绝不转发到上游 */
const DROP_REQUEST_HEADERS = [
  'authorization',
  'x-token',
  'cookie',
  'host',
  'origin',
  'referer',
  'connection',
  'keep-alive',
  'upgrade-insecure-requests',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'accept-encoding',
]

/**
 * 回源请求头清洗:去掉 cf-* / x-forwarded-*,改写 Origin/Referer 为目标站(或规则的 referer 覆盖)。
 * 注意:Workers fetch 禁止手工设置 Host(由目标 URL 推导),无需也无法改写。
 * Accept-Encoding 删除,回源一律拿未压缩内容(HTMLRewriter/流式透传都不能处理 gzip)。
 * sec-fetch-* 必须保留:GitHub 等站据此识别浏览器导航请求,缺失会把 HTML 降级为 text/plain;
 * 服务端跨源回源,sec-fetch-site 统一改写为 cross-site。
 */
export function sanitizeUpstreamHeaders(request: Request, target: URL, refererOverride?: string): Headers {
  const out = new Headers()
  for (const [k, v] of request.headers.entries()) {
    const lk = k.toLowerCase()
    if (DROP_REQUEST_HEADERS.includes(lk) || lk.startsWith('cf-') || lk.startsWith('x-forwarded-')) continue
    if (lk === 'sec-fetch-site') continue
    out.set(k, v)
  }
  out.set('sec-fetch-site', 'cross-site')
  if (refererOverride) {
    try {
      out.set('referer', refererOverride)
      out.set('origin', new URL(refererOverride).origin)
      return out
    } catch {
      /* 非法覆盖值退回目标站 */
    }
  }
  out.set('origin', target.origin)
  out.set('referer', target.origin + '/')
  return out
}

const DROP_RESPONSE_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'report-to',
  'expect-ct',
  'cf-ray',
  'cf-cache-status',
  'server',
  'via',
  'link',
  // 传输层头:若透传 transfer-encoding: chunked 且无 content-length,
  // Elysia 会走流处理分支并丢弃全部响应头(其 responseToSetHeaders 只更新已有键)
  'transfer-encoding',
  'connection',
  'keep-alive',
]

/**
 * 上游响应头清洗:移除 CSP/XFO 等限制头;改写 Location 与 Set-Cookie 使其指向镜像路径。
 */
export function sanitizeResponseHeaders(
  source: Headers,
  ctx: { target: URL; mirrorBase: string; mode: 'rewrite' | 'stream' },
): Headers {
  const out = new Headers()
  for (const [k, v] of source.entries()) {
    const lk = k.toLowerCase()
    if (DROP_RESPONSE_HEADERS.includes(lk)) continue
    if (lk === 'location') {
      const wrapped = wrapLocation(v, ctx.target, ctx.mirrorBase)
      if (wrapped) out.set('location', wrapped)
      continue
    }
    if (lk === 'set-cookie') {
      // 一律丢弃:目标站 cookie 改写后全部落在本域,会挤占浏览器 Cookie 配额并驱逐 cmirror_token;
      // v1 不支持登录站点,目标站 cookie 无实际用途。
      continue
    }
    out.set(k, v)
  }
  // 改写会改变正文长度
  if (ctx.mode === 'rewrite') out.delete('content-length')
  return out
}

export function wrapLocation(raw: string, target: URL, mirrorBase: string): string | null {
  if (!raw) return null
  if (raw.startsWith(mirrorBase)) return raw
  let abs: URL
  try {
    abs = new URL(raw, target.href)
  } catch {
    return null
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null
  return mirrorBase + abs.href
}
