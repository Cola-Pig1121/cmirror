import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { makeEnv, makeCtx, seedChannel, flushPromises } from './helpers'
import { sha256hex } from '../src/middleware/auth'
import type { Env } from '../src/env'

async function call(request: Request, env: Env, ctx: ExecutionContext) {
  return await worker.fetch(request, env, ctx)
}

function adminHeaders(extra: Record<string, string> = {}) {
  return { authorization: 'Bearer test-admin', ...extra }
}

type ErrorBody = { error: { code: string; type?: string; message?: string } }
function errBody(res: Response): Promise<ErrorBody> {
  return res.json() as Promise<ErrorBody>
}

afterEach(() => vi.unstubAllGlobals())

describe('M0: health & static', () => {
  it('GET /health returns 200 without auth', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const res = await call(new Request('https://cm.test/health'), env, ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'cmirror' })
  })

  it('unknown path without ASSETS → unified 404 json', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const res = await call(new Request('https://cm.test/nope'), env, ctx)
    expect(res.status).toBe(404)
    expect((await errBody(res)).error.code).toBeTruthy()
  })

  it('browser navigation to unauthenticated mirror → friendly HTML page; API → JSON', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const html = await call(
      new Request('https://cm.test/m/https://example.com/', { headers: { accept: 'text/html,application/xhtml+xml' } }),
      env,
      ctx,
    )
    expect(html.status).toBe(401)
    expect(html.headers.get('content-type')).toContain('text/html')
    const body = await html.text()
    expect(body).toContain('/settings')

    const api = await call(new Request('https://cm.test/m/https://example.com/', { headers: { accept: 'application/json' } }), env, ctx)
    expect(api.status).toBe(401)
    expect((await errBody(api)).error.code).toBe('unauthorized')
  })

  it('SPA fallback: /settings path serves index.html to browsers', async () => {
    const assets = {
      fetch: async (req: Request) =>
        new URL(req.url).pathname === '/index.html'
          ? new Response('<!doctype html><title>cmirror</title>', { status: 200, headers: { 'content-type': 'text/html' } })
          : new Response('404', { status: 404 }),
    }
    const { env } = makeEnv({ ASSETS: assets as never })
    const { ctx } = makeCtx()
    const res = await call(new Request('https://cm.test/settings', { headers: { accept: 'text/html' } }), env, ctx)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('cmirror')
    // 非浏览器请求仍 404
    const api = await call(new Request('https://cm.test/settings', { headers: { accept: 'application/json' } }), env, ctx)
    expect(api.status).toBe(404)
  })
})

describe('M1: auth / quota / ratelimit', () => {
  it('protected endpoints reject missing token', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const res = await call(new Request('https://cm.test/m/https://example.com/'), env, ctx)
    expect(res.status).toBe(401)
    expect((await errBody(res)).error.code).toBe('unauthorized')

    const res2 = await call(new Request('https://cm.test/m/https://pypi.org/'), env, ctx)
    expect(res2.status).toBe(401)

    const res3 = await call(new Request('https://cm.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"x","messages":[]}' }), env, ctx)
    expect(res3.status).toBe(401)
    // AI 模块内为 OpenAI 兼容错误体
    const body = (await res3.json()) as { error: { type?: string; message?: string } }
    expect(body.error.type).toBe('authentication_error')
  })

  it('x-token header works', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    vi.stubGlobal('fetch', async () => new Response('ok', { status: 200 }))
    const res = await call(new Request('https://cm.test/m/https://example.com/', { headers: { 'x-token': 'test-admin' } }), env, ctx)
    expect(res.status).toBe(200)
  })

  it('issued token honors scopes and expires', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    // 管理员签发 mirror-only 令牌
    const createRes = await call(
      new Request('https://cm.test/admin/tokens', {
        method: 'POST',
        headers: adminHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ name: 's1', scopes: ['mirror'] }),
      }),
      env,
      ctx,
    )
    expect(createRes.status).toBe(201)
    const { token, record } = (await createRes.json()) as { token: string; record: { id: string } }
    expect(token.length).toBeGreaterThan(20)
    // 明文令牌不入库
    const kvRaw = (env.KV as unknown as { store: Map<string, string> }).store
    expect([...kvRaw.values()].some((v) => v.includes(token))).toBe(false)
    expect(record.id).toBeTruthy()

    vi.stubGlobal('fetch', async () => new Response('ok', { status: 200 }))
    const okRes = await call(new Request('https://cm.test/m/https://example.com/', { headers: { authorization: `Bearer ${token}` } }), env, ctx)
    expect(okRes.status).toBe(200)

    const forbidden = await call(
      new Request('https://cm.test/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"model":"x","messages":[]}' }),
      env,
      ctx,
    )
    expect(forbidden.status).toBe(403)

    // 过期令牌被拒
    const expired = 'expired-token-xyz'
    const kv = (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put.bind(env.KV)
    await kv('token:' + (await sha256hex(expired)), JSON.stringify({ id: 'e', name: 'e', scopes: ['mirror'], expiresAt: Date.now() - 1000, createdAt: 0 }))
    const expRes = await call(new Request('https://cm.test/m/https://example.com/', { headers: { authorization: `Bearer ${expired}` } }), env, ctx)
    expect(expRes.status).toBe(401)
  })

  it('ratelimit: 2nd request beyond rpm is 429', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const raw = 'rl-token-1'
    await (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      'token:' + (await sha256hex(raw)),
      JSON.stringify({ id: 'rl', name: 'rl', scopes: ['mirror'], rpm: 1, createdAt: 0 }),
    )
    vi.stubGlobal('fetch', async () => new Response('ok', { status: 200 }))
    const headers = { authorization: `Bearer ${raw}` }
    const r1 = await call(new Request('https://cm.test/m/https://example.com/', { headers }), env, ctx)
    expect(r1.status).toBe(200)
    const r2 = await call(new Request('https://cm.test/m/https://example.com/', { headers }), env, ctx)
    expect(r2.status).toBe(429)
    expect((await errBody(r2)).error.code).toBe('rate_limited')
  })

  it('request quota exhausted → 402', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const raw = 'q-token'
    const key = 'token:' + (await sha256hex(raw))
    await (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(key, JSON.stringify({ id: 'q', name: 'q', scopes: ['mirror'], maxRequests: 1, usedRequests: 1, createdAt: 0 }))
    const res = await call(new Request('https://cm.test/m/https://example.com/', { headers: { authorization: `Bearer ${raw}` } }), env, ctx)
    expect(res.status).toBe(402)
  })

  it('analytics data point recorded after response', async () => {
    const { env, datapoints } = makeEnv()
    const { ctx } = makeCtx()
    await call(new Request('https://cm.test/health'), env, ctx)
    // afterResponse 走 setImmediate/microtask,冲刷一次
    await new Promise((r) => setTimeout(r, 10))
    expect(datapoints.length).toBeGreaterThan(0)
  })
})

describe('M2/M3: mirror', () => {
  it('streams allowed hosts, strips gateway auth, keeps query', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const seen: { url: string; auth?: string | null; referer?: string | null }[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {})
      seen.push({ url: String(url), auth: h.get('authorization'), referer: h.get('referer') })
      return new Response('hello-raw', { status: 200, headers: { 'content-type': 'text/plain', server: 'GitHub.com', 'cf-ray': 'x' } })
    })
    const res = await call(
      new Request('https://cm.test/m/https://raw.githubusercontent.com/u/r/main/file.txt?x=1', { headers: adminHeaders() }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello-raw')
    expect(seen[0]!.url).toBe('https://raw.githubusercontent.com/u/r/main/file.txt?x=1')
    expect(seen[0]!.auth).toBeNull()
    expect(seen[0]!.referer).toBe('https://raw.githubusercontent.com/')
    expect(res.headers.get('server')).toBeNull()
    expect(res.headers.get('cf-ray')).toBeNull()
  })

  it('percent-encoded target form works', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://raw.githubusercontent.com/u/r/a%20b')
      return new Response('x', { status: 200 })
    })
    const res = await call(
      new Request('https://cm.test/m/https%3A%2F%2Fraw.githubusercontent.com%2Fu%2Fr%2Fa%20b', { headers: adminHeaders() }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
  })

  it('temporary proxy: any public host allowed, SSRF targets rejected with 400', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://anyone.example.org/page')
      return new Response('temp', { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    const ok = await call(new Request('https://cm.test/m/https://anyone.example.org/page', { headers: adminHeaders() }), env, ctx)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('temp')

    for (const target of ['https://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:6379/', 'ftp://8.8.8.8/', 'http://10.0.0.5/', 'http://0x7f000001/']) {
      const res = await call(new Request('https://cm.test/m/' + target, { headers: adminHeaders() }), env, ctx)
      expect(res.status).toBe(400)
      expect((await errBody(res)).error.code).toBe('invalid_target')
    }
  })

  it('rewrites redirect Location into mirror path', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    vi.stubGlobal('fetch', async () =>
      new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/file.bin' } }),
    )
    const res = await call(new Request('https://cm.test/m/https://github.com/u/r/releases/download/v1/a.zip', { headers: adminHeaders() }), env, ctx)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cm.test/m/https://objects.githubusercontent.com/file.bin')
  })

  it('custom rules apply mode/referer; unregistered hosts still proxied (temporary)', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    await (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      'mirror:rules',
      JSON.stringify([{ host: 'limited.example', mode: 'stream', maxBytes: 10 }]),
    )
    const seen: { url: string; referer: string | null }[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {})
      seen.push({ url: String(url), referer: h.get('referer') })
      return new Response('big-body', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '100' } })
    })
    // 登记站点命中规则:maxBytes 限制生效
    const limited = await call(new Request('https://cm.test/m/https://limited.example/f', { headers: adminHeaders() }), env, ctx)
    expect(limited.status).toBe(413)
    // 未登记站点:临时代理照常工作
    const temp = await call(new Request('https://cm.test/m/https://raw.githubusercontent.com/a/b', { headers: adminHeaders() }), env, ctx)
    expect(temp.status).toBe(200)
  })

  it('mode segment: /m/stream/ forces passthrough even for HTML', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const html = '<!doctype html><html><head><title>t</title></head><body><a href="/x">x</a></body></html>'
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://anyone.example.org/page')
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const res = await call(new Request('https://cm.test/m/stream/https://anyone.example.org/page', { headers: adminHeaders() }), env, ctx)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toBe(html) // 原样透传:无注入、无改写
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('mode segment: git smart path stays stream even under /m/rewrite/', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://github.com/u/r.git/info/refs?service=git-upload-pack')
      return new Response('001e# service=git-upload-pack\n', {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      })
    })
    const res = await call(new Request('https://cm.test/m/rewrite/https://github.com/u/r.git/info/refs?service=git-upload-pack', { headers: adminHeaders() }), env, ctx)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('001e# service=git-upload-pack\n')
  })

  it('custom rule referer override reaches upstream', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    await (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      'mirror:rules',
      JSON.stringify([{ host: 'i.pximg.net', mode: 'stream', referer: 'https://www.pixiv.net/' }]),
    )
    let referer: string | null = null
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      referer = new Headers(init?.headers ?? {}).get('referer')
      return new Response('img', { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const res = await call(new Request('https://cm.test/m/https://i.pximg.net/img-master/a.png', { headers: adminHeaders() }), env, ctx)
    expect(res.status).toBe(200)
    expect(referer).toBe('https://www.pixiv.net/')
  })

  it('git clone smart HTTP works with Basic auth (token in password slot)', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    await (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      'token:' + (await sha256hex('git-token-1')),
      JSON.stringify({ id: 'g1', name: 'g1', scopes: ['mirror'], createdAt: 0 }),
    )
    const seen: { url: string; auth: string | null; body: string }[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {})
      let bodyText = ''
      if (typeof init?.body === 'string') bodyText = init.body
      else if (init?.body instanceof ReadableStream) {
        const reader = (init.body as ReadableStream<Uint8Array>).getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bodyText += new TextDecoder().decode(value)
        }
      }
      seen.push({ url: String(url), auth: h.get('authorization'), body: bodyText })
      return new Response('001e# service=git-upload-pack\n', {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      })
    })
    const basic = 'Basic ' + btoa('cmirror:git-token-1')
    // 0) 无凭据访问 smart HTTP 路径 → 401 带 Basic challenge(git 重发凭据的前提)
    const noAuth = await call(
      new Request('https://cm.test/m/https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack'),
      env,
      ctx,
    )
    expect(noAuth.status).toBe(401)
    expect(noAuth.headers.get('www-authenticate')).toBe('Basic realm="cmirror"')
    // 普通镜像路径 401 不带 challenge(避免浏览器弹登录框)
    const noAuthPlain = await call(new Request('https://cm.test/m/https://raw.githubusercontent.com/a/b'), env, ctx)
    expect(noAuthPlain.status).toBe(401)
    expect(noAuthPlain.headers.get('www-authenticate')).toBeNull()
    // 1) GET info/refs?service=git-upload-pack
    const refs = await call(
      new Request('https://cm.test/m/https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack', { headers: { authorization: basic } }),
      env,
      ctx,
    )
    expect(refs.status).toBe(200)
    expect(refs.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement')
    // 2) POST git-upload-pack(octet-stream body 透传,网关 token 不外泄上游)
    const pack = await call(
      new Request('https://cm.test/m/https://github.com/octocat/Hello-World.git/git-upload-pack', {
        method: 'POST',
        headers: { authorization: basic, 'content-type': 'application/x-git-upload-pack-request' },
        body: '0057want abc...',
      }),
      env,
      ctx,
    )
    expect(pack.status).toBe(200)
    expect(seen[0]!.url).toBe('https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack')
    expect(seen[1]!.url).toBe('https://github.com/octocat/Hello-World.git/git-upload-pack')
    expect(seen[0]!.auth).toBeNull()
    expect(seen[1]!.auth).toBeNull()
    expect(seen[1]!.body).toBe('0057want abc...')
  })
})

describe('M4: AI gateway mode A (passthrough)', () => {
  const UPSTREAM_TEST_KEY = 'up-test-key-1'
  it('swaps gateway token for upstream key and streams through', async () => {
    const { env } = makeEnv({ OPENAI_API_KEY: UPSTREAM_TEST_KEY })
    const { ctx } = makeCtx()
    const seen: { url: string; auth: string | null }[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers as Record<string, string> | undefined)
      seen.push({ url: String(url), auth: h.get('authorization') })
      return new Response(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'hi' } }] }), { headers: { 'content-type': 'application/json' } })
    })
    const res = await call(
      new Request('https://cm.test/ai/openai/v1/chat/completions', {
        method: 'POST',
        headers: adminHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(seen[0]!.auth).toBe(`Bearer ${UPSTREAM_TEST_KEY}`)
    const json = (await res.json()) as { choices: unknown[] }
    expect(json.choices).toHaveLength(1)
  })

  it('unknown provider → openai-format 404', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const res = await call(
      new Request('https://cm.test/ai/nope/v1/chat/completions', { method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }), body: '{}' }),
      env,
      ctx,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { type: string; code: string } }
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.code).toBe('provider_not_found')
  })
})

describe('M5: AI gateway mode B (openai unified)', () => {
  async function setup() {
    const { env, datapoints } = makeEnv()
    const { ctx, promises } = makeCtx()
    await seedChannel(env.KV as never, { id: 'a1', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', keys: ['ant-1'], models: ['claude-test'], weight: 1, enabled: true })
    const raw = 'ai-token-1'
    const hash = await sha256hex(raw)
    await (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put('token:' + hash, JSON.stringify({ id: 'u1', name: 'u1', scopes: ['ai'], createdAt: 0 }))
    return { env, ctx, promises, datapoints, headers: { authorization: `Bearer ${raw}` } }
  }

  it('chat completion via anthropic channel, converts response & debits usage', async () => {
    const { env, ctx, promises, headers } = await setup()
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages')
      const h = new Headers(init?.headers as Record<string, string> | undefined)
      expect(h.get('x-api-key')).toBe('ant-1')
      const sentBody = JSON.parse(String(init!.body)) as { messages: { role: string }[]; system?: string }
      expect(sentBody.messages[0]!.role).toBe('user')
      return new Response(
        JSON.stringify({ id: 'msg_1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'converted' }], usage: { input_tokens: 10, output_tokens: 20 } }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const res = await call(
      new Request('https://cm.test/v1/chat/completions', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(json.choices[0]!.message.content).toBe('converted')
    await flushPromises(promises)
    const hash = await sha256hex('ai-token-1')
    const rec = JSON.parse((env.KV as unknown as { store: Map<string, string> }).store.get('token:' + hash)!)
    expect(rec.usedRequests).toBe(1)
    expect(rec.usedTokens).toBe(30)
  })

  it('stream mode returns openai SSE chunks', async () => {
    const { env, ctx, headers } = await setup()
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hey"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    vi.stubGlobal('fetch', async () => new Response(new Blob([sse]).stream(), { headers: { 'content-type': 'text/event-stream' } }))
    const res = await call(
      new Request('https://cm.test/v1/chat/completions', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-test', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      }),
      env,
      ctx,
    )
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"content":"Hey"')
    expect(text).toContain('data: [DONE]')
  })

  it('token model restriction enforced', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const raw = 'restricted-1'
    await (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put('token:' + (await sha256hex(raw)), JSON.stringify({ id: 'u2', name: 'u2', scopes: ['ai'], models: ['allowed-model'], createdAt: 0 }))
    const res = await call(
      new Request('https://cm.test/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'other-model', messages: [] }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('model_not_allowed')
  })

  it('validates request body', async () => {
    const { env, ctx, headers } = await setup()
    const noModel = await call(new Request('https://cm.test/v1/chat/completions', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) }), env, ctx)
    expect(noModel.status).toBe(400)
    const badMessages = await call(new Request('https://cm.test/v1/chat/completions', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', messages: 'nope' }) }), env, ctx)
    expect(badMessages.status).toBe(400)
  })

  it('GET /v1/models lists channel models and aliases', async () => {
    const { env, ctx, headers } = await setup()
    await (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put('alias:fast', JSON.stringify({ model: 'claude-test' }))
    const res = await call(new Request('https://cm.test/v1/models', { headers }), env, ctx)
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((d) => d.id)
    expect(ids).toContain('claude-test')
    expect(ids).toContain('fast')
  })

  it('embeddings via openai-compatible channel', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    await seedChannel(env.KV as never, { id: 'o1', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', keys: ['dk'], models: ['embed-x'], weight: 1, enabled: true })
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://api.deepseek.com/v1/embeddings')
      return new Response(JSON.stringify({ object: 'list', data: [{ index: 0, object: 'embedding', embedding: [0.1, 0.2] }] }), { headers: { 'content-type': 'application/json' } })
    })
    const res = await call(
      new Request('https://cm.test/v1/embeddings', {
        method: 'POST',
        headers: adminHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ model: 'embed-x', input: 'hello' }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { embedding: number[] }[] }
    expect(json.data[0]!.embedding).toEqual([0.1, 0.2])
  })
})

describe('M1: admin', () => {
  it('non-admin token cannot access admin routes', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const raw = 'plain-user'
    await (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put('token:' + (await sha256hex(raw)), JSON.stringify({ id: 'p', name: 'p', scopes: ['mirror'], createdAt: 0 }))
    const res = await call(new Request('https://cm.test/admin/tokens', { headers: { authorization: `Bearer ${raw}` } }), env, ctx)
    expect(res.status).toBe(403)
  })

  it('channels CRUD', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const ch = { provider: 'openai', baseUrl: 'https://api.openai.com', keys: ['sk-1'], models: ['gpt-4o'], weight: 5, enabled: true }
    const put = await call(new Request('https://cm.test/admin/channels/prod', { method: 'PUT', headers: adminHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(ch) }), env, ctx)
    expect(put.status).toBe(200)
    const list = await call(new Request('https://cm.test/admin/channels', { headers: adminHeaders() }), env, ctx)
    const body = (await list.json()) as { user: { id: string }[] }
    expect(body.user.map((c) => c.id)).toContain('prod')
    const del = await call(new Request('https://cm.test/admin/channels/prod', { method: 'DELETE', headers: adminHeaders() }), env, ctx)
    expect(del.status).toBe(200)
    const list2 = await call(new Request('https://cm.test/admin/channels', { headers: adminHeaders() }), env, ctx)
    expect(((await list2.json()) as { user: unknown[] }).user).toHaveLength(0)
  })

  it('rejects unsafe channel & rules', async () => {
    const { env } = makeEnv()
    const { ctx } = makeCtx()
    const badCh = await call(new Request('https://cm.test/admin/channels/x', { method: 'PUT', headers: adminHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ provider: 'openai', baseUrl: 'https://api.openai.com', models: [], enabled: true }) }), env, ctx)
    expect(badCh.status).toBe(400)
    const badRules = await call(new Request('https://cm.test/admin/mirror-rules', { method: 'PUT', headers: adminHeaders({ 'content-type': 'application/json' }), body: JSON.stringify([{ host: '169.254.169.254', mode: 'stream' }]) }), env, ctx)
    expect(badRules.status).toBe(400)
    expect((await errBody(badRules)).error.code).toBe('bad_rules')
  })
})
