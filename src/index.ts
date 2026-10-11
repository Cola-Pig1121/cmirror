import { Elysia } from 'elysia'
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker'
import type { Env } from './env'
import { attachBindings, getEnv } from './runtime'
import { ApiError, OpenAIError, jsonError, openaiError, openaiTypeFromStatus } from './lib/errors'
import { isGitSmartPath } from './mirror/github'
import { markStart, logRequest } from './middleware/logger'
import { mirrorModule } from './mirror/route'
import { aiModule } from './ai/route'
import { adminModule } from './admin/route'

// 浏览器直接访问未鉴权镜像时的提示页(Listary 风,与主站一致)
const UNAUTHORIZED_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cmirror — 需要令牌</title><style>body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#fff;color:#1f2328;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{width:min(520px,92vw);border:1px solid #e3e6ea;border-radius:16px;box-shadow:0 6px 24px rgba(31,35,40,.06);padding:28px 32px}h1{font-size:18px;margin:0 0 10px}p{font-size:14px;color:#57606a;line-height:1.7;margin:6px 0}a{color:#24292f;font-weight:600}</style></head><body><div class="card"><h1>需要访问令牌</h1><p>镜像入口要求鉴权。先到设置页粘贴令牌(保存后浏览器会自动携带 Cookie),再重新打开本页面。</p><p><a href="/settings">前往设置 →</a>　<a href="/">← 返回首页</a></p></div></body></html>`

// Elysia 语义:生命周期钩子只作用于注册之后的路由,onError/onAfterResponse 必须在 use() 之前
export const app = new Elysia({ adapter: CloudflareAdapter, aot: false })
  .onRequest((c) => {
    markStart(c.request)
  })

  .onError(({ error, code, request }) => {
    // 动态 handler 路径下 root onError 先于插件局部 handler 生效,统一在此分流:
    // AI 网关路径(/v1/*、/ai/*)→ OpenAI 兼容错误体;其余 → 统一 JSON
    const path = new URL(request.url).pathname
    const isOpenAIPath = path === '/v1' || path.startsWith('/v1/') || path.startsWith('/ai/')
    if (error instanceof OpenAIError) return openaiError(error.status, error.type, error.code, error.message)
    if (isOpenAIPath && error instanceof ApiError) {
      return openaiError(error.status, openaiTypeFromStatus(error.status), error.code, error.message)
    }
    if (error instanceof ApiError) {
      // git 客户端要求 401 携带 Basic challenge 才会重发 URL 内凭据;仅限 smart HTTP 路径,
      // 普通镜像 401 不加(浏览器会弹登录框)
      if (error.status === 401 && new URL(request.url).pathname.startsWith('/m/')) {
        const targetPath = decodeURIComponent(new URL(request.url).pathname.slice(3).split('?')[0] ?? '')
        if (isGitSmartPath(targetPath)) {
          return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), {
            status: 401,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'www-authenticate': 'Basic realm="cmirror"',
            },
          })
        }
        // 浏览器导航到未鉴权的镜像页 → 友好提示页(而非裸 JSON)
        if ((request.headers.get('accept') ?? '').includes('text/html')) {
          return new Response(UNAUTHORIZED_HTML, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
        }
      }
      return jsonError(error.status, error.code, error.message)
    }
    if (code === 'NOT_FOUND') return jsonError(404, 'not_found', 'route not found')
    if (code === 'PARSE') return jsonError(400, 'bad_request', 'invalid request body')
    console.error('unhandled error:', error)
    return jsonError(500, 'internal', 'internal error')
  })

  .onAfterResponse((c) => {
    const res = c.response as Response
    logRequest(c.request, res?.status ?? 0)
  })

  .get('/health', () => Response.json({ status: 'ok', service: 'cmirror', ts: Date.now() }))

  .use(mirrorModule)
  .use(aiModule)
  .use(adminModule)

  // 未匹配的路径交给静态资源;ASSETS 未绑定时返回统一 404。
  // SPA 回退:浏览器导航到无实体文件的 HTML 路径(如 /settings)时返回 index.html,由前端路由接管。
  .all('*', async (c) => {
    const env = getEnv(c.request)
    if (!env.ASSETS) return jsonError(404, 'not_found', 'not found')
    const res = await env.ASSETS.fetch(c.request)
    if (res.status === 404 && (c.request.headers.get('accept') ?? '').includes('text/html')) {
      const idx = await env.ASSETS.fetch(new Request(new URL('/index.html', c.request.url).href))
      if (idx.status === 200) return idx
    }
    return res
  })

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    attachBindings(request, env, ctx)
    // 不调用 .compile():AOT/编译代码生成会触发 workerd 的 new Function 限制,动态路由即可
    return app.fetch(request)
  },
}
